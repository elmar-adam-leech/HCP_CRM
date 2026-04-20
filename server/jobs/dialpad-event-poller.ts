import { db } from "../db";
import { webhookEvents } from "@shared/schema";
import { and, asc, eq, isNull } from "drizzle-orm";
import { logger } from "../utils/logger";
import { formatDbError } from "../utils/db-error";
import { BackgroundJob } from "../services/background-job";
import { recordPollerOutcome } from "../services/dialpad-call-health";
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
 * This poller scans every `POLL_INTERVAL_MS` for unprocessed Dialpad rows
 * using the partial index `webhook_events_unprocessed_idx` (WHERE
 * processed = false), so the query stays cheap as the table grows. Rows
 * already in flight in this process are skipped via
 * `isDialpadEventInFlight`. Rows whose in-flight stamp has expired (TTL in
 * the worker) are reclaimed and re-enqueued — both call and SMS handlers
 * are idempotent, so re-processing is safe.
 *
 * Replaces the previous boot-only recovery scan. The poller's first tick
 * runs `RUN_IMMEDIATELY_AFTER_MS` after start so recovery happens promptly
 * after a restart instead of waiting a full poll interval.
 */

const POLL_INTERVAL_MS = 15_000;
const RUN_IMMEDIATELY_AFTER_MS = 1_000;
const MAX_ROWS_PER_TICK = 100;

interface UnprocessedRow {
  id: string;
  contractorId: string | null;
  eventType: string;
  payload: string;
}

export class DialpadEventPoller extends BackgroundJob {
  private initialRunHandle: NodeJS.Timeout | null = null;

  constructor() {
    super(POLL_INTERVAL_MS);
  }

  start(): void {
    super.start();
    // Kick off the first scan promptly so post-restart recovery does not
    // wait a full interval. Errors are logged but never thrown. The handle
    // is tracked so stop() can cancel it during a rapid shutdown window.
    this.initialRunHandle = setTimeout(() => {
      this.initialRunHandle = null;
      this.runOnce().catch((err) => {
        log.error(
          `Initial poll failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }, RUN_IMMEDIATELY_AFTER_MS);
  }

  stop(): void {
    if (this.initialRunHandle !== null) {
      clearTimeout(this.initialRunHandle);
      this.initialRunHandle = null;
    }
    super.stop();
  }

  protected async runOnce(): Promise<void> {
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
      return;
    }

    recordPollerOutcome(true);

    if (rows.length === 0) return;

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
  }
}

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
