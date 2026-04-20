import { db } from "../db";
import { webhookEvents, contractorIntegrations, notifications } from "@shared/schema";
import { eq, and, desc, sql, gte, ne } from "drizzle-orm";
import { storage } from "../storage";
import { broadcastToContractor } from "../websocket";
import { housecallProService } from "../hcp/index";
import { logger } from "../utils/logger";
import { formatDbError } from "../utils/db-error";

const log = logger('HcpWebhookHealth');

const WARNING_THRESHOLD_MS = 24 * 60 * 60 * 1000;
const DISABLED_THRESHOLD_MS = 25 * 60 * 60 * 1000;
const CHECK_INTERVAL_MS = 5 * 60 * 1000;

const REJECTION_SPIKE_WINDOW_MS = 10 * 60 * 1000;
const REJECTION_SPIKE_COUNT = 10;

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let serverStartedAt: Date = new Date();

const INTEGRATIONS_FETCH_LIMIT = 100;

// Per-contractor incident tracking: maps contractorId -> Date when outage was first detected.
// Set when webhook silence exceeds WARNING_THRESHOLD and cleared when events resume.
// Notification is sent exactly once when the incident is first opened.
const activeIncidents = new Map<string, Date>();

export function getServerStartedAt(): Date {
  return serverStartedAt;
}

export async function checkHcpWebhookHealth(): Promise<void> {
  try {
    const enabledIntegrations = await db.select()
      .from(contractorIntegrations)
      .where(and(
        eq(contractorIntegrations.integrationName, 'housecall-pro'),
        eq(contractorIntegrations.isEnabled, true),
      ))
      .limit(INTEGRATIONS_FETCH_LIMIT);

    if (enabledIntegrations.length >= INTEGRATIONS_FETCH_LIMIT) {
      log.warn(`Integrations fetch returned ${enabledIntegrations.length} rows — at or near the safety cap (${INTEGRATIONS_FETCH_LIMIT}). Some tenants may be skipped. Add pagination if tenant count keeps growing.`);
    }

    if (enabledIntegrations.length === 0) {
      log.info('No contractors with HCP enabled, skipping webhook health check');
      return;
    }

    for (const integration of enabledIntegrations) {
      const contractorId = integration.contractorId;
      try {
        const [latestEventResult, rejectionSpike] = await Promise.all([
          db.select({ createdAt: webhookEvents.createdAt })
            .from(webhookEvents)
            .where(and(
              eq(webhookEvents.contractorId, contractorId),
              eq(webhookEvents.service, 'housecall-pro'),
              ne(webhookEvents.eventType, 'rejection'),
            ))
            .orderBy(desc(webhookEvents.createdAt))
            .limit(1),
          checkRejectionSpike(contractorId),
        ]);

        const lastEventAt = latestEventResult[0]?.createdAt;
        const now = new Date();

        // Handle rejection spike alert independently from staleness alert
        if (rejectionSpike.isSpike && !activeIncidents.has(`${contractorId}:rejection`)) {
          activeIncidents.set(`${contractorId}:rejection`, now);
          log.warn(`Contractor ${contractorId}: rejection spike detected — ${rejectionSpike.recentRejectionCount} rejections in the last 10 minutes with no successful events`);

          const contractorUsers = await storage.getContractorUsers(contractorId);
          const adminUsers = contractorUsers.filter(uc =>
            uc.role === 'admin' || uc.role === 'super_admin'
          );

          if (adminUsers.length > 0) {
            const reasonNote = rejectionSpike.lastRejectionReason
              ? ` The most recent rejection reason is: ${rejectionSpike.lastRejectionReason}.`
              : '';
            for (const admin of adminUsers) {
              await db.insert(notifications).values({
                userId: admin.userId,
                contractorId,
                type: 'system',
                title: 'Housecall Pro Webhook Auth Failures',
                message: `${rejectionSpike.recentRejectionCount} webhook requests from Housecall Pro were rejected in the last 10 minutes with no successful events.${reasonNote} This usually means the webhook signing secret or URL token is misconfigured. Go to Settings → Integrations → Housecall Pro to verify your webhook configuration.`,
                link: '/settings/integrations',
              });
            }
            broadcastToContractor(contractorId, { type: 'notification_updated' });
            log.info(`Sent rejection spike alert to ${adminUsers.length} admin(s) for contractor ${contractorId}`);
          }
        } else if (!rejectionSpike.isSpike && activeIncidents.has(`${contractorId}:rejection`)) {
          log.info(`Contractor ${contractorId}: rejection spike cleared — closing rejection incident`);
          activeIncidents.delete(`${contractorId}:rejection`);
        }

        if (!lastEventAt) {
          log.info(`Contractor ${contractorId}: no HCP webhook events recorded yet — skipping staleness check`);
          continue;
        }

        const ageMs = now.getTime() - lastEventAt.getTime();

        if (ageMs < WARNING_THRESHOLD_MS) {
          if (activeIncidents.has(contractorId)) {
            log.info(`Contractor ${contractorId}: webhooks resumed — closing incident`);
            activeIncidents.delete(contractorId);
          }
          continue;
        }

        const serverUptimeMs = now.getTime() - serverStartedAt.getTime();
        if (serverUptimeMs < WARNING_THRESHOLD_MS) {
          log.info(`Contractor ${contractorId}: server uptime is only ${Math.round(serverUptimeMs / 60000)}min, skipping false-alarm check`);
          continue;
        }

        // Incident already open — notification already sent, do not repeat
        if (activeIncidents.has(contractorId)) {
          continue;
        }

        // Open a new incident and send a notification
        activeIncidents.set(contractorId, now);

        log.warn(`Contractor ${contractorId}: last HCP webhook event was ${Math.round(ageMs / 3600000 * 10) / 10}h ago — opening incident and alerting admins`);

        const contractorUsers = await storage.getContractorUsers(contractorId);
        const adminUsers = contractorUsers.filter(uc =>
          uc.role === 'admin' || uc.role === 'super_admin'
        );

        if (adminUsers.length === 0) {
          log.warn(`Contractor ${contractorId}: no admin users found, cannot send webhook health notification`);
          continue;
        }

        let apiConnected = false;
        try {
          const apiResult = await housecallProService.getEmployees(contractorId);
          apiConnected = apiResult.success;
          if (!apiConnected) {
            log.warn(`Contractor ${contractorId}: HCP API connection failed — API key may be invalid or expired`);
          }
        } catch (apiErr) {
          log.warn(`Contractor ${contractorId}: error checking HCP API connection`, apiErr);
        }

        const apiNote = apiConnected
          ? 'The HCP API connection is working, so the issue is likely that webhooks were disabled in the HCP dashboard.'
          : 'Additionally, the HCP API connection test failed — your API key may also need to be updated.';

        const ageHours = Math.round(ageMs / 3600000 * 10) / 10;

        for (const admin of adminUsers) {
          await db.insert(notifications).values({
            userId: admin.userId,
            contractorId,
            type: 'system',
            title: 'Housecall Pro Webhooks May Be Disabled',
            message: `No webhook events have been received from Housecall Pro in the last ${ageHours} hours. Real-time updates for leads, estimates, and jobs may not be working. ${apiNote} Go to Settings → Integrations → Housecall Pro to verify your webhook URL is still active in the HCP dashboard.`,
            link: '/settings/integrations',
          });
        }

        broadcastToContractor(contractorId, { type: 'notification_updated' });
        log.info(`Sent webhook health alert to ${adminUsers.length} admin(s) for contractor ${contractorId}`);
      } catch (err) {
        log.error(`Error checking webhook health for contractor ${contractorId}: ${formatDbError(err)}`);
      }
    }
  } catch (err) {
    log.error(`HCP webhook health check failed: ${formatDbError(err)}`);
  }
}

export async function getWebhookHealthStatus(contractorId: string): Promise<{
  lastEventAt: Date | null;
  isStale: boolean;
  ageHours: number | null;
}> {
  const latestEvent = await db.select({ createdAt: webhookEvents.createdAt })
    .from(webhookEvents)
    .where(and(
      eq(webhookEvents.contractorId, contractorId),
      eq(webhookEvents.service, 'housecall-pro'),
    ))
    .orderBy(desc(webhookEvents.createdAt))
    .limit(1);

  const lastEventAt = latestEvent[0]?.createdAt ?? null;

  if (!lastEventAt) {
    return { lastEventAt: null, isStale: false, ageHours: null };
  }

  const ageMs = Date.now() - lastEventAt.getTime();
  return {
    lastEventAt,
    isStale: ageMs > DISABLED_THRESHOLD_MS,
    ageHours: Math.round(ageMs / 3600000 * 10) / 10,
  };
}

async function checkRejectionSpike(contractorId: string): Promise<{
  isSpike: boolean;
  recentRejectionCount: number;
  lastRejectionReason: string | null;
}> {
  const windowStart = new Date(Date.now() - REJECTION_SPIKE_WINDOW_MS);

  const [rejections, successfulEvents] = await Promise.all([
    db.select({ count: sql<number>`count(*)`, errorMessage: webhookEvents.errorMessage })
      .from(webhookEvents)
      .where(and(
        eq(webhookEvents.contractorId, contractorId),
        eq(webhookEvents.service, 'housecall-pro'),
        eq(webhookEvents.eventType, 'rejection'),
        gte(webhookEvents.createdAt, windowStart),
      ))
      .groupBy(webhookEvents.errorMessage),
    db.select({ count: sql<number>`count(*)` })
      .from(webhookEvents)
      .where(and(
        eq(webhookEvents.contractorId, contractorId),
        eq(webhookEvents.service, 'housecall-pro'),
        ne(webhookEvents.eventType, 'rejection'),
        gte(webhookEvents.createdAt, windowStart),
      )),
  ]);

  const totalRejections = rejections.reduce((sum, r) => sum + Number(r.count), 0);
  const totalSuccessful = Number(successfulEvents[0]?.count ?? 0);

  const lastRejection = await db.select({ errorMessage: webhookEvents.errorMessage })
    .from(webhookEvents)
    .where(and(
      eq(webhookEvents.contractorId, contractorId),
      eq(webhookEvents.service, 'housecall-pro'),
      eq(webhookEvents.eventType, 'rejection'),
    ))
    .orderBy(desc(webhookEvents.createdAt))
    .limit(1);

  return {
    isSpike: totalRejections >= REJECTION_SPIKE_COUNT && totalSuccessful === 0,
    recentRejectionCount: totalRejections,
    lastRejectionReason: lastRejection[0]?.errorMessage ?? null,
  };
}

export async function getRejectionCount24h(contractorId: string): Promise<number> {
  const windowStart = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const result = await db.select({ count: sql<number>`count(*)` })
    .from(webhookEvents)
    .where(and(
      eq(webhookEvents.contractorId, contractorId),
      eq(webhookEvents.service, 'housecall-pro'),
      eq(webhookEvents.eventType, 'rejection'),
      gte(webhookEvents.createdAt, windowStart),
    ));
  return Number(result[0]?.count ?? 0);
}

export async function getWebhookStatus(contractorId: string): Promise<{
  lastEventAt: Date | null;
  status: 'healthy' | 'warning' | 'disabled';
  statusReason?: string;
  serverStartedAt: Date;
  rejectionCount24h: number;
  lastRejectionReason: string | null;
}> {
  const [latestEventResult, rejectionSpikeResult, rejectionCount24h] = await Promise.all([
    db.select({ createdAt: webhookEvents.createdAt })
      .from(webhookEvents)
      .where(and(
        eq(webhookEvents.contractorId, contractorId),
        eq(webhookEvents.service, 'housecall-pro'),
        ne(webhookEvents.eventType, 'rejection'),
      ))
      .orderBy(desc(webhookEvents.createdAt))
      .limit(1),
    checkRejectionSpike(contractorId),
    getRejectionCount24h(contractorId),
  ]);

  const lastEventAt = latestEventResult[0]?.createdAt ?? null;
  const now = new Date();
  const serverUptimeMs = now.getTime() - serverStartedAt.getTime();

  let status: 'healthy' | 'warning' | 'disabled';
  let statusReason: string | undefined;

  if (rejectionSpikeResult.isSpike) {
    status = 'warning';
    statusReason = 'auth_failing';
  } else if (!lastEventAt) {
    if (serverUptimeMs < WARNING_THRESHOLD_MS) {
      status = 'healthy';
    } else if (serverUptimeMs < DISABLED_THRESHOLD_MS) {
      status = 'warning';
    } else {
      status = 'disabled';
    }
  } else {
    const ageMs = now.getTime() - lastEventAt.getTime();
    if (ageMs < WARNING_THRESHOLD_MS) {
      status = 'healthy';
    } else if (ageMs < DISABLED_THRESHOLD_MS) {
      if (serverUptimeMs < WARNING_THRESHOLD_MS) {
        status = 'healthy';
      } else {
        status = 'warning';
      }
    } else {
      if (serverUptimeMs < WARNING_THRESHOLD_MS) {
        status = 'healthy';
      } else if (serverUptimeMs < DISABLED_THRESHOLD_MS) {
        status = 'warning';
      } else {
        status = 'disabled';
      }
    }
  }

  return {
    lastEventAt,
    status,
    statusReason,
    serverStartedAt,
    rejectionCount24h,
    lastRejectionReason: rejectionSpikeResult.lastRejectionReason,
  };
}

async function hasAnyHcpTenant(): Promise<boolean> {
  const rows = await db.select({ contractorId: contractorIntegrations.contractorId })
    .from(contractorIntegrations)
    .where(and(
      eq(contractorIntegrations.integrationName, 'housecall-pro'),
      eq(contractorIntegrations.isEnabled, true),
    ))
    .limit(1);
  return rows.length > 0;
}

function startInterval(): void {
  if (intervalHandle) return;
  intervalHandle = setInterval(() => {
    checkHcpWebhookHealth().catch(err =>
      log.error(`Periodic HCP webhook health check failed: ${formatDbError(err)}`)
    );
  }, CHECK_INTERVAL_MS);
  log.info('HCP webhook health check interval started (every 5 minutes)');
}

async function runStartupFastCheck(): Promise<void> {
  try {
    const enabledIntegrations = await db.select()
      .from(contractorIntegrations)
      .where(and(
        eq(contractorIntegrations.integrationName, 'housecall-pro'),
        eq(contractorIntegrations.isEnabled, true),
      ))
      .limit(INTEGRATIONS_FETCH_LIMIT);

    if (enabledIntegrations.length === 0) return;

    const FAST_CHECK_THRESHOLD_MS = 24 * 60 * 60 * 1000;

    for (const integration of enabledIntegrations) {
      const contractorId = integration.contractorId;
      try {
        const latestEventResult = await db.select({ createdAt: webhookEvents.createdAt })
          .from(webhookEvents)
          .where(and(
            eq(webhookEvents.contractorId, contractorId),
            eq(webhookEvents.service, 'housecall-pro'),
            ne(webhookEvents.eventType, 'rejection'),
          ))
          .orderBy(desc(webhookEvents.createdAt))
          .limit(1);

        const lastEventAt = latestEventResult[0]?.createdAt;
        if (!lastEventAt) continue;

        const ageMs = Date.now() - lastEventAt.getTime();
        if (ageMs < FAST_CHECK_THRESHOLD_MS) continue;

        let apiConnected = false;
        try {
          const apiResult = await housecallProService.getEmployees(contractorId);
          apiConnected = apiResult.success;
        } catch (_) { /* ignore */ }

        if (!apiConnected) {
          log.info(`Startup fast-check: contractor ${contractorId} — API not reachable, skipping alert`);
          continue;
        }

        if (activeIncidents.has(contractorId)) continue;
        activeIncidents.set(contractorId, new Date());

        const ageHours = Math.round(ageMs / 3600000 * 10) / 10;
        log.warn(`Startup fast-check: contractor ${contractorId} — no HCP webhook events in ${ageHours}h but API is alive, alerting admins`);

        const contractorUsers = await storage.getContractorUsers(contractorId);
        const adminUsers = contractorUsers.filter(uc =>
          uc.role === 'admin' || uc.role === 'super_admin'
        );

        if (adminUsers.length === 0) continue;

        for (const admin of adminUsers) {
          await db.insert(notifications).values({
            userId: admin.userId,
            contractorId,
            type: 'system',
            title: 'HCP Webhooks May Be Inactive',
            message: `HCP webhooks appear to be inactive — no events received in the last ${ageHours} hours. Please verify webhooks are still enabled in the Housecall Pro dashboard.`,
            link: '/settings/integrations',
          });
        }

        broadcastToContractor(contractorId, { type: 'notification_updated' });
        log.info(`Startup fast-check: sent alert to ${adminUsers.length} admin(s) for contractor ${contractorId}`);
      } catch (err) {
        log.error(`Startup fast-check error for contractor ${contractorId}: ${formatDbError(err)}`);
      }
    }
  } catch (err) {
    log.error(`Startup fast-check failed: ${formatDbError(err)}`);
  }
}

export async function startHcpWebhookHealthCheck(): Promise<void> {
  serverStartedAt = new Date();
  const anyTenant = await hasAnyHcpTenant();
  if (!anyTenant) {
    log.info('No HCP tenants found at startup — skipping health check scheduling');
    return;
  }
  log.info('Starting HCP webhook health check (runs every 5 minutes)');
  setTimeout(() => {
    runStartupFastCheck().catch(err =>
      log.error(`Startup fast-check failed: ${formatDbError(err)}`)
    );
    checkHcpWebhookHealth().catch(err =>
      log.error(`Initial HCP webhook health check failed: ${formatDbError(err)}`)
    );
  }, 60_000);
  startInterval();
}

export function stopHcpWebhookHealthCheck(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    log.info('HCP webhook health check interval stopped');
  }
}

/**
 * Call this whenever an HCP integration is enabled or disabled so the health
 * check interval can be started (if first tenant) or stopped (if last tenant).
 */
export async function notifyHcpIntegrationChanged(): Promise<void> {
  const anyTenant = await hasAnyHcpTenant();
  if (anyTenant && !intervalHandle) {
    log.info('HCP integration enabled — starting health check interval');
    startInterval();
  } else if (!anyTenant && intervalHandle) {
    log.info('Last HCP integration disabled — stopping health check interval');
    stopHcpWebhookHealthCheck();
  }
}
