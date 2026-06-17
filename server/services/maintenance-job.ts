import cron from "node-cron";
import { and, or, eq, lt, isNotNull } from "drizzle-orm";
import { db } from "../db";
import { oauthStates, webhookEvents } from "@shared/schema";
import { storage } from "../storage";
import { AuthService } from "../auth-service";
import { pruneExpiredRateLimitEntries } from "../middleware/rate-limiter";
import { pruneExpiredAuthCacheEntries } from "./auth-cache";
import { leadCaptureMethods } from "../storage/lead-capture";
import {
  SPAM_AUDIT_RETENTION_DAYS,
  SPAM_AUDIT_RETENTION_MS,
} from "@shared/constants/spam-audit-retention";
import { runRetentionCheck } from "./retention-job";
import { logger } from "../utils/logger";
import { formatDbError } from "../utils/db-error";

const log = logger("MaintenanceJob");

const WEBHOOK_EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Consolidated daily maintenance pass.
 *
 * Previously the server ran a fistful of independent cleanup timers — an
 * auth-cache sweeper every 60 s, a rate-limit sweep every 5 min, gmail OAuth
 * state cleanup hourly, revoked-token cleanup hourly, plus daily refresh-token,
 * spam-audit, webhook-events and retention jobs. Each one woke the process on
 * its own schedule, which kept an otherwise-idle Autoscale instance burning CPU
 * around the clock.
 *
 * They are now folded into a single pass that runs once per day at 3 AM UTC
 * (the same off-peak slot the data-retention job already used). Every step
 * keeps its original delete logic and safety bounds and is individually
 * try/caught so one failing step never blocks the others. The in-memory sweeps
 * (auth-cache, rate-limit) are safe to run only daily because both stores
 * self-expire on read and are LRU/FIFO bounded — the sweep is purely
 * memory reclamation, not a correctness requirement.
 */
async function runStep(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    log.error(`[${name}] ${formatDbError(err)}`);
  }
}

async function cleanupExpiredOAuthStates(): Promise<void> {
  const result = await db.delete(oauthStates).where(lt(oauthStates.expiresAt, new Date()));
  const deleted = result.rowCount || 0;
  if (deleted > 0) log.info(`Pruned ${deleted} expired oauth_states row(s)`);
}

async function cleanupExpiredRefreshTokens(): Promise<void> {
  const deleted = await storage.deleteExpiredRefreshTokens();
  if (deleted > 0) log.info(`Deleted ${deleted} expired refresh_tokens row(s)`);
}

async function pruneSpamAuditLogs(): Promise<void> {
  const cutoff = new Date(Date.now() - SPAM_AUDIT_RETENTION_MS);
  const inboxes = await leadCaptureMethods.getAllActiveLeadCaptureInboxes();
  let totalDeleted = 0;
  for (const inbox of inboxes) {
    totalDeleted += await leadCaptureMethods.pruneSpamAuditLog(inbox.contractorId, cutoff);
  }
  if (totalDeleted > 0) {
    log.info(`Pruned ${totalDeleted} spam_audit_log row(s) older than ${SPAM_AUDIT_RETENTION_DAYS} days`);
  }
}

async function cleanupOldWebhookEvents(): Promise<void> {
  // Terminal rows only: succeeded (processed=true) or permanently failed
  // (failed_at IS NOT NULL). Pending rows are retained so the poller can keep
  // retrying them.
  const cutoff = new Date(Date.now() - WEBHOOK_EVENT_RETENTION_MS);
  await db.delete(webhookEvents).where(
    and(
      or(eq(webhookEvents.processed, true), isNotNull(webhookEvents.failedAt)),
      lt(webhookEvents.createdAt, cutoff),
    ),
  );
}

export async function runDailyMaintenance(): Promise<void> {
  log.info("Running daily maintenance pass...");
  await runStep("auth-cache", async () => pruneExpiredAuthCacheEntries());
  await runStep("rate-limit", async () => pruneExpiredRateLimitEntries());
  await runStep("gmail-oauth-states", cleanupExpiredOAuthStates);
  await runStep("refresh-tokens", cleanupExpiredRefreshTokens);
  await runStep("revoked-tokens", () => AuthService.cleanupExpiredRevokedTokens());
  await runStep("spam-audit", pruneSpamAuditLogs);
  await runStep("webhook-events", cleanupOldWebhookEvents);
  await runStep("retention", runRetentionCheck);
  log.info("Daily maintenance pass complete");
}

let task: ReturnType<typeof cron.schedule> | null = null;

export function startMaintenanceJob(): void {
  if (task) return;
  task = cron.schedule(
    "0 3 * * *",
    () => {
      runDailyMaintenance().catch((err) =>
        log.error(`Maintenance pass error: ${formatDbError(err)}`),
      );
    },
    { timezone: "UTC" },
  );
  log.info("Daily maintenance job scheduled (3 AM UTC)");
}

export function stopMaintenanceJob(): void {
  if (task) {
    task.stop();
    task = null;
  }
}
