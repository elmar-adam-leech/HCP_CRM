import { db } from "../db";
import { webhookEvents, contractorIntegrations, webhookIncidents } from "@shared/schema";
import { eq, and, desc, ne, like, sql, isNull, isNotNull } from "drizzle-orm";
import { logger } from "../utils/logger";
import { formatDbError } from "../utils/db-error";
import { sendDialpadIncidentEmail, type DialpadIncidentKind } from "./dialpad-incident-email";
import { notifyWebhookIncidentOpened } from "./webhook-incident-notifier";
import { hasAnyEnabledIntegration } from "./integration-presence";

const log = logger('DialpadCallHealth');

const STALE_THRESHOLD_DAYS = 7;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6 hours
const BACKLOG_CHECK_INTERVAL_MS = 15 * 60 * 1000; // every 15 minutes
const BACKLOG_WARN_THRESHOLD = 50;
const POLLER_CONSECUTIVE_FAILURE_THRESHOLD = 3;
const INTEGRATIONS_FETCH_LIMIT = 100;

const SERVICE_DIALPAD = 'dialpad';
const KIND_STALENESS = 'staleness';
const KIND_POLLER_FAILURE = 'poller-failure';
const KIND_BACKLOG = 'backlog';
const KIND_FAILED_EVENTS = 'failed-events';

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let backlogIntervalHandle: ReturnType<typeof setInterval> | null = null;

// ---------------------------------------------------------------------------
// Poller outcome tracking — the DialpadEventPoller calls recordPollerOutcome
// on every tick so the backlog checker can warn when the poller has been
// failing repeatedly. Without this, a failing poller is silent until an
// operator happens to scan logs.
// ---------------------------------------------------------------------------
interface PollerOutcomeState {
  consecutiveFailures: number;
  lastFailureAt: number | null;
  lastSuccessAt: number | null;
}

const pollerOutcome: PollerOutcomeState = {
  consecutiveFailures: 0,
  lastFailureAt: null,
  lastSuccessAt: null,
};

export function recordPollerOutcome(success: boolean): void {
  if (success) {
    pollerOutcome.consecutiveFailures = 0;
    pollerOutcome.lastSuccessAt = Date.now();
  } else {
    pollerOutcome.consecutiveFailures += 1;
    pollerOutcome.lastFailureAt = Date.now();
  }
}

export function getPollerOutcomeState(): Readonly<PollerOutcomeState> {
  return pollerOutcome;
}

// ---------------------------------------------------------------------------
// Incident helpers — Task #712 wires Dialpad health alerts through the same
// throttled notifier that HCP uses, so a flapping outage pages once per 24h
// per kind instead of every health-check tick. Pattern mirrors
// hcp-webhook-health.ts; the unique partial index on
// webhook_incidents (contractor_id, service, kind) WHERE closed_at IS NULL
// makes "open if not already open" race-free.
// ---------------------------------------------------------------------------

async function getOpenIncident(contractorId: string, kind: string) {
  const rows = await db.select()
    .from(webhookIncidents)
    .where(and(
      eq(webhookIncidents.contractorId, contractorId),
      eq(webhookIncidents.service, SERVICE_DIALPAD),
      eq(webhookIncidents.kind, kind),
      isNull(webhookIncidents.closedAt),
    ))
    .limit(1);
  return rows[0];
}

async function openIncidentAtomic(contractorId: string, kind: string): Promise<{
  incident: typeof webhookIncidents.$inferSelect;
  created: boolean;
}> {
  const inserted = await db.insert(webhookIncidents).values({
    contractorId,
    service: SERVICE_DIALPAD,
    kind,
  })
    .onConflictDoNothing()
    .returning();
  if (inserted[0]) {
    return { incident: inserted[0], created: true };
  }
  const existing = await getOpenIncident(contractorId, kind);
  if (!existing) {
    throw new Error(`openIncidentAtomic: insert conflicted but no open incident found for ${contractorId}/${kind}`);
  }
  return { incident: existing, created: false };
}

async function closeOpenIncident(contractorId: string, kind: string): Promise<void> {
  await db.update(webhookIncidents)
    .set({ closedAt: new Date() })
    .where(and(
      eq(webhookIncidents.contractorId, contractorId),
      eq(webhookIncidents.service, SERVICE_DIALPAD),
      eq(webhookIncidents.kind, kind),
      isNull(webhookIncidents.closedAt),
    ));
  // Throttle is intentionally NOT cleared — the 24h cooldown spans
  // open/close cycles to suppress flap pages, matching HCP behaviour.
}

/**
 * Thin wrapper around the shared notifier with `service = 'dialpad'`.
 * Cooldown isolation is per-(contractor, service, kind), so an HCP
 * staleness cooldown does NOT suppress a Dialpad staleness alert.
 */
async function notifyDialpadIncidentOpened(params: {
  contractorId: string;
  incidentId: string;
  kind: DialpadIncidentKind;
  title: string;
  message: string;
}): Promise<void> {
  const { contractorId, incidentId, kind, title, message } = params;
  await notifyWebhookIncidentOpened({
    contractorId,
    incidentId,
    service: SERVICE_DIALPAD,
    kind,
    title,
    message,
    link: '/settings/integrations',
    sendEmail: () => sendDialpadIncidentEmail({
      contractorId,
      kind,
      subject: title,
      body: message,
      link: linkToIntegrations(),
    }),
  });
}

function linkToIntegrations(): string {
  const base = (process.env.APP_URL || '').replace(/\/+$/, '');
  return base ? `${base}/settings/integrations` : '/settings/integrations';
}

/**
 * Open + notify (or skip notify if already open and previously paged).
 * Best-effort: failures are logged so a notify outage doesn't mask the
 * underlying health-check work.
 */
async function reportContractorIncident(
  contractorId: string,
  kind: DialpadIncidentKind,
  title: string,
  message: string,
): Promise<void> {
  let incident: typeof webhookIncidents.$inferSelect;
  let created: boolean;
  try {
    const opened = await openIncidentAtomic(contractorId, kind);
    incident = opened.incident;
    created = opened.created;
  } catch (err) {
    log.error(`Failed to open ${kind} incident for ${contractorId}: ${formatDbError(err)}`);
    return;
  }
  // If a prior tick already successfully paged, don't retry the notify
  // path — `notifiedAt` is the dedup marker. Matches HCP semantics.
  if (!created && incident.notifiedAt) {
    return;
  }
  try {
    await notifyDialpadIncidentOpened({
      contractorId,
      incidentId: incident.id,
      kind,
      title,
      message,
    });
  } catch (err) {
    log.error(`Failed to notify ${kind} incident for ${contractorId}: ${formatDbError(err)}`);
  }
}

export async function checkDialpadCallHealth(): Promise<void> {
  // Cheap cached gate: skip the per-tenant scan entirely when no contractor
  // has Dialpad enabled.
  if (!(await hasAnyEnabledIntegration('dialpad'))) {
    return;
  }
  try {
    const enabledIntegrations = await db
      .select({ contractorId: contractorIntegrations.contractorId })
      .from(contractorIntegrations)
      .where(
        and(
          eq(contractorIntegrations.integrationName, 'dialpad'),
          eq(contractorIntegrations.isEnabled, true),
        )
      )
      .limit(INTEGRATIONS_FETCH_LIMIT);

    if (enabledIntegrations.length >= INTEGRATIONS_FETCH_LIMIT) {
      log.warn(`Integrations fetch at limit (${INTEGRATIONS_FETCH_LIMIT}). Some tenants may be skipped.`);
    }

    if (enabledIntegrations.length === 0) {
      log.info('No contractors with Dialpad enabled, skipping call health check');
      return;
    }

    const staleThresholdMs = STALE_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;
    const now = Date.now();

    for (const { contractorId } of enabledIntegrations) {
      try {
        // Last received call event of any kind (excluding auth failures).
        const receivedRows = await db
          .select({ createdAt: webhookEvents.createdAt })
          .from(webhookEvents)
          .where(
            and(
              eq(webhookEvents.contractorId, contractorId),
              eq(webhookEvents.service, 'dialpad'),
              like(webhookEvents.eventType, 'call.%'),
              ne(webhookEvents.eventType, 'call.auth_failed')
            )
          )
          .orderBy(desc(webhookEvents.createdAt))
          .limit(1);

        // Last successfully processed call event — distinguishes "events
        // are arriving" from "events are flowing through to activities".
        const processedRows = await db
          .select({ processedAt: webhookEvents.processedAt })
          .from(webhookEvents)
          .where(
            and(
              eq(webhookEvents.contractorId, contractorId),
              eq(webhookEvents.service, 'dialpad'),
              like(webhookEvents.eventType, 'call.%'),
              ne(webhookEvents.eventType, 'call.auth_failed'),
              eq(webhookEvents.processed, true)
            )
          )
          .orderBy(desc(webhookEvents.processedAt))
          .limit(1);

        const lastCallEventAt = receivedRows[0]?.createdAt ?? null;
        const lastProcessedAt = processedRows[0]?.processedAt ?? null;

        let stale = false;
        let staleMessage = '';
        if (!lastCallEventAt) {
          stale = true;
          staleMessage =
            `Dialpad is enabled but no call events have ever been received. ` +
            `Call subscriptions may be missing or misconfigured.`;
          log.warn(`[DialpadCallHealth] Contractor ${contractorId}: ${staleMessage}`);
        } else {
          const ageMs = now - new Date(lastCallEventAt).getTime();
          if (ageMs > staleThresholdMs) {
            const staleDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));
            stale = true;
            staleMessage =
              `No Dialpad call events received in ${staleDays} day(s). ` +
              `Last call event was at ${lastCallEventAt.toISOString()}. ` +
              `Call subscriptions may be stale or misconfigured.`;
            log.warn(`[DialpadCallHealth] Contractor ${contractorId}: ${staleMessage}`);
          } else {
            const processedSuffix = lastProcessedAt
              ? `, last processed ${new Date(lastProcessedAt).toISOString()}`
              : ', NEVER PROCESSED — events are arriving but not flowing into activities';
            log.info(
              `[DialpadCallHealth] Contractor ${contractorId}: Call events OK ` +
              `(last received ${new Date(lastCallEventAt).toISOString()}${processedSuffix})`
            );
          }
        }

        if (stale) {
          await reportContractorIncident(
            contractorId,
            KIND_STALENESS,
            'Dialpad call events are not arriving',
            staleMessage,
          );
        } else {
          await closeOpenIncident(contractorId, KIND_STALENESS).catch(err =>
            log.warn(`Failed to close staleness incident for ${contractorId}: ${formatDbError(err)}`)
          );
        }
      } catch (err) {
        log.error(
          `[DialpadCallHealth] Error checking call health for contractor ${contractorId}: ${formatDbError(err)}`
        );
      }
    }
  } catch (err) {
    log.error(`Dialpad call health check failed: ${formatDbError(err)}`);
  }
}

/**
 * Backlog checker — runs more frequently than the staleness checker because
 * a stuck poller affects call ops on the timescale of minutes, not days.
 * Warns + pages when:
 *   - The DialpadEventPoller has logged consecutive query failures.
 *   - Any contractor has accumulated more than BACKLOG_WARN_THRESHOLD
 *     unprocessed dialpad webhook_events rows.
 *   - Any contractor has more than BACKLOG_WARN_THRESHOLD permanently-failed
 *     events in the last 24h.
 */
export async function checkDialpadBacklog(): Promise<void> {
  // Cheap cached gate: with no Dialpad-enabled contractor the poller never
  // queries (so it cannot accumulate failures) and there can be no backlog —
  // skip the whole check.
  if (!(await hasAnyEnabledIntegration('dialpad'))) {
    return;
  }
  // 1. Surface poller failures even when the failing query line scrolled away.
  // The poller is process-wide (not per-contractor), so we page every
  // contractor that has Dialpad enabled — a poller outage affects them all.
  if (pollerOutcome.consecutiveFailures >= POLLER_CONSECUTIVE_FAILURE_THRESHOLD) {
    const lastFailure = pollerOutcome.lastFailureAt
      ? new Date(pollerOutcome.lastFailureAt).toISOString()
      : 'unknown';
    const lastSuccess = pollerOutcome.lastSuccessAt
      ? new Date(pollerOutcome.lastSuccessAt).toISOString()
      : 'never';
    const pollerMessage =
      `The Dialpad event poller has failed ${pollerOutcome.consecutiveFailures} consecutive ticks ` +
      `(last failure ${lastFailure}, last success ${lastSuccess}). ` +
      `Unprocessed call/SMS events will not flow into activities until the poller recovers.`;
    log.warn(`[DialpadCallHealth] ${pollerMessage}`);

    try {
      const enabled = await db
        .select({ contractorId: contractorIntegrations.contractorId })
        .from(contractorIntegrations)
        .where(and(
          eq(contractorIntegrations.integrationName, 'dialpad'),
          eq(contractorIntegrations.isEnabled, true),
        ))
        .limit(INTEGRATIONS_FETCH_LIMIT);
      for (const { contractorId } of enabled) {
        await reportContractorIncident(
          contractorId,
          KIND_POLLER_FAILURE,
          'Dialpad event poller is failing',
          pollerMessage,
        );
      }
    } catch (err) {
      log.error(`Failed to enumerate Dialpad-enabled contractors for poller-failure paging: ${formatDbError(err)}`);
    }
  } else if (pollerOutcome.lastSuccessAt) {
    // Poller has recovered — close any open poller-failure incidents so
    // the next genuine outage pages immediately (subject to the 24h cooldown).
    try {
      const openRows = await db.select({
        contractorId: webhookIncidents.contractorId,
      })
        .from(webhookIncidents)
        .where(and(
          eq(webhookIncidents.service, SERVICE_DIALPAD),
          eq(webhookIncidents.kind, KIND_POLLER_FAILURE),
          isNull(webhookIncidents.closedAt),
        ));
      for (const row of openRows) {
        await closeOpenIncident(row.contractorId, KIND_POLLER_FAILURE).catch(err =>
          log.warn(`Failed to close poller-failure incident for ${row.contractorId}: ${formatDbError(err)}`)
        );
      }
    } catch (err) {
      log.warn(`Failed to look up open poller-failure incidents: ${formatDbError(err)}`);
    }
  }

  // 2. Per-contractor backlog of pending (still-retryable) dialpad rows.
  // Permanently-failed rows (failed_at IS NOT NULL) are counted separately
  // below — the poller will not retry them so they need a different surface.
  const contractorsWithBacklog = new Set<string>();
  try {
    const rows = await db
      .select({
        contractorId: webhookEvents.contractorId,
        backlog: sql<number>`count(*)::int`,
      })
      .from(webhookEvents)
      .where(
        and(
          eq(webhookEvents.service, 'dialpad'),
          eq(webhookEvents.processed, false),
          isNull(webhookEvents.failedAt),
        )
      )
      .groupBy(webhookEvents.contractorId);

    for (const row of rows) {
      if (row.backlog >= BACKLOG_WARN_THRESHOLD && row.contractorId) {
        contractorsWithBacklog.add(row.contractorId);
        const message =
          `${row.backlog} pending Dialpad webhook events (threshold ${BACKLOG_WARN_THRESHOLD}). ` +
          `The poller may be failing or the worker is wedged — calls may not be appearing in the app.`;
        log.warn(`[DialpadCallHealth] Contractor ${row.contractorId}: ${message}`);
        await reportContractorIncident(
          row.contractorId,
          KIND_BACKLOG,
          'Dialpad webhook backlog is growing',
          message,
        );
      }
    }
  } catch (err) {
    log.error(`[DialpadCallHealth] Backlog check query failed: ${formatDbError(err)}`);
  }

  // Auto-close backlog incidents for contractors that dropped below threshold.
  try {
    const openBacklog = await db.select({ contractorId: webhookIncidents.contractorId })
      .from(webhookIncidents)
      .where(and(
        eq(webhookIncidents.service, SERVICE_DIALPAD),
        eq(webhookIncidents.kind, KIND_BACKLOG),
        isNull(webhookIncidents.closedAt),
      ));
    for (const row of openBacklog) {
      if (!contractorsWithBacklog.has(row.contractorId)) {
        await closeOpenIncident(row.contractorId, KIND_BACKLOG).catch(err =>
          log.warn(`Failed to close backlog incident for ${row.contractorId}: ${formatDbError(err)}`)
        );
      }
    }
  } catch (err) {
    log.warn(`Failed to look up open backlog incidents: ${formatDbError(err)}`);
  }

  // 3. Per-contractor count of permanently-failed dialpad rows in the last 24h.
  const contractorsWithFailedEvents = new Set<string>();
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const rows = await db
      .select({
        contractorId: webhookEvents.contractorId,
        failed: sql<number>`count(*)::int`,
      })
      .from(webhookEvents)
      .where(
        and(
          eq(webhookEvents.service, 'dialpad'),
          isNotNull(webhookEvents.failedAt),
          sql`${webhookEvents.failedAt} >= ${since}`,
        )
      )
      .groupBy(webhookEvents.contractorId);

    for (const row of rows) {
      if (row.failed >= BACKLOG_WARN_THRESHOLD && row.contractorId) {
        contractorsWithFailedEvents.add(row.contractorId);
        const message =
          `${row.failed} Dialpad webhook events permanently failed in the last 24h. ` +
          `These rows are out of the backlog but still need investigation — ` +
          `inspect webhook_events.error_message or use the retry endpoint.`;
        log.warn(`[DialpadCallHealth] Contractor ${row.contractorId}: ${message}`);
        await reportContractorIncident(
          row.contractorId,
          KIND_FAILED_EVENTS,
          'Dialpad webhook events are failing',
          message,
        );
      }
    }
  } catch (err) {
    log.error(`[DialpadCallHealth] Failed-events check query failed: ${formatDbError(err)}`);
  }

  try {
    const openFailed = await db.select({ contractorId: webhookIncidents.contractorId })
      .from(webhookIncidents)
      .where(and(
        eq(webhookIncidents.service, SERVICE_DIALPAD),
        eq(webhookIncidents.kind, KIND_FAILED_EVENTS),
        isNull(webhookIncidents.closedAt),
      ));
    for (const row of openFailed) {
      if (!contractorsWithFailedEvents.has(row.contractorId)) {
        await closeOpenIncident(row.contractorId, KIND_FAILED_EVENTS).catch(err =>
          log.warn(`Failed to close failed-events incident for ${row.contractorId}: ${formatDbError(err)}`)
        );
      }
    }
  } catch (err) {
    log.warn(`Failed to look up open failed-events incidents: ${formatDbError(err)}`);
  }
}

export async function startDialpadCallHealthCheck(): Promise<void> {
  if (intervalHandle) return;

  log.info('Starting Dialpad call webhook health check (runs every 6 hours)');

  setTimeout(() => {
    checkDialpadCallHealth().catch(err =>
      log.error('Initial Dialpad call health check failed', err)
    );
  }, 2 * 60 * 1000);

  intervalHandle = setInterval(() => {
    checkDialpadCallHealth().catch(err =>
      log.error('Periodic Dialpad call health check failed', err)
    );
  }, CHECK_INTERVAL_MS);

  log.info('Dialpad call health check interval started (every 6 hours)');

  if (!backlogIntervalHandle) {
    // First backlog check runs shortly after start so post-deploy operators
    // see whether a backlog accumulated while the app was down.
    setTimeout(() => {
      checkDialpadBacklog().catch(err =>
        log.error('Initial Dialpad backlog check failed', err)
      );
    }, 60 * 1000);

    backlogIntervalHandle = setInterval(() => {
      checkDialpadBacklog().catch(err =>
        log.error('Periodic Dialpad backlog check failed', err)
      );
    }, BACKLOG_CHECK_INTERVAL_MS);

    log.info('Dialpad backlog check interval started (every 15 minutes)');
  }
}

export function stopDialpadCallHealthCheck(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    log.info('Dialpad call health check interval stopped');
  }
  if (backlogIntervalHandle) {
    clearInterval(backlogIntervalHandle);
    backlogIntervalHandle = null;
    log.info('Dialpad backlog check interval stopped');
  }
}
