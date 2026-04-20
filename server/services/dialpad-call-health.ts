import { db } from "../db";
import { webhookEvents, contractorIntegrations } from "@shared/schema";
import { eq, and, desc, ne, like, sql, isNull, isNotNull } from "drizzle-orm";
import { logger } from "../utils/logger";
import { formatDbError } from "../utils/db-error";

const log = logger('DialpadCallHealth');

const STALE_THRESHOLD_DAYS = 7;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6 hours
const BACKLOG_CHECK_INTERVAL_MS = 15 * 60 * 1000; // every 15 minutes
const BACKLOG_WARN_THRESHOLD = 50;
const POLLER_CONSECUTIVE_FAILURE_THRESHOLD = 3;
const INTEGRATIONS_FETCH_LIMIT = 100;

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

export async function checkDialpadCallHealth(): Promise<void> {
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

        if (!lastCallEventAt) {
          log.warn(
            `[DialpadCallHealth] Contractor ${contractorId}: Dialpad is enabled but no call events have ever been received. ` +
            'Call subscriptions may be missing or misconfigured.'
          );
        } else {
          const ageMs = now - new Date(lastCallEventAt).getTime();
          if (ageMs > staleThresholdMs) {
            const staleDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));
            log.warn(
              `[DialpadCallHealth] Contractor ${contractorId}: No call events received in ${staleDays} day(s). ` +
              `Last call event was at ${lastCallEventAt.toISOString()}. ` +
              'Call subscriptions may be stale or misconfigured.'
            );
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
 * Warns when:
 *   - The DialpadEventPoller has logged consecutive query failures.
 *   - Any contractor has accumulated more than BACKLOG_WARN_THRESHOLD
 *     unprocessed dialpad webhook_events rows.
 */
export async function checkDialpadBacklog(): Promise<void> {
  // 1. Surface poller failures even when the failing query line scrolled away.
  if (pollerOutcome.consecutiveFailures >= POLLER_CONSECUTIVE_FAILURE_THRESHOLD) {
    const lastFailure = pollerOutcome.lastFailureAt
      ? new Date(pollerOutcome.lastFailureAt).toISOString()
      : 'unknown';
    const lastSuccess = pollerOutcome.lastSuccessAt
      ? new Date(pollerOutcome.lastSuccessAt).toISOString()
      : 'never';
    log.warn(
      `[DialpadCallHealth] DialpadEventPoller has failed ${pollerOutcome.consecutiveFailures} consecutive ticks ` +
      `(last failure ${lastFailure}, last success ${lastSuccess}). ` +
      'Unprocessed call/SMS events will not flow into activities until the poller recovers — ' +
      'check the most recent "Failed to query unprocessed dialpad webhook events" log for the underlying postgres error.'
    );
  }

  // 2. Per-contractor backlog of pending (still-retryable) dialpad rows.
  // Permanently-failed rows (failed_at IS NOT NULL) are no longer counted as
  // backlog because the poller will not retry them — they need operator
  // attention via the failed-events surface, not a backlog warning.
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
      if (row.backlog >= BACKLOG_WARN_THRESHOLD) {
        log.warn(
          `[DialpadCallHealth] Contractor ${row.contractorId ?? '(null)'}: ` +
          `${row.backlog} pending dialpad webhook events (threshold ${BACKLOG_WARN_THRESHOLD}). ` +
          'The poller may be failing or the worker is wedged — calls may not be appearing in the app.'
        );
      }
    }
  } catch (err) {
    log.error(`[DialpadCallHealth] Backlog check query failed: ${formatDbError(err)}`);
  }

  // 3. Per-contractor count of permanently-failed dialpad rows in the last
  // 24h. Surfaced separately so a backlog of failed events doesn't hide
  // behind the pending-only count above.
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
      if (row.failed >= BACKLOG_WARN_THRESHOLD) {
        log.warn(
          `[DialpadCallHealth] Contractor ${row.contractorId ?? '(null)'}: ` +
          `${row.failed} dialpad webhook events permanently failed in the last 24h. ` +
          'These rows are out of the backlog but still need investigation — ' +
          'inspect webhook_events.error_message or use the retry endpoint.'
        );
      }
    }
  } catch (err) {
    log.error(`[DialpadCallHealth] Failed-events check query failed: ${formatDbError(err)}`);
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
