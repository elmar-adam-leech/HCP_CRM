/**
 * Task #678 — HCP webhook restart resilience & auto-backfill.
 *
 * When the webhook health checker detects that a tenant has gone silent
 * (no events received for >24h) AND the HCP REST API is still reachable,
 * we proactively re-sync recent estimates / jobs through the same
 * `processHcpEvent` pipeline that webhook deliveries use. The dispatch
 * handlers are already idempotent (every entity is upserted by its HCP
 * id), so feeding the same payload through `*.updated` events is safe and
 * causes no duplicates.
 *
 * Customer events are intentionally skipped here: the HCP customers list
 * endpoint does not expose `modified_since`, and customer rows are touched
 * as a side-effect of estimate / job processing anyway.
 */
import { housecallProService } from "../hcp/index";
import { processHcpEvent } from "../routes/webhooks/housecall-pro/dispatch";
import { storage } from "../storage";
import { logger } from "../utils/logger";

const log = logger('HcpBackfill');

// Cap how far back we look so that a tenant that has been silent for weeks
// does not trigger a giant fetch. 7 days matches the typical webhook retry
// horizon — anything older that you missed should be picked up by the next
// regularly scheduled HCP sync, not by an outage backfill.
const MAX_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

// Pagination knobs. We fetch up to MAX_PAGES * PAGE_SIZE records per entity
// per backfill so a single outage cannot consume unbounded HCP API quota.
// At 100/page * 25 pages = 2,500 records per entity, which comfortably covers
// any real outage we have seen in production.
const PAGE_SIZE = 100;
const MAX_PAGES = 25;

export interface HcpBackfillSummary {
  estimates: number;
  estimatesCreated: number;
  jobs: number;
  jobsCreated: number;
  errors: string[];
  since: string;
  truncated: boolean;
  /**
   * Oldest `updated_at` observed across every estimate/job page actually
   * processed by this backfill. Null when nothing was fetched (or none of
   * the returned items carried `updated_at`). Surfaces as the "Fetched
   * through" timestamp in the HCP settings card so admins can confirm a
   * manual resync actually walked back as far as their configured sync
   * start date.
   */
  fetchedThroughAt: string | null;
}

type Pageable<T> = (page: number) => Promise<{ ok: true; items: T[] } | { ok: false; error: string }>;

interface BackfillCounts {
  total: number;
  created: number;
}

/**
 * Trigger source for a backfill run.
 *   - 'webhook-recovery': the periodic / startup health checker noticed a
 *     silent webhook and is replaying the last 7 days as a safety net.
 *     Clamped to MAX_LOOKBACK_MS so a long-disabled webhook cannot DoS the
 *     HCP API.
 *   - 'manual': a contractor admin clicked "Resync now". Honors the
 *     contractor's configured `housecallProSyncStartDate` exactly (no
 *     clamp) so they can pull anything back to that date.
 *
 * Defaults to 'webhook-recovery' so existing callers (and tests that mock
 * this function) keep their current behaviour.
 */
export type HcpBackfillTrigger = 'manual' | 'webhook-recovery';

/**
 * Iterate pages of an HCP REST endpoint and replay each item through the
 * webhook dispatch pipeline. For each item we first look up whether a local
 * row already exists (by HCP id) — this lets us emit `*.created` for new
 * entities and `*.updated` for existing ones, which matches the dispatch
 * handlers' shape (the `*.updated` handlers intentionally no-op when no
 * local row exists, so we'd silently drop new entities created during the
 * outage if we always emitted `*.updated`).
 */
async function paginateAndReplay<T extends { id?: string; updated_at?: string }>(
  entityName: 'estimate' | 'job',
  fetcher: Pageable<T>,
  contractorId: string,
  existsLocally: (hcpId: string) => Promise<boolean>,
  replay: (item: T, eventType: string) => Promise<void>,
  summary: HcpBackfillSummary,
): Promise<BackfillCounts> {
  let total = 0;
  let created = 0;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const result = await fetcher(page);
    if (!result.ok) {
      const msg = `${entityName}s page ${page} fetch failed: ${result.error}`;
      log.warn(`[backfill] contractor=${contractorId} ${msg}`);
      summary.errors.push(msg);
      break;
    }
    if (result.items.length === 0) break;
    for (const item of result.items) {
      const hcpId = item?.id;
      if (!hcpId) {
        const msg = `${entityName} replay skipped: missing HCP id`;
        log.warn(`[backfill] contractor=${contractorId} ${msg}`);
        summary.errors.push(msg);
        continue;
      }
      // Track the oldest `updated_at` we've actually fetched (across both
      // entity types). The HCP listing is sorted `updated_at desc`, so the
      // oldest item is the last one on the deepest page we reached — but
      // we observe every item to stay correct if HCP ever returns out of
      // order. Skipped items (no id) don't count; failed-replay items DO
      // count because we did successfully pull them from HCP.
      const itemUpdatedAt = item?.updated_at;
      if (itemUpdatedAt) {
        const prev = summary.fetchedThroughAt;
        if (!prev || itemUpdatedAt < prev) {
          summary.fetchedThroughAt = itemUpdatedAt;
        }
      }
      try {
        const exists = await existsLocally(hcpId);
        const eventType = exists ? `${entityName}.updated` : `${entityName}.created`;
        await replay(item, eventType);
        total += 1;
        if (!exists) created += 1;
      } catch (err) {
        const msg = `${entityName} ${hcpId} replay failed: ${err instanceof Error ? err.message : String(err)}`;
        log.warn(`[backfill] contractor=${contractorId} ${msg}`);
        summary.errors.push(msg);
      }
    }
    // If we got a partial page, the API has no more results for us.
    if (result.items.length < PAGE_SIZE) break;
    // Only mark truncated when we hit MAX_PAGES AND the final page was
    // FULL (i.e. there is almost certainly more data we did not fetch).
    // A partial page at MAX_PAGES would have already broken out above,
    // meaning we got everything — not truncated.
    if (page === MAX_PAGES) {
      summary.truncated = true;
      log.warn(`[backfill] contractor=${contractorId} ${entityName}s hit MAX_PAGES (${MAX_PAGES}) — backfill truncated`);
    }
  }
  return { total, created };
}

export async function runHcpWebhookBackfill(
  contractorId: string,
  since: Date | null,
  trigger: HcpBackfillTrigger = 'webhook-recovery',
): Promise<HcpBackfillSummary> {
  const now = Date.now();
  // Task #748: split the lookback policy by trigger source.
  //   - 'webhook-recovery' keeps the original 7-day clamp so a long-silent
  //     webhook cannot trigger an unbounded fetch.
  //   - 'manual' honors the caller's `since` exactly (the manual entry
  //     point feeds in the contractor's configured sync-start date), with
  //     a permissive lower bound so a missing/unknown `since` still walks
  //     all the way back rather than getting silently clamped to 7 days.
  let effectiveSince: Date;
  if (trigger === 'manual') {
    // Epoch is fine as the floor: HCP's `modified_since` accepts any ISO
    // timestamp and MAX_PAGES * PAGE_SIZE still caps the per-run cost.
    effectiveSince = since ?? new Date(0);
  } else {
    const lowerBound = new Date(now - MAX_LOOKBACK_MS);
    effectiveSince = !since || since.getTime() < lowerBound.getTime()
      ? lowerBound
      : since;
  }
  const sinceIso = effectiveSince.toISOString();

  log.info(`[backfill] contractor=${contractorId} trigger=${trigger} fetching estimates+jobs modified_since=${sinceIso}`);

  const summary: HcpBackfillSummary = {
    estimates: 0,
    estimatesCreated: 0,
    jobs: 0,
    jobsCreated: 0,
    errors: [],
    since: sinceIso,
    truncated: false,
    fetchedThroughAt: null,
  };

  // ----- Estimates -----
  try {
    const counts = await paginateAndReplay(
      'estimate',
      async (page) => {
        const resp = await housecallProService.getEstimates(contractorId, {
          modified_since: sinceIso,
          page_size: PAGE_SIZE,
          page,
          sort_by: 'updated_at',
          sort_direction: 'desc',
        });
        if (!resp.success || !resp.data) {
          return { ok: false, error: resp.error ?? 'unknown' };
        }
        return { ok: true, items: resp.data };
      },
      contractorId,
      async (hcpId) => Boolean(await storage.getEstimateByHousecallProEstimateId(hcpId, contractorId)),
      // Idempotent — `processHcpEvent` upserts by HCP id. No webhookEventId
      // because there is no webhook_events row to mark processed; dispatch
      // handles undefined gracefully.
      (estimate, eventType) => processHcpEvent(contractorId, eventType, estimate, undefined, undefined),
      summary,
    );
    summary.estimates = counts.total;
    summary.estimatesCreated = counts.created;
  } catch (err) {
    const msg = `estimates fetch threw: ${err instanceof Error ? err.message : String(err)}`;
    log.error(`[backfill] contractor=${contractorId} ${msg}`);
    summary.errors.push(msg);
  }

  // ----- Jobs -----
  try {
    const counts = await paginateAndReplay(
      'job',
      async (page) => {
        const resp = await housecallProService.getJobs(contractorId, {
          modified_since: sinceIso,
          page_size: PAGE_SIZE,
          page,
          sort_by: 'updated_at',
          sort_direction: 'desc',
        });
        if (!resp.success || !resp.data) {
          return { ok: false, error: resp.error ?? 'unknown' };
        }
        return { ok: true, items: resp.data };
      },
      contractorId,
      async (hcpId) => Boolean(await storage.getJobByHousecallProJobId(hcpId, contractorId)),
      (job, eventType) => processHcpEvent(contractorId, eventType, job, undefined, undefined),
      summary,
    );
    summary.jobs = counts.total;
    summary.jobsCreated = counts.created;
  } catch (err) {
    const msg = `jobs fetch threw: ${err instanceof Error ? err.message : String(err)}`;
    log.error(`[backfill] contractor=${contractorId} ${msg}`);
    summary.errors.push(msg);
  }

  log.info(`[backfill] contractor=${contractorId} done — estimates=${summary.estimates} (${summary.estimatesCreated} new) jobs=${summary.jobs} (${summary.jobsCreated} new) errors=${summary.errors.length} truncated=${summary.truncated}`);
  return summary;
}

export function summarizeBackfill(summary: HcpBackfillSummary): string {
  const estimatesPart = summary.estimatesCreated > 0
    ? `${summary.estimates} estimate(s), ${summary.estimatesCreated} new`
    : `${summary.estimates} estimate(s)`;
  const jobsPart = summary.jobsCreated > 0
    ? `${summary.jobs} job(s), ${summary.jobsCreated} new`
    : `${summary.jobs} job(s)`;
  const parts = [estimatesPart, jobsPart];
  if (summary.errors.length > 0) {
    parts.push(`${summary.errors.length} error(s)`);
  }
  const truncatedNote = summary.truncated ? ', truncated at limit' : '';
  const throughNote = summary.fetchedThroughAt ? `, through ${summary.fetchedThroughAt}` : '';
  return parts.join(', ') + ` (since ${summary.since}${throughNote}${truncatedNote})`;
}
