/**
 * Standalone background-job worker for Replit Scheduled Deployments.
 *
 * Task #802: the periodic background jobs that used to run on always-on in-app
 * timers inside the Autoscale web app are moved here so the web app can scale
 * to zero when idle. Each job is invoked once per process, runs under a
 * Postgres advisory lock (so two scheduled invocations — or an in-app timer
 * during the migration window — cannot overlap), and the process exits when
 * done so the scheduled deployment can spin back down.
 *
 * Usage (set as the Scheduled Deployment run command):
 *
 *   NODE_ENV=production npx tsx server/worker.ts <job[,job...]>
 *
 * Jobs of the same cadence can be grouped into one scheduled deployment by
 * passing a comma-separated list, e.g. `sync,sales,workflows`. Each job in the
 * list runs sequentially under its own advisory lock.
 *
 * Available jobs (recommended cadence):
 *   sync        — due integration syncs + schedule recovery     (~every 1–5 min)
 *   sales       — due auto-mode sales-process tasks             (~every 1–5 min)
 *   workflows   — resume suspended workflow executions          (~every 1 min)
 *   dialpad     — recover unprocessed Dialpad webhook events    (~every 1–5 min)
 *   health      — HCP + Dialpad webhook/call health checks      (~every 5–15 min)
 *   ad-spend    — pull ad spend for the ROI report              (~every 6 h)
 *   cleanup     — delete orphaned messages/activities + webhooks (~daily)
 *   maintenance — consolidated daily maintenance pass            (~daily, off-peak)
 *
 * NOTE: this entrypoint intentionally does NOT call initDb() — it never runs
 * DDL (the web app owns schema migrations on boot). The DB pool is live as soon
 * as ./db is imported, so importing the job modules is all that is required.
 */

import { pool } from "./db";
import { withJobLock } from "./jobs/job-lock";
import { logger } from "./utils/logger";
import { formatDbError } from "./utils/db-error";

const log = logger("Worker");

// Hard watchdog: a wedged job must not hold the scheduled deployment open
// forever. Defaults to 10 minutes; tune via WORKER_JOB_TIMEOUT_MS.
const JOB_TIMEOUT_MS = Number(process.env.WORKER_JOB_TIMEOUT_MS ?? 10 * 60 * 1000);

type JobFn = () => Promise<void>;

async function runSync(): Promise<void> {
  const { syncScheduler } = await import("./sync-scheduler");
  await syncScheduler.runOnce();
}

async function runSales(): Promise<void> {
  const { runDueAutoTasksOnce } = await import("./services/sales-process-cron");
  // Drain due tasks in bounded batches so a single invocation clears the
  // backlog instead of leaving work for the next cron tick. Each call claims
  // up to BATCH_LIMIT rows atomically; stop as soon as a pass claims nothing.
  const MAX_BATCHES = 50;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const summary = await runDueAutoTasksOnce({});
    if (summary.claimed === 0) break;
  }
}

async function runWorkflows(): Promise<void> {
  const { workflowEngine } = await import("./workflow-engine");
  await workflowEngine.runSuspendedPollOnce();
}

async function runDialpad(): Promise<void> {
  const { dialpadEventPoller } = await import("./jobs/dialpad-event-poller");
  const { waitForDialpadQueueDrain } = await import("./jobs/dialpad-event-worker");
  // runOnce() scans webhook_events for unprocessed Dialpad rows and enqueues
  // them onto the in-process worker queue; we must wait for that queue to drain
  // before the process exits or the recovered work would be lost.
  await dialpadEventPoller.runOnce();
  await waitForDialpadQueueDrain(Math.max(JOB_TIMEOUT_MS - 5_000, 5_000));
}

async function runHealth(): Promise<void> {
  const { checkHcpWebhookHealth } = await import("./services/hcp-webhook-health");
  const { checkDialpadCallHealth, checkDialpadBacklog } = await import("./services/dialpad-call-health");
  // Run all three each invocation. Alerts are throttled internally, so running
  // the staleness check more often than its former 6 h cadence is harmless.
  await checkHcpWebhookHealth();
  await checkDialpadCallHealth();
  await checkDialpadBacklog();
}

async function runAdSpend(): Promise<void> {
  const { runAdSpendSync } = await import("./services/ad-spend-sync");
  await runAdSpendSync();
}

async function runCleanup(): Promise<void> {
  const { messageCleanupService } = await import("./services/message-cleanup");
  await messageCleanupService.performCleanup();
}

async function runMaintenance(): Promise<void> {
  const { runDailyMaintenance } = await import("./services/maintenance-job");
  await runDailyMaintenance();
}

const JOBS: Record<string, JobFn> = {
  sync: runSync,
  sales: runSales,
  workflows: runWorkflows,
  dialpad: runDialpad,
  health: runHealth,
  "ad-spend": runAdSpend,
  cleanup: runCleanup,
  maintenance: runMaintenance,
};

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (!arg) {
    log.error(`Usage: worker <job[,job...]> — available: ${Object.keys(JOBS).join(", ")}`);
    process.exit(2);
  }

  const names = arg.split(",").map((s) => s.trim()).filter(Boolean);
  for (const n of names) {
    if (!JOBS[n]) {
      log.error(`Unknown job "${n}" — available: ${Object.keys(JOBS).join(", ")}`);
      process.exit(2);
    }
  }

  const watchdog = setTimeout(() => {
    log.error(`Worker timed out after ${JOB_TIMEOUT_MS}ms running [${names.join(", ")}] — forcing exit`);
    process.exit(1);
  }, JOB_TIMEOUT_MS);
  watchdog.unref();

  log.info(`Worker starting jobs: [${names.join(", ")}]`);

  let hadError = false;
  for (const name of names) {
    const startedAt = Date.now();
    try {
      const { ran } = await withJobLock(`worker:${name}`, JOBS[name]);
      if (ran) {
        log.info(`Job "${name}" completed in ${Date.now() - startedAt}ms`);
      } else {
        log.info(`Job "${name}" skipped (advisory lock held by another invocation)`);
      }
    } catch (err) {
      hadError = true;
      log.error(`Job "${name}" failed: ${formatDbError(err)}`);
    }
  }

  clearTimeout(watchdog);

  try {
    await pool.end();
  } catch (err) {
    log.error(`Failed to close DB pool cleanly: ${formatDbError(err)}`);
  }

  process.exit(hadError ? 1 : 0);
}

main().catch((err) => {
  log.error(`Worker fatal: ${formatDbError(err)}`);
  process.exit(1);
});
