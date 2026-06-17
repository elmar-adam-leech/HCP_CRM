import { db } from "../db";
import { webhookEvents } from "@shared/schema";
import { and, asc, eq, isNull } from "drizzle-orm";
import { logger } from "../utils/logger";
import { formatDbError } from "../utils/db-error";
import { recordPollerOutcome } from "../services/dialpad-call-health";
import {
  hasAnyEnabledIntegration,
  invalidateIntegrationPresence,
} from "../services/integration-presence";
import {
  enqueueDialpadEvent,
  isDialpadEventInFlight,
} from "./dialpad-event-worker";
import { processDialpadCallEvent } from "../routes/webhooks/dialpad-calls";
import {
  processSmsMessageEvent,
  processSmsDeliveryFailure,
  type DialpadSmsPayload,
} from "../routes/webhooks/dialpad-sms";
import type { DialpadCallEvent } from "../dialpad/types";

const log = logger("DialpadEventPoller");

/**
 * Database-backed poller that picks up unprocessed Dialpad webhook_events
 * and feeds them into the in-process worker queue.
 *
 * Why this exists
 * ---------------
 * The webhook handler writes a `webhook_events` row (processed=false), acks
 * 200 to Dialpad immediately, and enqueues an in-memory job. If the process
 * dies before that job runs (deploy, crash, OOM) — or if a bug causes a
 * single in-flight job to wedge — the row would otherwise sit unprocessed
 * forever (Dialpad does not retry already-acked events).
 *
 * This poller scans for unprocessed Dialpad rows using the partial index
 * `webhook_events_unprocessed_idx` (WHERE processed = false), so the query
 * stays cheap as the table grows. Rows already in flight in this process are
 * skipped via `isDialpadEventInFlight`. Rows whose in-flight stamp has expired
 * (TTL in the worker) are reclaimed and re-enqueued — both call and SMS
 * handlers are idempotent, so re-processing is safe.
 *
 * Adaptive scheduling
 * -------------------
 * Rather than waking every 15 s around the clock, the poller self-schedules a
 * single `setTimeout`: it polls at MIN_POLL_MS while it keeps finding work,
 * and backs off geometrically toward MAX_POLL_MS while idle. A cheap cached
 * `hasAnyEnabledIntegration('dialpad')` gate short-circuits the DB query when
 * no contractor has Dialpad enabled (there can be no dialpad webhook_events in
 * that case). The webhook handlers call `nudge()` after inserting a row, which
 * invalidates the gate and snaps the next poll back to MIN_POLL_MS so recovery
 * stays prompt. The first tick runs `RUN_IMMEDIATELY_AFTER_MS` after start so
 * post-restart recovery does not wait a full interval.
 */

const MIN_POLL_MS = 15_000;
const MAX_POLL_MS = 5 * 60_000;
const RUN_IMMEDIATELY_AFTER_MS = 1_000;
const MAX_ROWS_PER_TICK = 100;

interface UnprocessedRow {
  id: string;
  contractorId: string | null;
  eventType: string;
  payload: string;
}

export class DialpadEventPoller {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private ticking = false;
  private nudged = false;
  private currentDelay = MIN_POLL_MS;

  start(): void {
    if (this.running) return;
    this.running = true;
    this.currentDelay = MIN_POLL_MS;
    // Kick off the first scan promptly so post-restart recovery does not wait
    // a full interval.
    this.schedule(RUN_IMMEDIATELY_AFTER_MS);
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Reset the schedule to poll soon. Called by the Dialpad webhook handlers
   * after they insert a `webhook_events` row so recovery does not wait out the
   * current (possibly backed-off) sleep. Also invalidates the integration-
   * presence gate so a freshly-enabled Dialpad integration is picked up at
   * once instead of after the cache TTL.
   */
  nudge(): void {
    if (!this.running) return;
    invalidateIntegrationPresence("dialpad");
    this.currentDelay = MIN_POLL_MS;
    if (this.ticking) {
      this.nudged = true;
      return;
    }
    this.schedule(MIN_POLL_MS);
  }

  private schedule(delayMs: number): void {
    if (!this.running) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.tick();
    }, delayMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    this.ticking = true;
    this.nudged = false;
    let foundWork = false;
    try {
      foundWork = await this.runOnce();
    } catch (err) {
      log.error(`Poll tick failed: ${formatDbError(err)}`);
    } finally {
      this.ticking = false;
      let nextDelay: number;
      if (this.nudged) {
        this.nudged = false;
        nextDelay = MIN_POLL_MS;
      } else if (foundWork) {
        // Still draining — poll again at the fast interval.
        nextDelay = MIN_POLL_MS;
      } else {
        // Idle — back off geometrically toward the cap.
        nextDelay = Math.min(this.currentDelay * 2, MAX_POLL_MS);
      }
      this.currentDelay = nextDelay;
      this.schedule(nextDelay);
    }
  }

  /**
   * Runs a single recovery scan. Returns true when at least one row was
   * enqueued, so the scheduler knows to keep polling fast.
   */
  async runOnce(): Promise<boolean> {
    // Cheap cached gate: if no contractor has Dialpad enabled there can be no
    // dialpad webhook_events to recover, so skip the indexed query entirely.
    if (!(await hasAnyEnabledIntegration("dialpad"))) {
      return false;
    }

    let rows: UnprocessedRow[];
    try {
      rows = await db
        .select({
          id: webhookEvents.id,
          contractorId: webhookEvents.contractorId,
          eventType: webhookEvents.eventType,
          payload: webhookEvents.payload,
        })
        .from(webhookEvents)
        .where(
          and(
            eq(webhookEvents.service, "dialpad"),
            eq(webhookEvents.processed, false),
            // Permanently-failed rows are terminal — stamped with failed_at
            // by the worker after MAX_ATTEMPTS or by markPollerFailure below
            // when the row cannot be dispatched. Skipping them here is what
            // prevents an infinite retry loop on a row the worker has given
            // up on.
            isNull(webhookEvents.failedAt),
          ),
        )
        .orderBy(asc(webhookEvents.createdAt))
        .limit(MAX_ROWS_PER_TICK);
    } catch (err) {
      log.error(
        `Failed to query unprocessed dialpad webhook events: ${formatDbError(err)}`,
      );
      recordPollerOutcome(false);
      return false;
    }

    recordPollerOutcome(true);

    if (rows.length === 0) return false;

    let enqueued = 0;
    let skippedInFlight = 0;
    let failed = 0;

    for (const row of rows) {
      if (isDialpadEventInFlight(row.id)) {
        skippedInFlight++;
        continue;
      }

      if (!row.contractorId) {
        await markPollerFailure(row.id, "missing contractorId on poll");
        failed++;
        continue;
      }

      let payload: unknown;
      try {
        payload = JSON.parse(row.payload);
      } catch (err) {
        await markPollerFailure(
          row.id,
          `payload JSON parse failed on poll: ${err instanceof Error ? err.message : String(err)}`,
        );
        failed++;
        continue;
      }

      const contractorId = row.contractorId;
      const webhookEventId = row.id;
      const eventType = row.eventType;

      if (eventType.startsWith("call.")) {
        const callPayload = payload as DialpadCallEvent;
        enqueueDialpadEvent({
          webhookEventId,
          description: `polled dialpad-call ${eventType} ${webhookEventId}`,
          handler: () =>
            processDialpadCallEvent(callPayload, contractorId, webhookEventId),
        });
        enqueued++;
      } else if (eventType === "sms.status_update") {
        const smsPayload = payload as DialpadSmsPayload;
        enqueueDialpadEvent({
          webhookEventId,
          description: `polled dialpad-sms ${eventType} ${webhookEventId}`,
          handler: () =>
            processSmsDeliveryFailure(smsPayload, contractorId, webhookEventId),
        });
        enqueued++;
      } else if (eventType.startsWith("sms.")) {
        const smsPayload = payload as DialpadSmsPayload;
        enqueueDialpadEvent({
          webhookEventId,
          description: `polled dialpad-sms ${eventType} ${webhookEventId}`,
          handler: () =>
            processSmsMessageEvent(smsPayload, contractorId, webhookEventId),
        });
        enqueued++;
      } else {
        await markPollerFailure(
          row.id,
          `unknown dialpad eventType on poll: ${eventType}`,
        );
        failed++;
      }
    }

    if (enqueued > 0 || failed > 0) {
      log.info(
        `Poll: enqueued=${enqueued}, skipped_in_flight=${skippedInFlight}, failed=${failed} (scanned=${rows.length})`,
      );
    }

    return enqueued > 0;
  }
}

/**
 * Process-wide singleton. The webhook handlers import this to `nudge()` after
 * inserting a row, and `index.ts` starts/stops it during boot/shutdown.
 */
export const dialpadEventPoller = new DialpadEventPoller();

async function markPollerFailure(id: string, reason: string): Promise<void> {
  try {
    // Same convention as the worker: leave processed=false and stamp
    // failed_at so the audit log shows a permanent failure, not a success.
    await db
      .update(webhookEvents)
      .set({
        // Defensive: explicitly assert the non-success terminal state so a
        // hypothetical concurrent processed=true never coexists with a
        // failed_at stamp on the same row.
        processed: false,
        processedAt: null,
        failedAt: new Date(),
        errorMessage: reason,
      })
      .where(eq(webhookEvents.id, id));
  } catch (err) {
    log.error(
      `Failed to mark webhook_event ${id} as poll-failed: ${formatDbError(err)}`,
    );
  }
}
