import express, { type Request, Response, NextFunction } from "express";
import compression from "compression";
import helmet from "helmet";
import { ZodError } from "zod";
import { registerRoutes } from "./routes";
import { setupVite, serveStatic, log } from "./vite";
import { providerService } from "./providers/provider-service";
import { syncScheduler } from "./sync-scheduler";
import { messageCleanupService } from "./services/message-cleanup";
import { AuthService } from "./auth-service";
import { startAuthCacheSweeper } from "./services/auth-cache";
import { workflowEngine } from "./workflow-engine";
import { initDb, db, pool } from "./db";
import { startHcpWebhookHealthCheck, stopHcpWebhookHealthCheck } from "./services/hcp-webhook-health";
import { startDialpadCallHealthCheck, stopDialpadCallHealthCheck } from "./services/dialpad-call-health";
import { startRetentionJob } from "./services/retention-job";
import { DialpadEventPoller } from "./jobs/dialpad-event-poller";
import { stopWebSocket } from "./websocket";
import { GmailOAuthCleanupJob } from "./services/gmail-oauth-cleanup-job";
import { RateLimitCleanupJob } from "./services/rate-limit-cleanup-job";
import { SpamAuditCleanupJob } from "./services/spam-audit-cleanup-job";
import { RefreshTokenCleanupJob } from "./services/refresh-token-cleanup-job";
import { AdSpendSyncJob } from "./services/ad-spend-sync-job";
import { webhookEvents } from "@shared/schema";
import { and, eq, lt, or, isNotNull, sql } from "drizzle-orm";
import { CredentialService } from "./credential-service";
import { recordRequest, normalizePath } from "./services/latency-stats";

// ─── Startup crash visibility ─────────────────────────────────────────────
// The server is bundled as ESM (`esbuild --format=esm`). Without these
// handlers, an unhandled rejection or uncaught exception during startup
// causes Node to exit silently with code 13 ("Unfinished Top-Level Await")
// and no stack trace — making production crash-loops impossible to debug.
// Write directly to stderr (not the structured logger) so the message is
// flushed even if the logger module hasn't fully initialised yet.
function logFatalAndExit(label: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error && err.stack ? err.stack : '(no stack)';
  process.stderr.write(`[${label}] ${message}\n${stack}\n`);
  process.exit(1);
}
process.on('unhandledRejection', (reason) => logFatalAndExit('unhandledRejection', reason));
process.on('uncaughtException',  (err)    => logFatalAndExit('uncaughtException',  err));

const app = express();
const isProd = process.env.NODE_ENV === "production";

// Slow-request WARN threshold: any /api request exceeding this is logged with
// method, route key, status, duration, and contractorId (when authenticated).
// Configurable via SLOW_REQUEST_THRESHOLD_MS (defaults to 500ms). Tuned for
// "human-noticeable" latency — not for paging anyone.
const SLOW_REQUEST_THRESHOLD_MS = parseInt(
  process.env.SLOW_REQUEST_THRESHOLD_MS || '500',
  10,
);

// Content Security Policy
// Production: no 'unsafe-inline' or 'unsafe-eval' in script-src — the Vite
//   production build emits only external module scripts, so neither is needed.
// Development: Vite HMR injects inline scripts, so both must be allowed.
// connect-src includes 'wss:' so the app's /ws WebSocket and Vite HMR both work.
// HSTS: preload allows the site to be registered in browser preload lists so
//   the very first connection is also forced to HTTPS (not just redirected).
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: isProd
        ? ["'self'", "https://replit.com"]
        : ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://replit.com"],
      styleSrc:   ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc:    ["'self'", "https://fonts.gstatic.com", "data:"],
      imgSrc:     ["'self'", "data:", "blob:", "https:"],
      connectSrc: ["'self'", "wss:", "https:"],
      frameSrc:   ["'none'"],
      objectSrc:  ["'none'"],
    },
  },
  hsts: {
    maxAge: 31536000,        // 1 year — required minimum for preload list
    includeSubDomains: true, // required for preload list
    preload: true,           // opt in to HSTS preload lists (hstspreload.org)
  },
}));
app.set("trust proxy", 1);
const hcpWebhookPattern = /^\/api\/webhooks\/[^/]+\/housecall-pro\/?$/;
app.use((req, res, next) => {
  if (hcpWebhookPattern.test(req.path)) {
    return express.raw({ type: 'application/json' })(req, res, next);
  }
  next();
});
app.use((req, res, next) => {
  if (hcpWebhookPattern.test(req.path)) {
    return next();
  }
  return express.json()(req, res, next);
});
app.use(express.urlencoded({ extended: false }));

// gzip-compress responses (HTML, JS, CSS, JSON). Registered AFTER the raw-body
// HCP webhook branch and the standard body parsers so it never reads webhook
// payloads, and BEFORE the request-logger / route handlers so all responses
// flow through it. Default threshold (1 KB) avoids spending CPU on tiny JSON.
app.use(compression());

// Sensitive path prefixes whose response bodies must never be logged.
// Add any new route prefix here that returns credentials, tokens, PII, or
// secrets — even if the response looks innocuous today (e.g. a 200 with an
// opaque success message may later be extended to include sensitive fields).
//
// Current coverage rationale:
//   /api/auth            — login tokens, password reset tokens, session cookies
//   /api/integrations    — OAuth tokens, API keys, integration credentials
//   /api/oauth           — OAuth authorization codes and access tokens (Gmail, etc.)
//   /api/users           — user profile data, role assignments, Dialpad numbers (PII)
//   /api/settings/lead-capture-inbox — inbox config with sender rules (PII-adjacent)
//   /api/leads/google-sheets/credentials — Google Sheets API key storage/retrieval
const SENSITIVE_PATH_PREFIXES = [
  '/api/auth',
  '/api/integrations',
  '/api/oauth',
  '/api/users',
  '/api/settings/lead-capture-inbox',
];

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  const isSensitive = SENSITIVE_PATH_PREFIXES.some(p => path.startsWith(p));
  let capturedJsonResponse: Record<string, unknown> | undefined = undefined;

  if (!isSensitive) {
    const originalResJson = res.json;
    res.json = function (bodyJson, ...args) {
      capturedJsonResponse = bodyJson;
      return originalResJson.apply(res, [bodyJson, ...args]);
    };
  }

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      if (logLine.length > 80) {
        logLine = logLine.slice(0, 79) + "…";
      }

      log(logLine);

      // Per-route latency aggregation (task #593). Prefer Express's matched
      // route template (e.g. /api/contacts/:id/leads) so paths bucket
      // correctly; fall back to regex normalization for unmatched paths.
      const routeKey = (req as any).route?.path
        ? `/api${(req as any).baseUrl?.replace(/^\/api/, '') ?? ''}${(req as any).route.path}`
        : normalizePath(path);
      try {
        recordRequest(req.method, routeKey, res.statusCode, duration);
      } catch {
        // Never let metrics recording break a request lifecycle.
      }

      if (duration > SLOW_REQUEST_THRESHOLD_MS) {
        const contractorId = (req as any).user?.contractorId;
        const tenantPart = contractorId ? ` contractor=${contractorId}` : '';
        log(
          `[slow] ${req.method} ${routeKey} ${res.statusCode} ${duration}ms${tenantPart}`,
        );
      }
    }
  });

  next();
});

/**
 * One-time startup migration: reads any non-null webhook_api_key values from the
 * contractors table, encrypts them via CredentialService, then drops the column.
 *
 * Safety guarantee: the plaintext column is only dropped when every row has been
 * successfully migrated. If any single setCredential call fails the migration
 * aborts without touching the schema so existing integrations continue to work.
 *
 * Safe to run on every startup — idempotent once the column is gone.
 */
async function migrateDialpadWebhookApiKeys(): Promise<void> {
  try {
    // Check whether the plaintext column still exists
    const colCheckResult = await db.execute(sql`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'contractors' AND column_name = 'webhook_api_key'
      ) AS col_exists
    `);
    const colCheckRows = colCheckResult.rows as Array<{ col_exists: boolean }>;
    if (!colCheckRows[0]?.col_exists) {
      return; // Column already removed — nothing to do
    }

    // Read all contractors that still have a plaintext key
    const queryResult = await db.execute(sql`
      SELECT id, webhook_api_key FROM contractors WHERE webhook_api_key IS NOT NULL
    `);
    const rows = queryResult.rows as Array<{ id: string; webhook_api_key: string }>;

    let migrated = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        // Only store if no encrypted key already exists for this tenant
        const existing = await CredentialService.getCredential(row.id, 'dialpad', 'webhook_api_key');
        if (!existing) {
          await CredentialService.setCredential(row.id, 'dialpad', 'webhook_api_key', row.webhook_api_key);
          migrated++;
        }
      } catch (err) {
        failed++;
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[startup] Failed to migrate dialpad webhook key for contractor ${row.id}: ${msg}\n`);
      }
    }

    if (migrated > 0) {
      process.stderr.write(`[startup] Migrated ${migrated} dialpad webhook API key(s) to CredentialService\n`);
    }

    // Only drop the plaintext column when every row migrated successfully.
    // If any failed, leave the column intact so no keys are silently lost.
    if (failed > 0) {
      process.stderr.write(
        `[startup] Skipping contractors.webhook_api_key column drop — ${failed} row(s) failed to migrate. Will retry on next restart.\n`
      );
      return;
    }

    await db.execute(sql`ALTER TABLE contractors DROP COLUMN IF EXISTS webhook_api_key`);
    process.stderr.write(`[startup] Dropped contractors.webhook_api_key (plaintext column removed)\n`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[startup] migrateDialpadWebhookApiKeys error: ${msg}\n`);
  }
}

(async () => {
  try {
  // Ensure pg_trgm extension exists before serving any traffic (required for
  // GIN trigram indexes used by ILIKE search queries).
  await initDb();

  // One-time migration: move plaintext webhookApiKey values from the contractors
  // table into CredentialService (encrypted at rest), then drop the column.
  await migrateDialpadWebhookApiKeys();

  // Initialize provider service (registers default providers)
  log("Initializing multi-provider communication system...");
  const providers = providerService; // This triggers singleton initialization and provider registration
  log(`Provider system initialized with ${providers.getAvailableProviders('email').length} email, ${providers.getAvailableProviders('sms').length} SMS, ${providers.getAvailableProviders('calling').length} calling providers`);
  
  // Recover any workflow executions that were stuck in "running" status from a previous
  // server crash or restart (zombie executions caused by in-memory delay actions).
  log("Running zombie workflow execution recovery...");
  workflowEngine.recoverZombieExecutions().catch(err =>
    log(`Zombie recovery error: ${err instanceof Error ? err.message : String(err)}`)
  );

  // Start poller to resume suspended workflow executions (delay/wait_until steps)
  log("Starting suspended workflow execution poller...");
  workflowEngine.startSuspendedPoller();

  // Start the sync scheduler for daily syncs
  log("Starting sync scheduler...");
  await syncScheduler.start();
  
  // Start the message cleanup service
  log("Starting message cleanup service...");
  messageCleanupService.start();

  // Start the HCP webhook health checker (skipped if no HCP tenants exist)
  log("Starting HCP webhook health checker...");
  await startHcpWebhookHealthCheck();

  // Start the Dialpad call webhook health checker
  log("Starting Dialpad call health checker...");
  await startDialpadCallHealthCheck();

  // Start the data retention job (runs daily at 3 AM UTC)
  log("Starting data retention job...");
  startRetentionJob();

  // Database-backed poller for Dialpad webhook events. Continuously scans
  // `webhook_events` for unprocessed Dialpad rows (using the partial index
  // `webhook_events_unprocessed_idx`) and feeds them into the in-process
  // worker queue. This both replaces the old boot-only recovery scan AND
  // picks up events that wedged mid-processing — no restart required.
  log("Starting Dialpad event poller...");
  const dialpadEventPoller = new DialpadEventPoller();
  dialpadEventPoller.start();

  // ─── Background timer registry ────────────────────────────────────────────
  // Shutdown ownership model — two tiers:
  //
  //   Tier 1 – BackgroundJob subclasses (preferred pattern for all new jobs):
  //     Each job is instantiated below, started via job.start(), and stopped
  //     during shutdown via job.stop(). The interval handle lives inside the
  //     class; no external handle is needed. Current jobs:
  //       • GmailOAuthCleanupJob    — deletes expired oauth_states rows (1 h)
  //       • RateLimitCleanupJob     — prunes expired rate-limit buckets (1 min)
  //       • SpamAuditCleanupJob     — prunes old spam_audit_log rows (24 h)
  //       • RefreshTokenCleanupJob  — deletes expired refresh_tokens rows (24 h)
  //     Rule: ANY new periodic server job MUST extend BackgroundJob and be
  //     registered here. Do NOT add bare module-level setInterval calls.
  //
  //   Tier 2 – Inline timers declared IN THIS FILE:
  //     Ad-hoc setInterval / setTimeout handles that don't warrant a full
  //     BackgroundJob class are pushed into timerRegistry[] and cleared in a
  //     single loop during shutdown.
  //     Rule: every inline timer in this file MUST be pushed into timerRegistry
  //     immediately after creation.
  //
  //   Tier 3 – External service classes with their own start()/stop():
  //     MessageCleanupService, SyncScheduler, SuspendedExecutionPoller,
  //     HcpWebhookHealth — managed by their own stop() calls in step 4 below.
  //     NOT added to timerRegistry to avoid double-clear.
  const timerRegistry: (NodeJS.Timeout | NodeJS.Timer)[] = [];

  const gmailOAuthCleanupJob = new GmailOAuthCleanupJob();
  gmailOAuthCleanupJob.start();

  const rateLimitCleanupJob = new RateLimitCleanupJob();
  rateLimitCleanupJob.start();

  const spamAuditCleanupJob = new SpamAuditCleanupJob();
  spamAuditCleanupJob.start();
  log("SpamAuditCleanupJob registered (runs every 24 h)");

  const refreshTokenCleanupJob = new RefreshTokenCleanupJob();
  refreshTokenCleanupJob.start();
  log("RefreshTokenCleanupJob registered (runs every 24 h)");

  const adSpendSyncJob = new AdSpendSyncJob();
  adSpendSyncJob.start();
  log("AdSpendSyncJob registered (runs every 6 h)");

  // Sales-process cron: poll for due auto-mode tasks and dispatch them.
  const { salesProcessCron } = await import("./services/sales-process-cron");
  salesProcessCron.start();
  log("SalesProcessCron registered (runs every 60s)");

  // Periodic sweep of the in-process JWT validation cache (drops expired entries).
  timerRegistry.push(startAuthCacheSweeper(60 * 1000));

  // Hourly cleanup of expired revoked_tokens rows (prevents unbounded table growth)
  timerRegistry.push(setInterval(() => {
    AuthService.cleanupExpiredRevokedTokens().catch(err =>
      log(`[revoked_tokens cleanup] error: ${err instanceof Error ? err.message : String(err)}`)
    );
  }, 60 * 60 * 1000));

  // Nightly cleanup of terminal webhook_events older than 30 days. A row is
  // terminal when it either succeeded (processed=true) or permanently failed
  // (failed_at IS NOT NULL). Pending rows (processed=false AND failed_at IS
  // NULL) are deliberately retained so the poller can keep retrying them.
  timerRegistry.push(setInterval(async () => {
    try {
      const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      await db.delete(webhookEvents).where(
        and(
          or(
            eq(webhookEvents.processed, true),
            isNotNull(webhookEvents.failedAt),
          ),
          lt(webhookEvents.createdAt, cutoff),
        ),
      );
    } catch (err) {
      log(`[webhook_events cleanup] error: ${err}`);
    }
  }, 24 * 60 * 60 * 1000));


  const server = await registerRoutes(app);

  // Global error-handling contract:
  //  - ZodError  → 400 with the first validation message (no need to catch in individual routes)
  //  - Other errors with an explicit .status/.statusCode → that status
  //  - Everything else → 500 Internal Server Error
  // Route handlers should still catch non-Zod errors they want to handle differently.
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) {
      res.status(400).json({ message: err.issues[0]?.message ?? "Validation error", errors: err.issues });
      return;
    }
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    res.status(status).json({ message });
    throw err;
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (app.get("env") === "development") {
    await setupVite(app, server);
  } else {
    // Prevent browsers from caching index.html across deployments.
    // Vite gives JS/CSS assets content-hashed filenames so those can be cached
    // safely, but index.html itself must never be stale — a cached copy
    // referencing old chunk filenames causes "Importing a module script failed"
    // errors on mobile (especially iOS Safari) after each new deploy.
    app.use((req: Request, res: Response, next: NextFunction) => {
      const hasExtension = /\.\w+$/.test(req.path);
      if (!hasExtension) {
        res.setHeader("Cache-Control", "no-store");
      }
      next();
    });
    serveStatic(app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || '5000', 10);
  server.listen({
    port,
    host: "0.0.0.0",
    reusePort: true,
  }, () => {
    log(`serving on port ${port}`);
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      log(`Port ${port} is already in use — exiting so the runner can restart cleanly`);
      process.exit(1);
    } else {
      throw err;
    }
  });

  // ─── Graceful Shutdown ────────────────────────────────────────────────────
  // Registers SIGTERM (sent by container orchestrators, Replit deploy, etc.) and
  // SIGINT (Ctrl-C / local dev kill) handlers that stop all background services
  // in a deterministic order before the process exits.
  //
  // Shutdown order (reverse of startup):
  //   1. Stop accepting new HTTP connections (server.close)
  //   2. Stop background timers/intervals so no new work is queued
  //   3. Drain in-flight work (each service's stop() blocks briefly)
  //   4. Close the database pool so open connections are released cleanly
  //   5. Exit with code 0 so the runner knows it was intentional
  //
  // A hard-exit timeout of 10 s is set so a hung service (e.g. a slow DB query
  // that never resolves) cannot block the process from exiting indefinitely.
  const gracefulShutdown = async (signal: string) => {
    log(`Received ${signal} — starting graceful shutdown`);

    const hardExitTimer = setTimeout(() => {
      log("Graceful shutdown timed out after 10 s — forcing exit");
      process.exit(1);
    }, 10_000);
    hardExitTimer.unref(); // Don't let this timer keep the event loop alive on its own

    try {
      // 1. Stop the WebSocket server: clear heartbeat interval, terminate all
      //    lingering upgraded connections, then close the WS server itself.
      //    This must happen BEFORE server.close() so the HTTP server can drain
      //    without waiting on long-lived WebSocket connections.
      await stopWebSocket();

      // 2. Stop accepting new HTTP connections
      await new Promise<void>((resolve) => server.close(() => resolve()));

      // 3. Clear all background timers tracked in the registry
      for (const handle of timerRegistry) {
        clearInterval(handle as NodeJS.Timeout);
      }
      timerRegistry.length = 0;

      // 4. Stop background services (order mirrors reverse-startup for safety)
      gmailOAuthCleanupJob.stop();
      rateLimitCleanupJob.stop();
      spamAuditCleanupJob.stop();
      refreshTokenCleanupJob.stop();
      adSpendSyncJob.stop();
      salesProcessCron.stop();
      dialpadEventPoller.stop();
      stopHcpWebhookHealthCheck();
      stopDialpadCallHealthCheck();
      messageCleanupService.stop();
      syncScheduler.stop();
      workflowEngine.stopSuspendedPoller();

      // 5. Close the database connection pool
      await pool.end();

      log("Graceful shutdown complete");
    } catch (err) {
      log(`Error during graceful shutdown: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(hardExitTimer);
      process.exit(0);
    }
  };

  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGINT",  () => gracefulShutdown("SIGINT"));
  // ─────────────────────────────────────────────────────────────────────────
  } catch (err) {
    logFatalAndExit('startup fatal', err);
  }
})().catch((err) => logFatalAndExit('startup fatal (unhandled)', err));
