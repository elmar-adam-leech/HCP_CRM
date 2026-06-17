import { storage } from "../storage";
import { logger } from "../utils/logger";
import { formatDbError } from "../utils/db-error";

const log = logger('WorkflowEngine');

type ResumeCallback = (executionId: string, contractorId: string) => Promise<void>;

const POLLER_MIN_MS = 30_000;
const POLLER_MAX_MS = 5 * 60_000; // 5 minutes

/**
 * Adaptive backoff poller for suspended workflow executions.
 *
 * Polls the DB for suspended executions whose resumeAt time has passed, then
 * calls the provided resumeCallback for each. Uses exponential backoff when idle
 * to avoid unnecessary DB queries, and snaps back to minimum interval when
 * nudgePoller() is called after a new execution is queued.
 */
export class SuspendedExecutionPoller {
  private _pollerTimer: NodeJS.Timeout | null = null;
  private _pollerBackoffMs = POLLER_MIN_MS;
  private readonly _resumeCallback: ResumeCallback;

  // Guards against re-scheduling after stop() is called.
  // Once set to false, _schedulePoll() becomes a no-op so that an in-flight
  // poll cycle completing *after* stop() cannot queue new work during teardown.
  private _isRunning = false;

  constructor(resumeCallback: ResumeCallback) {
    this._resumeCallback = resumeCallback;
  }

  /**
   * Start the poller. Should be called once at server startup.
   */
  start(): void {
    this._isRunning = true;
    this._pollerBackoffMs = POLLER_MIN_MS;
    this._schedulePoll();
  }

  /**
   * Stop the poller definitively. Call during graceful shutdown to prevent
   * new poll cycles from being scheduled after SIGTERM/SIGINT is received.
   *
   * Sets an internal `_isRunning = false` flag that is checked at the tail of
   * every poll callback, so even if a poll is already in-flight when stop() is
   * called, no further rescheduling occurs once that callback returns.
   */
  stop(): void {
    this._isRunning = false;
    if (this._pollerTimer) {
      clearTimeout(this._pollerTimer);
      this._pollerTimer = null;
    }
  }

  /**
   * Nudge the poller to run immediately (resets backoff to minimum).
   * Call this after queuing a new workflow execution so delayed steps are picked up promptly.
   */
  nudge(): void {
    if (!this._isRunning) return;
    if (this._pollerTimer) {
      clearTimeout(this._pollerTimer);
      this._pollerTimer = null;
    }
    this._pollerBackoffMs = POLLER_MIN_MS;
    this._schedulePoll();
  }

  private _schedulePoll(): void {
    // No-op if stop() has been called — prevents rescheduling after shutdown.
    if (!this._isRunning) return;

    this._pollerTimer = setTimeout(async () => {
      this._pollerTimer = null;
      let foundDue = false;
      try {
        const due = await storage.getSuspendedExecutions();
        foundDue = due.length > 0;
        // Resumes are kicked off fire-and-forget here to preserve the adaptive
        // poller's original non-blocking timing (the returned promises are
        // intentionally not awaited on this path).
        await this._claimAndResumeAll(due);
      } catch (err) {
        log.error(`Suspended execution poller error: ${formatDbError(err)}`);
      }

      // Adaptive backoff: snap to min when there was work to do; double when idle
      if (foundDue) {
        this._pollerBackoffMs = POLLER_MIN_MS;
      } else {
        this._pollerBackoffMs = Math.min(this._pollerBackoffMs * 2, POLLER_MAX_MS);
      }

      // Re-schedule only if not stopped. The _isRunning guard here covers the
      // race where stop() is called while the async poll body above was awaiting.
      this._schedulePoll();
    }, this._pollerBackoffMs);
  }

  /**
   * Claim each due execution (atomic suspended → running transition) and kick
   * off its resume callback. Returns the resume promises so callers that need
   * to wait for completion (the one-shot worker via pollOnce) can await them;
   * the in-app adaptive poller ignores them to keep its original
   * fire-and-forget timing.
   *
   * The atomic claim makes overlap safe: if two cycles (or a scheduled-job run
   * and an in-app tick) see the same row, only ONE receives a non-undefined
   * result and resumes it; the loser skips, preventing double-execution.
   */
  private async _claimAndResumeAll(
    due: Awaited<ReturnType<typeof storage.getSuspendedExecutions>>,
  ): Promise<Promise<void>[]> {
    const resumes: Promise<void>[] = [];
    for (const execution of due) {
      const claimed = await storage.claimSuspendedExecution(execution.id, execution.contractorId);
      if (!claimed) {
        log.info(`Poller: execution ${execution.id} already claimed by another cycle — skipping`);
        continue;
      }
      log.info(`Poller: claimed and resuming execution ${execution.id} (was due ${execution.resumeAt?.toISOString()})`);
      resumes.push(
        this._resumeCallback(execution.id, execution.contractorId).catch(err => {
          log.error(`Poller: error resuming execution ${execution.id}: ${formatDbError(err)}`);
        }),
      );
    }
    return resumes;
  }

  /**
   * Run a single poll pass and AWAIT every resume before returning. Used by the
   * standalone worker entrypoint (server/worker.ts) so suspended workflows can
   * be resumed from a Replit Scheduled Deployment instead of an always-on
   * in-app timer. Returns the number of due executions found.
   */
  async pollOnce(): Promise<number> {
    const due = await storage.getSuspendedExecutions();
    const resumes = await this._claimAndResumeAll(due);
    await Promise.allSettled(resumes);
    return due.length;
  }
}
