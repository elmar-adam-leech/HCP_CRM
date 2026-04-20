import { db } from "../db";
import { webhookEvents } from "@shared/schema";
import { eq } from "drizzle-orm";
import { logger } from "../utils/logger";
import { formatDbError } from "../utils/db-error";

const log = logger("DialpadEventWorker");

/**
 * In-process background worker for Dialpad webhook events.
 *
 * Why: Dialpad imposes a short timeout on webhook responses. Doing the full
 * DB lookup / contact match / activity create + websocket broadcast inline
 * before responding 200 means a slow query causes Dialpad to retry, which
 * multiplies our work. We now ack with 200 immediately after writing the
 * audit row in `webhook_events`, then process the event from this queue.
 *
 * Failures retry with exponential backoff. Final failures are surfaced by
 * stamping `failed_at` on the corresponding `webhook_events` row (along
 * with an `errorMessage`) and leaving `processed=false`. This keeps the
 * audit log honest: only rows that actually completed successfully end up
 * with `processed=true`. The poller treats `failed_at IS NOT NULL` as
 * terminal so it does not retry these rows in a loop.
 *
 * The in-memory queue is layered on top of a database-backed driver: the
 * `DialpadEventPoller` periodically scans `webhook_events` for unprocessed
 * Dialpad rows and enqueues any that are not currently in flight. This
 * means events survive restarts and stuck rows are picked up automatically
 * once the in-flight TTL elapses, without requiring a process restart.
 */

type Handler = () => Promise<void>;

interface QueuedJob {
  webhookEventId: string;
  description: string;
  handler: Handler;
  attempt: number;
}

const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 500;
const MAX_CONCURRENCY = 4;

/**
 * How long a webhookEventId is considered "in flight" by this process. The
 * poller will not re-enqueue an event whose in-flight timestamp is newer
 * than this. After the TTL elapses, the poller assumes the in-process
 * attempt is wedged (long-running query, network hang, etc.) and re-enqueues
 * the row. Re-processing is safe because both call and SMS handlers are
 * idempotent (they look up by external id and either enrich or skip).
 */
const IN_FLIGHT_TTL_MS = 5 * 60 * 1000;

const queue: QueuedJob[] = [];
let running = 0;

/**
 * Map of webhookEventId → epoch ms when it most recently entered the queue
 * or began executing. Used by the poller to skip events that this process
 * is already handling.
 */
const inFlight = new Map<string, number>();

function markInFlight(id: string): void {
  inFlight.set(id, Date.now());
}

function clearInFlight(id: string): void {
  inFlight.delete(id);
}

/**
 * True if the given webhookEventId is currently queued or running in this
 * process and its in-flight stamp has not exceeded the TTL.
 */
export function isDialpadEventInFlight(id: string): boolean {
  const ts = inFlight.get(id);
  if (ts === undefined) return false;
  if (Date.now() - ts > IN_FLIGHT_TTL_MS) {
    inFlight.delete(id);
    return false;
  }
  return true;
}

function pump(): void {
  while (running < MAX_CONCURRENCY && queue.length > 0) {
    const job = queue.shift()!;
    running++;
    runJob(job).finally(() => {
      running--;
      pump();
    });
  }
}

function schedule(job: QueuedJob, delayMs = 0): void {
  markInFlight(job.webhookEventId);
  if (delayMs > 0) {
    setTimeout(() => {
      queue.push(job);
      pump();
    }, delayMs);
    return;
  }
  queue.push(job);
  pump();
}

async function runJob(job: QueuedJob): Promise<void> {
  // Refresh the in-flight stamp at the start of each attempt so a long
  // retry chain doesn't get reclaimed by the poller mid-execution.
  markInFlight(job.webhookEventId);
  try {
    await job.handler();
    clearInFlight(job.webhookEventId);
  } catch (err) {
    const detail = formatDbError(err);
    const shortMessage = err instanceof Error ? err.message : String(err);
    log.error(
      `[${job.description}] attempt ${job.attempt}/${MAX_ATTEMPTS} failed: ${detail}`,
    );

    if (job.attempt < MAX_ATTEMPTS) {
      const delay = BASE_BACKOFF_MS * 2 ** (job.attempt - 1);
      schedule({ ...job, attempt: job.attempt + 1 }, delay);
      return;
    }

    // Final failure — record it on the audit row so it surfaces in the
    // existing webhook_events views/tools. We deliberately leave
    // `processed=false` and instead stamp `failed_at` so the audit log
    // distinguishes "successfully processed" from "permanently failed",
    // and so the backlog checker can count failures separately. The poller
    // skips rows with a non-null `failed_at`, so this row will not be
    // re-enqueued in a loop.
    try {
      await db
        .update(webhookEvents)
        .set({
          // Set processed=false defensively (alongside failedAt) so the
          // terminal states stay mutually exclusive even if some upstream
          // path or race ever flips processed=true on this row.
          processed: false,
          processedAt: null,
          failedAt: new Date(),
          errorMessage: `Background processing failed after ${MAX_ATTEMPTS} attempts: ${shortMessage}`,
        })
        .where(eq(webhookEvents.id, job.webhookEventId));
    } catch (dbErr) {
      log.error(
        `[${job.description}] failed to mark webhook_event ${job.webhookEventId} as failed: ${formatDbError(dbErr)}`,
      );
    } finally {
      clearInFlight(job.webhookEventId);
    }
  }
}

export function enqueueDialpadEvent(opts: {
  webhookEventId: string;
  description: string;
  handler: Handler;
}): void {
  schedule({ ...opts, attempt: 1 });
}

/**
 * Test-only: wait until the queue is fully drained.
 */
export async function waitForDialpadQueueDrain(
  timeoutMs = 30_000,
): Promise<void> {
  const start = Date.now();
  while ((queue.length > 0 || running > 0) && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 25));
  }
}
