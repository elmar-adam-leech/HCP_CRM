import { storage } from "../storage";
import { logger } from "../utils/logger";
import { formatDbError } from "../utils/db-error";

const log = logger('WorkflowEngine');

/**
 * Recover zombie workflow executions left behind by a previous server crash or restart.
 *
 * Delay and wait_until steps do NOT use setTimeout — they write a "suspended"
 * execution row to the DB with a resumeAt timestamp and return immediately.
 * The startSuspendedPoller() loop resumes them automatically on any server (re)start.
 *
 * This function therefore only needs to handle truly stuck "running" executions:
 * rows whose process was killed mid-step (OOM, ungraceful shutdown) and never
 * transitioned out of "running" status. Those will never self-resolve.
 *
 * Should be called once at server startup. It marks all "running" executions that
 * were created more than `staleThresholdMinutes` ago as "failed" with a clear reason.
 *
 * @param staleThresholdMinutes - Executions older than this (default 24 h) are considered stale.
 *   24 hours is intentionally generous: a legitimate long-running execution (e.g. many steps
 *   with AI calls) is unlikely to take longer than a few minutes. Any execution still "running"
 *   after 24 hours was almost certainly orphaned by a process kill.
 */
export async function recoverZombieExecutions(staleThresholdMinutes = 1440): Promise<void> {
  try {
    const olderThan = new Date(Date.now() - staleThresholdMinutes * 60 * 1000);
    const stale = await storage.getStaleRunningExecutions(olderThan);

    if (stale.length === 0) {
      log.info('Zombie execution recovery: no stale executions found');
      return;
    }

    log.warn(`Zombie execution recovery: marking ${stale.length} stale execution(s) as failed`);

    for (const execution of stale) {
      try {
        await storage.updateWorkflowExecution(
          execution.id,
          {
            status: 'failed',
            errorMessage: 'Server restarted while execution was in progress (delay or wait action was active)',
            completedAt: new Date(),
          },
          execution.contractorId
        );
        log.info(`Marked zombie execution ${execution.id} (workflow ${execution.workflowId}) as failed`);
      } catch (err) {
        log.error(`Failed to mark zombie execution ${execution.id}: ${formatDbError(err)}`);
      }
    }
  } catch (error) {
    log.error(`Error during zombie execution recovery: ${formatDbError(error)}`);
  }
}
