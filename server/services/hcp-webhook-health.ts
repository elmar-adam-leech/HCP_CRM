import { db } from "../db";
import { webhookEvents, contractorIntegrations, webhookIncidents } from "@shared/schema";
import { eq, and, desc, sql, gte, ne, isNull } from "drizzle-orm";
import { storage } from "../storage";
import { broadcastToContractor } from "../websocket";
import { housecallProService } from "../hcp/index";
import { hcpWebhookSubscriptionsService, type HcpWebhookSubscription } from "../hcp/webhook-subscriptions";
import { logger } from "../utils/logger";
import { formatDbError } from "../utils/db-error";
import { runHcpWebhookBackfill, summarizeBackfill } from "../sync/hcp-backfill";
import { sendHcpIncidentEmail } from "./hcp-incident-email";
import {
  notifyWebhookIncidentOpened,
  ALERT_THROTTLE_WINDOW_MS as SHARED_ALERT_THROTTLE_WINDOW_MS,
} from "./webhook-incident-notifier";

const log = logger('HcpWebhookHealth');

const WARNING_THRESHOLD_MS = 24 * 60 * 60 * 1000;
const DISABLED_THRESHOLD_MS = 25 * 60 * 60 * 1000;
const CHECK_INTERVAL_MS = 5 * 60 * 1000;

const REJECTION_SPIKE_WINDOW_MS = 10 * 60 * 1000;
const REJECTION_SPIKE_COUNT = 10;

// Hard ceiling on a single per-contractor health check. The DB queries are
// each expected to run in well under a second after the composite index
// from migration 0034; if the whole tick takes longer than this we assume
// the DB or pool is unhealthy and surface that as a `health-check-failure`
// incident instead of letting the timer silently hang for the next tick.
const HEALTH_CHECK_TIMEOUT_MS = 30_000;

// Subscription probe is rate-limited to once per hour per contractor — the
// HCP API is not free and the listing rarely changes.
const SUBSCRIPTION_PROBE_INTERVAL_MS = 60 * 60 * 1000;
const lastSubscriptionProbeAt = new Map<string, number>();

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let serverStartedAt: Date = new Date();

const INTEGRATIONS_FETCH_LIMIT = 100;

const SERVICE_HCP = 'housecall-pro';
const KIND_STALENESS = 'staleness';
const KIND_REJECTION = 'rejection';
const KIND_HEALTH_CHECK_FAILURE = 'health-check-failure';
const KIND_SUBSCRIPTION_MISSING = 'subscription-missing';

// Task #710 — per-(contractor, service, kind) cooldown for incident paging.
// Single source of truth lives in the shared notifier; re-exported here
// to preserve the public surface that existing tests + callers expect.
export const ALERT_THROTTLE_WINDOW_MS = SHARED_ALERT_THROTTLE_WINDOW_MS;


/**
 * Runs `op` with a hard timeout. Used to defend against the DB connection
 * pool getting wedged: a `pg` query with no responsive backend will hang
 * forever on the connection-acquire path, and the interval-driven health
 * checker would silently stop firing. Wrapping the per-contractor check in
 * `Promise.race(timeout)` lets us escalate that to a visible incident.
 *
 * NOTE: This DOES NOT actually cancel the underlying query — it just frees
 * the surrounding control flow. The query will eventually settle (or the
 * connection will be torn down by the pool's idleTimeout).
 */
async function withTimeout<T>(op: () => Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([op(), timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function getServerStartedAt(): Date {
  return serverStartedAt;
}

// ---------- Persistent incident helpers ----------
//
// Replaces the old in-memory `activeIncidents` map. Now any open incident
// survives a server restart, so the "HCP Webhooks May Be Disabled"
// notification fires exactly once per outage even if the host crashes /
// rolls during the silence window.

async function getOpenIncident(contractorId: string, kind: string) {
  const rows = await db.select()
    .from(webhookIncidents)
    .where(and(
      eq(webhookIncidents.contractorId, contractorId),
      eq(webhookIncidents.service, SERVICE_HCP),
      eq(webhookIncidents.kind, kind),
      isNull(webhookIncidents.closedAt),
    ))
    .limit(1);
  return rows[0];
}

/**
 * Atomically open an incident or no-op if one is already open.
 *
 * Relies on the unique partial index `webhook_incidents_unique_open_idx`
 * (only one OPEN row per contractor+service+kind). If two health-check
 * ticks race, only one INSERT will succeed and the other returns no rows
 * — we then re-fetch the existing open row so callers always get back a
 * valid incident reference.
 *
 * Returns `{ incident, created }` so the caller can decide whether to
 * notify and backfill (only on `created === true`).
 */
async function openIncidentAtomic(contractorId: string, kind: string): Promise<{
  incident: typeof webhookIncidents.$inferSelect;
  created: boolean;
}> {
  const inserted = await db.insert(webhookIncidents).values({
    contractorId,
    service: SERVICE_HCP,
    kind,
  })
    .onConflictDoNothing()
    .returning();
  if (inserted[0]) {
    return { incident: inserted[0], created: true };
  }
  // Conflict — another tick won the race. Re-fetch the existing open row.
  const existing = await getOpenIncident(contractorId, kind);
  if (!existing) {
    // Pathological: insert returned nothing but no open row exists. Could
    // only happen if another tick closed the incident between the INSERT
    // and the SELECT. Treat as "not created"; caller will skip notify.
    throw new Error(`openIncidentAtomic: insert conflicted but no open incident found for ${contractorId}/${kind}`);
  }
  return { incident: existing, created: false };
}

async function closeOpenIncident(contractorId: string, kind: string): Promise<void> {
  await db.update(webhookIncidents)
    .set({ closedAt: new Date() })
    .where(and(
      eq(webhookIncidents.contractorId, contractorId),
      eq(webhookIncidents.service, SERVICE_HCP),
      eq(webhookIncidents.kind, kind),
      isNull(webhookIncidents.closedAt),
    ));
  // Note: we deliberately do NOT clear the alert throttle here. The 24h
  // cooldown enforces the "at most one alert every 24 hours" guarantee
  // unconditionally — including across open/close cycles inside the
  // window (the flap pattern). The next genuine outage AFTER the window
  // expires pages immediately via natural cooldown expiry; we do not try
  // to detect "clean resolution" inside the window because there is no
  // reliable signal that distinguishes a quiet flap interval from a true
  // recovery (the underlying outage source — DB pool flap, webhook
  // disable — is exactly the kind of failure that recovers and re-trips).
}

async function markIncidentBackfill(
  incidentId: string,
  summary: string,
  fetchedThroughAt: Date | null = null,
): Promise<void> {
  await db.update(webhookIncidents)
    .set({
      backfillAttemptedAt: new Date(),
      backfillSummary: summary,
      // Always overwrite (including with null on failure) so a later
      // failure does not show a stale "fetched through" from a prior
      // success on the same incident row.
      backfillFetchedThroughAt: fetchedThroughAt,
    })
    .where(eq(webhookIncidents.id, incidentId));
}

async function getLastSuccessfulEventAt(contractorId: string): Promise<Date | null> {
  const latestEventResult = await db.select({ createdAt: webhookEvents.createdAt })
    .from(webhookEvents)
    .where(and(
      eq(webhookEvents.contractorId, contractorId),
      eq(webhookEvents.service, SERVICE_HCP),
      ne(webhookEvents.eventType, 'rejection'),
    ))
    .orderBy(desc(webhookEvents.createdAt))
    .limit(1);
  return latestEventResult[0]?.createdAt ?? null;
}

/**
 * Get the most recent backfill (latest open or closed incident, by
 * `backfillAttemptedAt`) so the settings card can surface "Last resync".
 */
export async function getLastBackfill(contractorId: string): Promise<{
  attemptedAt: Date;
  summary: string | null;
  fetchedThroughAt: Date | null;
} | null> {
  const rows = await db.select({
    backfillAttemptedAt: webhookIncidents.backfillAttemptedAt,
    backfillSummary: webhookIncidents.backfillSummary,
    backfillFetchedThroughAt: webhookIncidents.backfillFetchedThroughAt,
  })
    .from(webhookIncidents)
    .where(and(
      eq(webhookIncidents.contractorId, contractorId),
      eq(webhookIncidents.service, SERVICE_HCP),
      sql`${webhookIncidents.backfillAttemptedAt} IS NOT NULL`,
    ))
    .orderBy(desc(webhookIncidents.backfillAttemptedAt))
    .limit(1);
  const row = rows[0];
  if (!row || !row.backfillAttemptedAt) return null;
  return {
    attemptedAt: row.backfillAttemptedAt,
    summary: row.backfillSummary,
    fetchedThroughAt: row.backfillFetchedThroughAt ?? null,
  };
}

// Per-contractor in-progress tracker for manual resyncs. Keeps the HTTP
// endpoint non-blocking (returns immediately) and prevents a user from
// kicking off ten parallel backfills by mashing the "Resync now" button.
// Single-process is fine because (a) backfill is idempotent, (b) the worst
// case in a multi-instance deploy is one extra concurrent backfill, which
// the dispatch layer already deduplicates at the entity level.
const manualBackfillsInProgress = new Set<string>();

export function isManualBackfillInProgress(contractorId: string): boolean {
  return manualBackfillsInProgress.has(contractorId);
}

/**
 * Enqueue a manual resync. Returns immediately with `{ accepted: true }` if
 * the work was scheduled (or `{ accepted: false }` if a resync is already
 * running for this contractor). The actual backfill runs in the background
 * and persists its result under a `webhook_incidents` row so the UI can
 * surface it as "Last resync".
 */
export function triggerManualBackfill(contractorId: string): {
  accepted: boolean;
  reason?: string;
} {
  if (manualBackfillsInProgress.has(contractorId)) {
    return { accepted: false, reason: 'already_in_progress' };
  }
  manualBackfillsInProgress.add(contractorId);
  setImmediate(() => { void runManualBackfillBackground(contractorId); });
  return { accepted: true };
}

async function runManualBackfillBackground(contractorId: string): Promise<void> {
  try {
    // Task #748: the manual resync entry point honors the contractor's
    // configured `housecallProSyncStartDate` directly (no 7-day clamp).
    // We fall back to the last successful webhook event only when no
    // start date is configured, matching prior behaviour for accounts
    // that have never set one. Final fallback (no event either) is null,
    // which `runHcpWebhookBackfill(trigger='manual')` interprets as epoch.
    const configuredStart = await storage.getHousecallProSyncStartDate(contractorId);
    const since = configuredStart ?? await getLastSuccessfulEventAt(contractorId);
    let result: Awaited<ReturnType<typeof runHcpWebhookBackfill>>;
    try {
      result = await runHcpWebhookBackfill(contractorId, since, 'manual');
    } catch (err) {
      const msg = `manual backfill failed: ${err instanceof Error ? err.message : String(err)}`;
      log.error(`[backfill] contractor=${contractorId} ${msg}`);
      // Record the failure on an incident so the UI surfaces "Last resync: failed".
      const failureSummary = `manual: ${msg}`;
      const existingOpen = await getOpenIncident(contractorId, KIND_STALENESS);
      if (existingOpen) {
        await markIncidentBackfill(existingOpen.id, failureSummary, null);
      } else {
        try {
          const { incident } = await openIncidentAtomic(contractorId, KIND_STALENESS);
          await markIncidentBackfill(incident.id, failureSummary, null);
          await closeOpenIncident(contractorId, KIND_STALENESS);
        } catch (incErr) {
          log.error('Failed to record manual backfill failure incident', incErr);
        }
      }
      return;
    }
    const summaryText = summarizeBackfill(result);
    const fetchedThroughAt = result.fetchedThroughAt ? new Date(result.fetchedThroughAt) : null;
    // Manual backfills are recorded under an open incident if one exists,
    // otherwise under a fresh row that is immediately closed (so we keep an
    // audit trail without leaving a phantom open incident).
    const existingOpen = await getOpenIncident(contractorId, KIND_STALENESS);
    if (!existingOpen) {
      const { incident } = await openIncidentAtomic(contractorId, KIND_STALENESS);
      await markIncidentBackfill(incident.id, `manual: ${summaryText}`, fetchedThroughAt);
      await closeOpenIncident(contractorId, KIND_STALENESS);
    } else {
      await markIncidentBackfill(existingOpen.id, `manual: ${summaryText}`, fetchedThroughAt);
    }
    broadcastToContractor(contractorId, { type: 'webhook_status_updated' });
  } catch (outerErr) {
    log.error('Unexpected error in runManualBackfillBackground', outerErr);
  } finally {
    manualBackfillsInProgress.delete(contractorId);
  }
}

// ---------- Health check ----------

export async function checkHcpWebhookHealth(): Promise<void> {
  try {
    const enabledIntegrations = await db.select()
      .from(contractorIntegrations)
      .where(and(
        eq(contractorIntegrations.integrationName, 'housecall-pro'),
        eq(contractorIntegrations.isEnabled, true),
      ))
      .limit(INTEGRATIONS_FETCH_LIMIT);

    if (enabledIntegrations.length >= INTEGRATIONS_FETCH_LIMIT) {
      log.warn(`Integrations fetch returned ${enabledIntegrations.length} rows — at or near the safety cap (${INTEGRATIONS_FETCH_LIMIT}). Some tenants may be skipped. Add pagination if tenant count keeps growing.`);
    }

    if (enabledIntegrations.length === 0) {
      log.info('No contractors with HCP enabled, skipping webhook health check');
      return;
    }

    for (const integration of enabledIntegrations) {
      const contractorId = integration.contractorId;
      try {
        await withTimeout(
          () => checkContractorHealth(contractorId),
          HEALTH_CHECK_TIMEOUT_MS,
          `checkContractorHealth(${contractorId})`,
        );
        // Successful pass — close any open `health-check-failure` incident
        // (the previous tick failed but we recovered). Best-effort: a DB
        // failure here is just logged so it doesn't mask the success.
        await closeOpenIncident(contractorId, KIND_HEALTH_CHECK_FAILURE).catch(err =>
          log.warn(`Failed to close health-check-failure incident for ${contractorId}: ${formatDbError(err)}`)
        );
      } catch (err) {
        log.error(`Error checking webhook health for contractor ${contractorId}: ${formatDbError(err)}`);
        await openHealthCheckFailureIncident(contractorId, err).catch(notifyErr =>
          log.error(`Failed to record health-check-failure incident for ${contractorId}: ${formatDbError(notifyErr)}`)
        );
      }
    }
  } catch (err) {
    log.error(`HCP webhook health check failed: ${formatDbError(err)}`);
  }
}

/**
 * The health-check itself is failing — usually because the DB pool is
 * exhausted or a query is timing out. Open a `health-check-failure`
 * incident (deduped by the unique partial index) and email admins so the
 * outage is visible even though the in-app notifications path itself
 * may be impaired.
 *
 * Email is wrapped in a try/catch — an alerting failure must never make
 * the original health-check failure worse.
 */
async function openHealthCheckFailureIncident(contractorId: string, originalErr: unknown): Promise<void> {
  let incident: typeof webhookIncidents.$inferSelect;
  let created: boolean;
  try {
    const opened = await openIncidentAtomic(contractorId, KIND_HEALTH_CHECK_FAILURE);
    incident = opened.incident;
    created = opened.created;
  } catch (err) {
    log.error(`Cannot open health-check-failure incident (db itself is failing) for ${contractorId}`, err);
    return;
  }
  // Already paged successfully on a prior tick — nothing to do. We
  // intentionally do NOT short-circuit on `!created` alone: a previous
  // tick may have opened the incident but failed to deliver email
  // (transient SMTP outage), in which case `notifiedAt` is still null
  // and we should retry the notify path on this tick.
  if (incident.notifiedAt) {
    return;
  }

  const errMsg = originalErr instanceof Error ? originalErr.message : String(originalErr);
  log.warn(`Contractor ${contractorId}: ${created ? 'opened' : 'retrying notify on'} health-check-failure incident — ${errMsg}`);

  const message =
    `The Housecall Pro webhook health monitor failed to run for your account. ` +
    `This usually means the application's database is overloaded or unreachable. ` +
    `While the monitor is failing, you will NOT receive automatic alerts about webhook ` +
    `outages, so please verify the integration manually until this is resolved. ` +
    `Underlying error: ${errMsg}`;

  await notifyIncidentOpened({
    contractorId,
    incidentId: incident.id,
    kind: 'health-check-failure',
    title: 'Webhook health monitor is failing',
    message,
    emailSubject: 'Webhook health monitor is failing for your CRM',
    emailBody: message,
  });
}

function linkToIntegrations(): string {
  const base = (process.env.APP_URL || '').replace(/\/+$/, '');
  return base ? `${base}/settings/integrations` : '/settings/integrations';
}

/**
 * Single point of truth for "an HCP incident just opened — page everyone."
 *
 * Ordering matters and is intentional (Task #684):
 *   1. Send the out-of-band SendGrid email FIRST. This is the alert
 *      channel that survives the CRM being impaired (the original
 *      symptom), so it's the one we most need to dedup correctly.
 *   2. If email had at least one recipient and ALL of them failed to
 *      deliver, treat that as a transient SMTP outage: bail out
 *      WITHOUT inserting in-app notifications and WITHOUT stamping
 *      `notifiedAt`. The next health-check tick will retry the whole
 *      flow. This is the key fix that prevents a single SMTP hiccup
 *      from permanently silencing the alert.
 *   3. On any other outcome (email succeeded for ≥1 recipient, OR
 *      there are no admin email addresses at all), insert in-app
 *      notifications, broadcast the websocket update, and stamp
 *      `notifiedAt` so we don't double-page.
 *
 * Each side-effect is wrapped individually so a failure in one (e.g.
 * websocket bus down) does not block the others.
 */
export async function notifyIncidentOpened(params: {
  contractorId: string;
  incidentId: string;
  kind: 'staleness' | 'rejection' | 'health-check-failure' | 'subscription-missing';
  title: string;
  message: string;
  emailSubject: string;
  emailBody: string;
}): Promise<void> {
  const { contractorId, incidentId, kind, title, message, emailSubject, emailBody } = params;

  // Thin wrapper around the shared notifier — the actual cooldown gate,
  // email-then-in-app ordering, transient-SMTP guard, and throttle stamp
  // all live in server/services/webhook-incident-notifier.ts so the
  // Dialpad health monitor can reuse exactly the same behaviour with
  // `service = 'dialpad'` (Task #712).
  await notifyWebhookIncidentOpened({
    contractorId,
    incidentId,
    service: SERVICE_HCP,
    kind,
    title,
    message,
    link: '/settings/integrations',
    sendEmail: () => sendHcpIncidentEmail({
      contractorId,
      kind,
      subject: emailSubject,
      body: emailBody,
      link: linkToIntegrations(),
    }),
  });
}


async function checkContractorHealth(contractorId: string): Promise<void> {
  // Hourly subscription probe — runs every tick but only actually calls HCP
  // once per `SUBSCRIPTION_PROBE_INTERVAL_MS`. Done up-front (and not gated
  // on an existing staleness incident) so a deleted webhook subscription is
  // caught proactively, before the 24-hour staleness threshold trips.
  // Errors are swallowed: a probe failure must not abort the rest of the
  // health check.
  try {
    await runSubscriptionProbe(contractorId);
  } catch (err) {
    log.warn(`Subscription probe (proactive) failed for ${contractorId}: ${formatDbError(err)}`);
  }

  const [latestEventResult, rejectionSpike, openStalenessIncident, openRejectionIncident] = await Promise.all([
    db.select({ createdAt: webhookEvents.createdAt })
      .from(webhookEvents)
      .where(and(
        eq(webhookEvents.contractorId, contractorId),
        eq(webhookEvents.service, SERVICE_HCP),
        ne(webhookEvents.eventType, 'rejection'),
      ))
      .orderBy(desc(webhookEvents.createdAt))
      .limit(1),
    checkRejectionSpike(contractorId),
    getOpenIncident(contractorId, KIND_STALENESS),
    getOpenIncident(contractorId, KIND_REJECTION),
  ]);

  const lastEventAt = latestEventResult[0]?.createdAt ?? null;
  const now = new Date();

  // ---- Rejection spike (independent of staleness) ----
  // Enter the notify branch when (a) there's a fresh spike and no incident
  // yet, OR (b) an incident is already open but we haven't successfully
  // notified yet (e.g. last tick's email delivery failed). The latter is
  // what gives us automatic recovery from a transient SMTP outage.
  const needsRejectionNotify =
    rejectionSpike.isSpike && (!openRejectionIncident || !openRejectionIncident.notifiedAt);
  if (needsRejectionNotify) {
    // openIncidentAtomic is idempotent — returns the existing row when one
    // is already open, so this is safe to call on retry ticks too.
    const { incident, created } = await openIncidentAtomic(contractorId, KIND_REJECTION);
    log.warn(
      `Contractor ${contractorId}: ${created ? 'opened' : 'retrying notify on'} rejection incident — ` +
      `${rejectionSpike.recentRejectionCount} rejections in the last 10 minutes with no successful events`
    );

    const reasonNote = rejectionSpike.lastRejectionReason
      ? ` The most recent rejection reason is: ${rejectionSpike.lastRejectionReason}.`
      : '';
    const message = `${rejectionSpike.recentRejectionCount} webhook requests from Housecall Pro were rejected in the last 10 minutes with no successful events.${reasonNote} This usually means the webhook signing secret or URL token is misconfigured. Go to Settings → Integrations → Housecall Pro to verify your webhook configuration.`;
    await notifyIncidentOpened({
      contractorId,
      incidentId: incident.id,
      kind: 'rejection',
      title: 'Housecall Pro Webhook Auth Failures',
      message,
      emailSubject: 'Housecall Pro webhook auth failures',
      emailBody: message,
    });
  } else if (!rejectionSpike.isSpike && openRejectionIncident) {
    log.info(`Contractor ${contractorId}: rejection spike cleared — closing rejection incident`);
    await closeOpenIncident(contractorId, KIND_REJECTION);
  }

  // ---- Staleness ----
  if (!lastEventAt) {
    log.info(`Contractor ${contractorId}: no HCP webhook events recorded yet — skipping staleness check`);
    return;
  }

  const ageMs = now.getTime() - lastEventAt.getTime();

  // Webhooks resumed → close any open staleness incident.
  if (ageMs < WARNING_THRESHOLD_MS) {
    if (openStalenessIncident) {
      log.info(`Contractor ${contractorId}: webhooks resumed — closing staleness incident`);
      await closeOpenIncident(contractorId, KIND_STALENESS);
    }
    return;
  }

  // Server is freshly booted — wait for at least one full warning window
  // of uptime before alerting, so a long downtime doesn't double-fire.
  // This guard is only relevant when no incident is yet open; if one is,
  // we already alerted in a previous run.
  const serverUptimeMs = now.getTime() - serverStartedAt.getTime();
  if (!openStalenessIncident && serverUptimeMs < WARNING_THRESHOLD_MS) {
    log.info(`Contractor ${contractorId}: server uptime is only ${Math.round(serverUptimeMs / 60000)}min, skipping false-alarm check`);
    return;
  }

  // Already in an open incident, AND we already successfully notified for
  // it — there's nothing left to alert on. Retry the backfill if it never
  // got an initial attempt (API was down at incident-open time).
  if (openStalenessIncident && openStalenessIncident.notifiedAt) {
    if (!openStalenessIncident.backfillAttemptedAt) {
      await tryBackfillForOpenIncident(contractorId, openStalenessIncident.id, lastEventAt, 'retry');
    }
    return;
  }

  // ---- Open or reuse the staleness incident (atomic — see openIncidentAtomic) ----
  // openIncidentAtomic is idempotent: it returns the existing row when one
  // is already open with `notifiedAt` still null (i.e. the previous tick
  // failed to deliver email). That's exactly the retry path we want.
  const { incident, created } = await openIncidentAtomic(contractorId, KIND_STALENESS);
  log.warn(
    `Contractor ${contractorId}: ${created ? 'opened' : 'retrying notify on'} staleness incident — ` +
    `last HCP webhook event was ${Math.round(ageMs / 3600000 * 10) / 10}h ago`
  );

  // Try backfill FIRST (regardless of whether admins exist) so a tenant
  // without an admin user still gets caught up, and so the resync summary
  // can be embedded in the notification we send next. Skip the backfill on
  // retry ticks if a previous tick already attempted one — we don't want to
  // re-pull from HCP just because email delivery failed last time.
  const backfillOutcome: BackfillOutcome = incident.backfillAttemptedAt
    ? { kind: 'success', summary: incident.backfillSummary || 'previously synced' }
    : await tryBackfillForOpenIncident(contractorId, incident.id, lastEventAt, 'initial');

  let backfillNote = '';
  if (backfillOutcome.kind === 'success') {
    backfillNote = ` In the meantime we automatically pulled the latest from HCP (${backfillOutcome.summary}), so your CRM should already be caught up.`;
  } else if (backfillOutcome.kind === 'threw') {
    backfillNote = ' We tried to pull the latest from HCP automatically but the API call failed — please use the Resync now button after fixing the webhook.';
  }

  const apiNote = backfillOutcome.kind === 'success'
    ? `The HCP API connection is working, so the webhook delivery is the issue (most likely it was disabled or its URL changed in the HCP dashboard).${backfillNote} To fix it: open the HCP webhook settings and re-enable the URL, then click Resync now in the integration card here.`
    : 'The HCP API connection test also failed — your API key may need to be updated. Once the connection is restored, click Resync now in the integration card here to pull anything missed.';

  const ageHours = Math.round(ageMs / 3600000 * 10) / 10;
  const stalenessMessage = `No webhook events have been received from Housecall Pro in the last ${ageHours} hours, so real-time updates for leads, estimates, and jobs may have stopped. ${apiNote}`;

  // Routed through the shared notifier so the in-app insert, websocket
  // broadcast, out-of-band email, and `notifiedAt` stamp follow the same
  // ordering as every other HCP incident kind (Task #684 code review):
  // email is attempted BEFORE markIncidentNotified, so a transient SMTP
  // failure on this tick doesn't permanently suppress the email path.
  await notifyIncidentOpened({
    contractorId,
    incidentId: incident.id,
    kind: 'staleness',
    title: 'Housecall Pro Webhooks May Be Disabled',
    message: stalenessMessage,
    emailSubject: 'Housecall Pro webhooks may be disabled',
    emailBody: stalenessMessage,
  });

  // Note: a subscription probe was already run at the top of
  // `checkContractorHealth`. We don't re-probe here — the hourly throttle
  // would no-op anyway, and the staleness incident text already advises
  // the admin to verify the dashboard subscription.
}

/**
 * Compare the live HCP webhook-subscription listing against the URL we
 * expect HCP to be calling. If we get a definitive answer that the
 * subscription is missing or disabled, open a `subscription-missing`
 * incident and email admins. Inconclusive results (HCP doesn't expose the
 * listing endpoint, or the API call failed) are silently treated as no-op
 * so we never false-alarm.
 *
 * Rate-limited to once per hour per contractor.
 */
async function runSubscriptionProbe(contractorId: string): Promise<void> {
  const last = lastSubscriptionProbeAt.get(contractorId) ?? 0;
  if (Date.now() - last < SUBSCRIPTION_PROBE_INTERVAL_MS) {
    return;
  }
  lastSubscriptionProbeAt.set(contractorId, Date.now());

  const probe = await hcpWebhookSubscriptionsService.getWebhookSubscriptions(contractorId);
  if (probe.kind !== 'ok') {
    // Inconclusive (HCP doesn't expose listings for this auth, transient
    // 5xx, etc). Do NOT close any open `subscription-missing` incident —
    // closing on inconclusive would mask a real outage that we just
    // happened to fail to verify on this tick. We only ever close the
    // incident below on a *positive* healthy probe result.
    log.info(`Subscription probe inconclusive for ${contractorId}: ${probe.reason}`);
    return;
  }

  const expectedUrl = await getExpectedWebhookUrl(contractorId);
  const isHealthy = subscriptionsContainExpected(probe.subscriptions, expectedUrl);

  if (isHealthy) {
    log.info(`Subscription probe OK for ${contractorId} (${probe.subscriptions.length} subscription(s) found, expected URL is registered)`);
    await closeOpenIncident(contractorId, KIND_SUBSCRIPTION_MISSING).catch(() => undefined);
    return;
  }

  // Open the incident (idempotent) and notify admins on first open.
  let incident: typeof webhookIncidents.$inferSelect;
  try {
    const opened = await openIncidentAtomic(contractorId, KIND_SUBSCRIPTION_MISSING);
    incident = opened.incident;
  } catch (err) {
    log.error(`Failed to open subscription-missing incident for ${contractorId}`, err);
    return;
  }

  const detail = probe.subscriptions.length === 0
    ? 'Housecall Pro reports zero webhook subscriptions for this account.'
    : `Housecall Pro reports ${probe.subscriptions.length} webhook subscription(s), but none of them are pointed at the expected URL${expectedUrl ? ` (${expectedUrl})` : ''}.`;
  log.warn(`Contractor ${contractorId}: subscription-missing incident — ${detail}`);

  // Notify on first open OR retry if a prior tick failed to email
  // (notifiedAt would still be null in that case).
  if (!incident.notifiedAt) {
    const message =
      `${detail} That means the integration is fully disconnected on the HCP side — ` +
      `re-create the webhook subscription in your Housecall Pro account using the URL ` +
      `shown on your CRM's integrations page, then click "Resync now" to backfill ` +
      `anything that was missed while it was offline.`;
    await notifyIncidentOpened({
      contractorId,
      incidentId: incident.id,
      kind: 'subscription-missing',
      title: 'Housecall Pro Webhook Subscription Missing',
      message,
      emailSubject: 'Housecall Pro webhook subscription is missing',
      emailBody: message,
    });
  }
}

async function getExpectedWebhookUrl(contractorId: string): Promise<string | null> {
  const base = (process.env.APP_URL || '').replace(/\/+$/, '');
  if (!base) return null;
  // We don't actually need the URL token here — HCP truncates query strings
  // in some integration listings, so we compare path-only below. Keep it
  // simple: just the base path.
  return `${base}/api/webhooks/${contractorId}/housecall-pro`;
}

function subscriptionsContainExpected(
  subscriptions: HcpWebhookSubscription[],
  expectedUrl: string | null,
): boolean {
  if (subscriptions.length === 0) return false;
  // If we can't compute the expected URL, just assume "any active sub == OK"
  // so we don't false-alarm in environments without APP_URL configured.
  const activeSubs = subscriptions.filter(s => isSubscriptionActive(s));
  if (!expectedUrl) {
    return activeSubs.length > 0;
  }
  return activeSubs.some(s => {
    const url = (s.url ?? s.endpoint ?? '') as string;
    if (!url) return false;
    // Compare path-only — query strings include the URL token which can
    // be regenerated/rotated and may be redacted in HCP's response.
    try {
      const live = new URL(url);
      const expected = new URL(expectedUrl);
      return live.host === expected.host && live.pathname === expected.pathname;
    } catch {
      return url.includes(expectedUrl);
    }
  });
}

function isSubscriptionActive(s: HcpWebhookSubscription): boolean {
  if (typeof s.active === 'boolean') return s.active;
  if (typeof s.enabled === 'boolean') return s.enabled;
  if (typeof s.status === 'string') {
    return /active|enabled|ok/i.test(s.status);
  }
  // Default: assume the subscription is active if HCP returned it.
  return true;
}

/**
 * Attempts an auto-backfill against an open staleness incident. Always
 * stamps `backfillAttemptedAt` on success so future ticks skip the retry
 * path. On failure (API unreachable / threw), leaves it null so a later
 * tick can try again once the HCP API is reachable.
 */
type BackfillOutcome =
  | { kind: 'success'; summary: string }
  | { kind: 'api_down' }
  | { kind: 'threw' };

async function tryBackfillForOpenIncident(
  contractorId: string,
  incidentId: string,
  lastEventAt: Date | null,
  phase: 'initial' | 'retry',
): Promise<BackfillOutcome> {
  let apiConnected = false;
  try {
    const apiResult = await housecallProService.getEmployees(contractorId);
    apiConnected = apiResult.success;
    if (!apiConnected) {
      log.warn(`Contractor ${contractorId}: HCP API connection failed (${phase}) — API key may be invalid or expired`);
    }
  } catch (apiErr) {
    log.warn(`Contractor ${contractorId}: error checking HCP API connection (${phase})`, apiErr);
  }

  if (!apiConnected) {
    return { kind: 'api_down' };
  }

  try {
    const result = await runHcpWebhookBackfill(contractorId, lastEventAt, 'webhook-recovery');
    const summary = summarizeBackfill(result);
    const fetchedThroughAt = result.fetchedThroughAt ? new Date(result.fetchedThroughAt) : null;
    await markIncidentBackfill(incidentId, summary, fetchedThroughAt);
    log.info(`[backfill] contractor=${contractorId} ${phase} auto-backfill complete — ${summary}`);
    return { kind: 'success', summary };
  } catch (err) {
    log.error(`[backfill] contractor=${contractorId} ${phase} auto-backfill threw`, err);
    return { kind: 'threw' };
  }
}

export async function getWebhookHealthStatus(contractorId: string): Promise<{
  lastEventAt: Date | null;
  isStale: boolean;
  ageHours: number | null;
}> {
  const latestEvent = await db.select({ createdAt: webhookEvents.createdAt })
    .from(webhookEvents)
    .where(and(
      eq(webhookEvents.contractorId, contractorId),
      eq(webhookEvents.service, SERVICE_HCP),
    ))
    .orderBy(desc(webhookEvents.createdAt))
    .limit(1);

  const lastEventAt = latestEvent[0]?.createdAt ?? null;

  if (!lastEventAt) {
    return { lastEventAt: null, isStale: false, ageHours: null };
  }

  const ageMs = Date.now() - lastEventAt.getTime();
  return {
    lastEventAt,
    isStale: ageMs > DISABLED_THRESHOLD_MS,
    ageHours: Math.round(ageMs / 3600000 * 10) / 10,
  };
}

async function checkRejectionSpike(contractorId: string): Promise<{
  isSpike: boolean;
  recentRejectionCount: number;
  lastRejectionReason: string | null;
}> {
  const windowStart = new Date(Date.now() - REJECTION_SPIKE_WINDOW_MS);

  const [rejections, successfulEvents] = await Promise.all([
    db.select({ count: sql<number>`count(*)`, errorMessage: webhookEvents.errorMessage })
      .from(webhookEvents)
      .where(and(
        eq(webhookEvents.contractorId, contractorId),
        eq(webhookEvents.service, SERVICE_HCP),
        eq(webhookEvents.eventType, 'rejection'),
        gte(webhookEvents.createdAt, windowStart),
      ))
      .groupBy(webhookEvents.errorMessage),
    db.select({ count: sql<number>`count(*)` })
      .from(webhookEvents)
      .where(and(
        eq(webhookEvents.contractorId, contractorId),
        eq(webhookEvents.service, SERVICE_HCP),
        ne(webhookEvents.eventType, 'rejection'),
        gte(webhookEvents.createdAt, windowStart),
      )),
  ]);

  const totalRejections = rejections.reduce((sum, r) => sum + Number(r.count), 0);
  const totalSuccessful = Number(successfulEvents[0]?.count ?? 0);

  const lastRejection = await db.select({ errorMessage: webhookEvents.errorMessage })
    .from(webhookEvents)
    .where(and(
      eq(webhookEvents.contractorId, contractorId),
      eq(webhookEvents.service, SERVICE_HCP),
      eq(webhookEvents.eventType, 'rejection'),
    ))
    .orderBy(desc(webhookEvents.createdAt))
    .limit(1);

  return {
    isSpike: totalRejections >= REJECTION_SPIKE_COUNT && totalSuccessful === 0,
    recentRejectionCount: totalRejections,
    lastRejectionReason: lastRejection[0]?.errorMessage ?? null,
  };
}

export async function getRejectionCount24h(contractorId: string): Promise<number> {
  const windowStart = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const result = await db.select({ count: sql<number>`count(*)` })
    .from(webhookEvents)
    .where(and(
      eq(webhookEvents.contractorId, contractorId),
      eq(webhookEvents.service, SERVICE_HCP),
      eq(webhookEvents.eventType, 'rejection'),
      gte(webhookEvents.createdAt, windowStart),
    ));
  return Number(result[0]?.count ?? 0);
}

export async function getWebhookStatus(contractorId: string): Promise<{
  lastEventAt: Date | null;
  status: 'healthy' | 'warning' | 'disabled';
  statusReason?: string;
  serverStartedAt: Date;
  rejectionCount24h: number;
  lastRejectionReason: string | null;
  lastBackfillAt: Date | null;
  lastBackfillSummary: string | null;
  lastBackfillFetchedThroughAt: Date | null;
  backfillInProgress: boolean;
}> {
  const [latestEventResult, rejectionSpikeResult, rejectionCount24h, lastBackfill] = await Promise.all([
    db.select({ createdAt: webhookEvents.createdAt })
      .from(webhookEvents)
      .where(and(
        eq(webhookEvents.contractorId, contractorId),
        eq(webhookEvents.service, SERVICE_HCP),
        ne(webhookEvents.eventType, 'rejection'),
      ))
      .orderBy(desc(webhookEvents.createdAt))
      .limit(1),
    checkRejectionSpike(contractorId),
    getRejectionCount24h(contractorId),
    getLastBackfill(contractorId),
  ]);

  const lastEventAt = latestEventResult[0]?.createdAt ?? null;
  const now = new Date();
  const serverUptimeMs = now.getTime() - serverStartedAt.getTime();

  let status: 'healthy' | 'warning' | 'disabled';
  let statusReason: string | undefined;

  if (rejectionSpikeResult.isSpike) {
    status = 'warning';
    statusReason = 'auth_failing';
  } else if (!lastEventAt) {
    if (serverUptimeMs < WARNING_THRESHOLD_MS) {
      status = 'healthy';
    } else if (serverUptimeMs < DISABLED_THRESHOLD_MS) {
      status = 'warning';
    } else {
      status = 'disabled';
    }
  } else {
    const ageMs = now.getTime() - lastEventAt.getTime();
    if (ageMs < WARNING_THRESHOLD_MS) {
      status = 'healthy';
    } else if (ageMs < DISABLED_THRESHOLD_MS) {
      if (serverUptimeMs < WARNING_THRESHOLD_MS) {
        status = 'healthy';
      } else {
        status = 'warning';
      }
    } else {
      if (serverUptimeMs < WARNING_THRESHOLD_MS) {
        status = 'healthy';
      } else if (serverUptimeMs < DISABLED_THRESHOLD_MS) {
        status = 'warning';
      } else {
        status = 'disabled';
      }
    }
  }

  return {
    lastEventAt,
    status,
    statusReason,
    serverStartedAt,
    rejectionCount24h,
    lastRejectionReason: rejectionSpikeResult.lastRejectionReason,
    lastBackfillAt: lastBackfill?.attemptedAt ?? null,
    lastBackfillSummary: lastBackfill?.summary ?? null,
    lastBackfillFetchedThroughAt: lastBackfill?.fetchedThroughAt ?? null,
    backfillInProgress: manualBackfillsInProgress.has(contractorId),
  };
}

async function hasAnyHcpTenant(): Promise<boolean> {
  const rows = await db.select({ contractorId: contractorIntegrations.contractorId })
    .from(contractorIntegrations)
    .where(and(
      eq(contractorIntegrations.integrationName, 'housecall-pro'),
      eq(contractorIntegrations.isEnabled, true),
    ))
    .limit(1);
  return rows.length > 0;
}

function startInterval(): void {
  if (intervalHandle) return;
  intervalHandle = setInterval(() => {
    checkHcpWebhookHealth().catch(err =>
      log.error(`Periodic HCP webhook health check failed: ${formatDbError(err)}`)
    );
  }, CHECK_INTERVAL_MS);
  log.info('HCP webhook health check interval started (every 5 minutes)');
}

async function runStartupFastCheck(): Promise<void> {
  try {
    const enabledIntegrations = await db.select()
      .from(contractorIntegrations)
      .where(and(
        eq(contractorIntegrations.integrationName, 'housecall-pro'),
        eq(contractorIntegrations.isEnabled, true),
      ))
      .limit(INTEGRATIONS_FETCH_LIMIT);

    if (enabledIntegrations.length === 0) return;

    const FAST_CHECK_THRESHOLD_MS = 24 * 60 * 60 * 1000;

    for (const integration of enabledIntegrations) {
      const contractorId = integration.contractorId;
      try {
        const latestEventResult = await db.select({ createdAt: webhookEvents.createdAt })
          .from(webhookEvents)
          .where(and(
            eq(webhookEvents.contractorId, contractorId),
            eq(webhookEvents.service, SERVICE_HCP),
            ne(webhookEvents.eventType, 'rejection'),
          ))
          .orderBy(desc(webhookEvents.createdAt))
          .limit(1);

        const lastEventAt = latestEventResult[0]?.createdAt;
        if (!lastEventAt) continue;

        const ageMs = Date.now() - lastEventAt.getTime();
        if (ageMs < FAST_CHECK_THRESHOLD_MS) continue;

        // Already an open incident → notification was already sent in the
        // previous boot, do NOT re-notify (this is the whole point of
        // persisting the marker).
        const existing = await getOpenIncident(contractorId, KIND_STALENESS);
        if (existing) {
          log.info(`Startup fast-check: contractor ${contractorId} — open staleness incident already exists, suppressing duplicate alert`);
          continue;
        }

        let apiConnected = false;
        try {
          const apiResult = await housecallProService.getEmployees(contractorId);
          apiConnected = apiResult.success;
        } catch (_) { /* ignore */ }

        if (!apiConnected) {
          log.info(`Startup fast-check: contractor ${contractorId} — API not reachable, skipping alert`);
          continue;
        }

        const { incident, created } = await openIncidentAtomic(contractorId, KIND_STALENESS);
        if (!created) {
          log.info(`Startup fast-check: contractor ${contractorId} — staleness incident already exists (race), skipping`);
          continue;
        }
        const ageHours = Math.round(ageMs / 3600000 * 10) / 10;
        log.warn(`Startup fast-check: contractor ${contractorId} — no HCP webhook events in ${ageHours}h but API is alive, alerting admins`);

        // Auto-backfill on the startup path too — same logic as the
        // periodic checker, kept inline so the message can mention what
        // we already pulled.
        let backfillNote = '';
        try {
          const result = await runHcpWebhookBackfill(contractorId, lastEventAt, 'webhook-recovery');
          const summaryText = summarizeBackfill(result);
          const fetchedThroughAt = result.fetchedThroughAt ? new Date(result.fetchedThroughAt) : null;
          await markIncidentBackfill(incident.id, summaryText, fetchedThroughAt);
          backfillNote = ` We already pulled the latest from HCP for you (${summaryText}).`;
        } catch (err) {
          log.error(`[backfill] contractor=${contractorId} startup auto-backfill threw`, err);
        }

        const contractorUsers = await storage.getContractorUsers(contractorId);
        const adminUsers = contractorUsers.filter(uc =>
          uc.role === 'admin' || uc.role === 'super_admin'
        );

        if (adminUsers.length === 0) continue;

        const stalenessMessage = `No HCP webhook events have been received in the last ${ageHours} hours.${backfillNote} Open Settings → Integrations → Housecall Pro to verify the webhook URL is still active in the HCP dashboard, then click Resync now to pull anything that may still be missing.`;

        // Routed through the shared notifier so dedup semantics match the
        // periodic checker: email is attempted first, and `notifiedAt` is
        // only stamped when at least one channel actually delivered. A
        // transient SMTP failure here will be retried by the periodic
        // checker (which also sees `notifiedAt = null` and re-enters the
        // notify branch).
        await notifyIncidentOpened({
          contractorId,
          incidentId: incident.id,
          kind: 'staleness',
          title: 'Housecall Pro Webhooks May Be Disabled',
          message: stalenessMessage,
          emailSubject: 'Housecall Pro webhooks may be disabled',
          emailBody: stalenessMessage,
        });
      } catch (err) {
        log.error(`Startup fast-check error for contractor ${contractorId}: ${formatDbError(err)}`);
      }
    }
  } catch (err) {
    log.error(`Startup fast-check failed: ${formatDbError(err)}`);
  }
}

export async function startHcpWebhookHealthCheck(): Promise<void> {
  serverStartedAt = new Date();
  const anyTenant = await hasAnyHcpTenant();
  if (!anyTenant) {
    log.info('No HCP tenants found at startup — skipping health check scheduling');
    return;
  }
  log.info('Starting HCP webhook health check (runs every 5 minutes)');
  setTimeout(() => {
    runStartupFastCheck().catch(err =>
      log.error(`Startup fast-check failed: ${formatDbError(err)}`)
    );
    checkHcpWebhookHealth().catch(err =>
      log.error(`Initial HCP webhook health check failed: ${formatDbError(err)}`)
    );
  }, 60_000);
  startInterval();
}

export function stopHcpWebhookHealthCheck(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    log.info('HCP webhook health check interval stopped');
  }
}

/**
 * Call this whenever an HCP integration is enabled or disabled so the health
 * check interval can be started (if first tenant) or stopped (if last tenant).
 */
export async function notifyHcpIntegrationChanged(): Promise<void> {
  const anyTenant = await hasAnyHcpTenant();
  if (anyTenant && !intervalHandle) {
    log.info('HCP integration enabled — starting health check interval');
    startInterval();
  } else if (!anyTenant && intervalHandle) {
    log.info('Last HCP integration disabled — stopping health check interval');
    stopHcpWebhookHealthCheck();
  }
}
