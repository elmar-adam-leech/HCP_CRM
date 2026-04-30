import { db } from "../db";
import { webhookEvents, contractorIntegrations, notifications, webhookIncidents } from "@shared/schema";
import { eq, and, desc, sql, gte, ne, isNull } from "drizzle-orm";
import { storage } from "../storage";
import { broadcastToContractor } from "../websocket";
import { housecallProService } from "../hcp/index";
import { logger } from "../utils/logger";
import { formatDbError } from "../utils/db-error";
import { runHcpWebhookBackfill, summarizeBackfill } from "../sync/hcp-backfill";

const log = logger('HcpWebhookHealth');

const WARNING_THRESHOLD_MS = 24 * 60 * 60 * 1000;
const DISABLED_THRESHOLD_MS = 25 * 60 * 60 * 1000;
const CHECK_INTERVAL_MS = 5 * 60 * 1000;

const REJECTION_SPIKE_WINDOW_MS = 10 * 60 * 1000;
const REJECTION_SPIKE_COUNT = 10;

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let serverStartedAt: Date = new Date();

const INTEGRATIONS_FETCH_LIMIT = 100;

const SERVICE_HCP = 'housecall-pro';
const KIND_STALENESS = 'staleness';
const KIND_REJECTION = 'rejection';

export function getServerStartedAt(): Date {
  return serverStartedAt;
}

// ---------- Persistent incident helpers ----------
//
// Replaces the old in-memory `activeIncidents` map. Now any open incident
// survives a server restart, so the "HCP Webhooks May Be Disabled"
// notification fires exactly once per outage even if the host crashes /
// rolls during the silence window.

async function getOpenIncident(contractorId: string, kind: string) {
  const rows = await db.select()
    .from(webhookIncidents)
    .where(and(
      eq(webhookIncidents.contractorId, contractorId),
      eq(webhookIncidents.service, SERVICE_HCP),
      eq(webhookIncidents.kind, kind),
      isNull(webhookIncidents.closedAt),
    ))
    .limit(1);
  return rows[0];
}

/**
 * Atomically open an incident or no-op if one is already open.
 *
 * Relies on the unique partial index `webhook_incidents_unique_open_idx`
 * (only one OPEN row per contractor+service+kind). If two health-check
 * ticks race, only one INSERT will succeed and the other returns no rows
 * — we then re-fetch the existing open row so callers always get back a
 * valid incident reference.
 *
 * Returns `{ incident, created }` so the caller can decide whether to
 * notify and backfill (only on `created === true`).
 */
async function openIncidentAtomic(contractorId: string, kind: string): Promise<{
  incident: typeof webhookIncidents.$inferSelect;
  created: boolean;
}> {
  const inserted = await db.insert(webhookIncidents).values({
    contractorId,
    service: SERVICE_HCP,
    kind,
  })
    .onConflictDoNothing()
    .returning();
  if (inserted[0]) {
    return { incident: inserted[0], created: true };
  }
  // Conflict — another tick won the race. Re-fetch the existing open row.
  const existing = await getOpenIncident(contractorId, kind);
  if (!existing) {
    // Pathological: insert returned nothing but no open row exists. Could
    // only happen if another tick closed the incident between the INSERT
    // and the SELECT. Treat as "not created"; caller will skip notify.
    throw new Error(`openIncidentAtomic: insert conflicted but no open incident found for ${contractorId}/${kind}`);
  }
  return { incident: existing, created: false };
}

async function closeOpenIncident(contractorId: string, kind: string): Promise<void> {
  await db.update(webhookIncidents)
    .set({ closedAt: new Date() })
    .where(and(
      eq(webhookIncidents.contractorId, contractorId),
      eq(webhookIncidents.service, SERVICE_HCP),
      eq(webhookIncidents.kind, kind),
      isNull(webhookIncidents.closedAt),
    ));
}

async function markIncidentNotified(incidentId: string): Promise<void> {
  await db.update(webhookIncidents)
    .set({ notifiedAt: new Date() })
    .where(eq(webhookIncidents.id, incidentId));
}

async function markIncidentBackfill(incidentId: string, summary: string): Promise<void> {
  await db.update(webhookIncidents)
    .set({ backfillAttemptedAt: new Date(), backfillSummary: summary })
    .where(eq(webhookIncidents.id, incidentId));
}

async function getLastSuccessfulEventAt(contractorId: string): Promise<Date | null> {
  const latestEventResult = await db.select({ createdAt: webhookEvents.createdAt })
    .from(webhookEvents)
    .where(and(
      eq(webhookEvents.contractorId, contractorId),
      eq(webhookEvents.service, SERVICE_HCP),
      ne(webhookEvents.eventType, 'rejection'),
    ))
    .orderBy(desc(webhookEvents.createdAt))
    .limit(1);
  return latestEventResult[0]?.createdAt ?? null;
}

/**
 * Get the most recent backfill (latest open or closed incident, by
 * `backfillAttemptedAt`) so the settings card can surface "Last resync".
 */
export async function getLastBackfill(contractorId: string): Promise<{
  attemptedAt: Date;
  summary: string | null;
} | null> {
  const rows = await db.select({
    backfillAttemptedAt: webhookIncidents.backfillAttemptedAt,
    backfillSummary: webhookIncidents.backfillSummary,
  })
    .from(webhookIncidents)
    .where(and(
      eq(webhookIncidents.contractorId, contractorId),
      eq(webhookIncidents.service, SERVICE_HCP),
      sql`${webhookIncidents.backfillAttemptedAt} IS NOT NULL`,
    ))
    .orderBy(desc(webhookIncidents.backfillAttemptedAt))
    .limit(1);
  const row = rows[0];
  if (!row || !row.backfillAttemptedAt) return null;
  return { attemptedAt: row.backfillAttemptedAt, summary: row.backfillSummary };
}

// Per-contractor in-progress tracker for manual resyncs. Keeps the HTTP
// endpoint non-blocking (returns immediately) and prevents a user from
// kicking off ten parallel backfills by mashing the "Resync now" button.
// Single-process is fine because (a) backfill is idempotent, (b) the worst
// case in a multi-instance deploy is one extra concurrent backfill, which
// the dispatch layer already deduplicates at the entity level.
const manualBackfillsInProgress = new Set<string>();

export function isManualBackfillInProgress(contractorId: string): boolean {
  return manualBackfillsInProgress.has(contractorId);
}

/**
 * Enqueue a manual resync. Returns immediately with `{ accepted: true }` if
 * the work was scheduled (or `{ accepted: false }` if a resync is already
 * running for this contractor). The actual backfill runs in the background
 * and persists its result under a `webhook_incidents` row so the UI can
 * surface it as "Last resync".
 */
export function triggerManualBackfill(contractorId: string): {
  accepted: boolean;
  reason?: string;
} {
  if (manualBackfillsInProgress.has(contractorId)) {
    return { accepted: false, reason: 'already_in_progress' };
  }
  manualBackfillsInProgress.add(contractorId);
  setImmediate(() => { void runManualBackfillBackground(contractorId); });
  return { accepted: true };
}

async function runManualBackfillBackground(contractorId: string): Promise<void> {
  try {
    const since = await getLastSuccessfulEventAt(contractorId);
    let result: Awaited<ReturnType<typeof runHcpWebhookBackfill>>;
    try {
      result = await runHcpWebhookBackfill(contractorId, since);
    } catch (err) {
      const msg = `manual backfill failed: ${err instanceof Error ? err.message : String(err)}`;
      log.error(`[backfill] contractor=${contractorId} ${msg}`);
      // Record the failure on an incident so the UI surfaces "Last resync: failed".
      const failureSummary = `manual: ${msg}`;
      const existingOpen = await getOpenIncident(contractorId, KIND_STALENESS);
      if (existingOpen) {
        await markIncidentBackfill(existingOpen.id, failureSummary);
      } else {
        try {
          const { incident } = await openIncidentAtomic(contractorId, KIND_STALENESS);
          await markIncidentBackfill(incident.id, failureSummary);
          await closeOpenIncident(contractorId, KIND_STALENESS);
        } catch (incErr) {
          log.error('Failed to record manual backfill failure incident', incErr);
        }
      }
      return;
    }
    const summaryText = summarizeBackfill(result);
    // Manual backfills are recorded under an open incident if one exists,
    // otherwise under a fresh row that is immediately closed (so we keep an
    // audit trail without leaving a phantom open incident).
    const existingOpen = await getOpenIncident(contractorId, KIND_STALENESS);
    if (!existingOpen) {
      const { incident } = await openIncidentAtomic(contractorId, KIND_STALENESS);
      await markIncidentBackfill(incident.id, `manual: ${summaryText}`);
      await closeOpenIncident(contractorId, KIND_STALENESS);
    } else {
      await markIncidentBackfill(existingOpen.id, `manual: ${summaryText}`);
    }
    broadcastToContractor(contractorId, { type: 'webhook_status_updated' });
  } catch (outerErr) {
    log.error('Unexpected error in runManualBackfillBackground', outerErr);
  } finally {
    manualBackfillsInProgress.delete(contractorId);
  }
}

// ---------- Health check ----------

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
        await checkContractorHealth(contractorId);
      } catch (err) {
        log.error(`Error checking webhook health for contractor ${contractorId}: ${formatDbError(err)}`);
      }
    }
  } catch (err) {
    log.error(`HCP webhook health check failed: ${formatDbError(err)}`);
  }
}

async function checkContractorHealth(contractorId: string): Promise<void> {
  const [latestEventResult, rejectionSpike, openStalenessIncident, openRejectionIncident] = await Promise.all([
    db.select({ createdAt: webhookEvents.createdAt })
      .from(webhookEvents)
      .where(and(
        eq(webhookEvents.contractorId, contractorId),
        eq(webhookEvents.service, SERVICE_HCP),
        ne(webhookEvents.eventType, 'rejection'),
      ))
      .orderBy(desc(webhookEvents.createdAt))
      .limit(1),
    checkRejectionSpike(contractorId),
    getOpenIncident(contractorId, KIND_STALENESS),
    getOpenIncident(contractorId, KIND_REJECTION),
  ]);

  const lastEventAt = latestEventResult[0]?.createdAt ?? null;
  const now = new Date();

  // ---- Rejection spike (independent of staleness) ----
  if (rejectionSpike.isSpike && !openRejectionIncident) {
    // Atomic open: if a parallel tick already opened a rejection incident
    // since our SELECT, `created` will be false and we skip notify entirely.
    const { incident, created } = await openIncidentAtomic(contractorId, KIND_REJECTION);
    if (!created) {
      log.info(`Contractor ${contractorId}: rejection incident already opened by another tick — skipping duplicate notify`);
    } else {
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
        await markIncidentNotified(incident.id);
      }
    }
  } else if (!rejectionSpike.isSpike && openRejectionIncident) {
    log.info(`Contractor ${contractorId}: rejection spike cleared — closing rejection incident`);
    await closeOpenIncident(contractorId, KIND_REJECTION);
  }

  // ---- Staleness ----
  if (!lastEventAt) {
    log.info(`Contractor ${contractorId}: no HCP webhook events recorded yet — skipping staleness check`);
    return;
  }

  const ageMs = now.getTime() - lastEventAt.getTime();

  // Webhooks resumed → close any open staleness incident.
  if (ageMs < WARNING_THRESHOLD_MS) {
    if (openStalenessIncident) {
      log.info(`Contractor ${contractorId}: webhooks resumed — closing staleness incident`);
      await closeOpenIncident(contractorId, KIND_STALENESS);
    }
    return;
  }

  // Server is freshly booted — wait for at least one full warning window
  // of uptime before alerting, so a long downtime doesn't double-fire.
  // This guard is only relevant when no incident is yet open; if one is,
  // we already alerted in a previous run.
  const serverUptimeMs = now.getTime() - serverStartedAt.getTime();
  if (!openStalenessIncident && serverUptimeMs < WARNING_THRESHOLD_MS) {
    log.info(`Contractor ${contractorId}: server uptime is only ${Math.round(serverUptimeMs / 60000)}min, skipping false-alarm check`);
    return;
  }

  // Already in an open incident — already notified. But if we never managed
  // to attempt a backfill (API was down at incident-open time, or no admin
  // users existed yet), retry the backfill now in case conditions changed.
  if (openStalenessIncident) {
    if (!openStalenessIncident.backfillAttemptedAt) {
      await tryBackfillForOpenIncident(contractorId, openStalenessIncident.id, lastEventAt, 'retry');
    }
    return;
  }

  // ---- Open a new staleness incident (atomic — see openIncidentAtomic) ----
  const { incident, created } = await openIncidentAtomic(contractorId, KIND_STALENESS);
  if (!created) {
    log.info(`Contractor ${contractorId}: staleness incident was opened by another tick — skipping duplicate notify+backfill`);
    return;
  }
  log.warn(`Contractor ${contractorId}: last HCP webhook event was ${Math.round(ageMs / 3600000 * 10) / 10}h ago — opening incident and alerting admins`);

  // Try backfill FIRST (regardless of whether admins exist) so a tenant
  // without an admin user still gets caught up, and so the resync summary
  // can be embedded in the notification we send next.
  const backfillOutcome = await tryBackfillForOpenIncident(contractorId, incident.id, lastEventAt, 'initial');

  const contractorUsers = await storage.getContractorUsers(contractorId);
  const adminUsers = contractorUsers.filter(uc =>
    uc.role === 'admin' || uc.role === 'super_admin'
  );

  if (adminUsers.length === 0) {
    log.warn(`Contractor ${contractorId}: no admin users found, cannot send webhook health notification`);
    return;
  }

  let backfillNote = '';
  if (backfillOutcome.kind === 'success') {
    backfillNote = ` In the meantime we automatically pulled the latest from HCP (${backfillOutcome.summary}), so your CRM should already be caught up.`;
  } else if (backfillOutcome.kind === 'threw') {
    backfillNote = ' We tried to pull the latest from HCP automatically but the API call failed — please use the Resync now button after fixing the webhook.';
  }

  const apiNote = backfillOutcome.kind === 'success'
    ? `The HCP API connection is working, so the webhook delivery is the issue (most likely it was disabled or its URL changed in the HCP dashboard).${backfillNote} To fix it: open the HCP webhook settings and re-enable the URL, then click Resync now in the integration card here.`
    : 'The HCP API connection test also failed — your API key may need to be updated. Once the connection is restored, click Resync now in the integration card here to pull anything missed.';

  const ageHours = Math.round(ageMs / 3600000 * 10) / 10;

  for (const admin of adminUsers) {
    await db.insert(notifications).values({
      userId: admin.userId,
      contractorId,
      type: 'system',
      title: 'Housecall Pro Webhooks May Be Disabled',
      message: `No webhook events have been received from Housecall Pro in the last ${ageHours} hours, so real-time updates for leads, estimates, and jobs may have stopped. ${apiNote}`,
      link: '/settings/integrations',
    });
  }

  await markIncidentNotified(incident.id);
  broadcastToContractor(contractorId, { type: 'notification_updated' });
  log.info(`Sent webhook health alert to ${adminUsers.length} admin(s) for contractor ${contractorId}`);
}

/**
 * Attempts an auto-backfill against an open staleness incident. Always
 * stamps `backfillAttemptedAt` on success so future ticks skip the retry
 * path. On failure (API unreachable / threw), leaves it null so a later
 * tick can try again once the HCP API is reachable.
 */
type BackfillOutcome =
  | { kind: 'success'; summary: string }
  | { kind: 'api_down' }
  | { kind: 'threw' };

async function tryBackfillForOpenIncident(
  contractorId: string,
  incidentId: string,
  lastEventAt: Date | null,
  phase: 'initial' | 'retry',
): Promise<BackfillOutcome> {
  let apiConnected = false;
  try {
    const apiResult = await housecallProService.getEmployees(contractorId);
    apiConnected = apiResult.success;
    if (!apiConnected) {
      log.warn(`Contractor ${contractorId}: HCP API connection failed (${phase}) — API key may be invalid or expired`);
    }
  } catch (apiErr) {
    log.warn(`Contractor ${contractorId}: error checking HCP API connection (${phase})`, apiErr);
  }

  if (!apiConnected) {
    return { kind: 'api_down' };
  }

  try {
    const result = await runHcpWebhookBackfill(contractorId, lastEventAt);
    const summary = summarizeBackfill(result);
    await markIncidentBackfill(incidentId, summary);
    log.info(`[backfill] contractor=${contractorId} ${phase} auto-backfill complete — ${summary}`);
    return { kind: 'success', summary };
  } catch (err) {
    log.error(`[backfill] contractor=${contractorId} ${phase} auto-backfill threw`, err);
    return { kind: 'threw' };
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
      eq(webhookEvents.service, SERVICE_HCP),
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
        eq(webhookEvents.service, SERVICE_HCP),
        eq(webhookEvents.eventType, 'rejection'),
        gte(webhookEvents.createdAt, windowStart),
      ))
      .groupBy(webhookEvents.errorMessage),
    db.select({ count: sql<number>`count(*)` })
      .from(webhookEvents)
      .where(and(
        eq(webhookEvents.contractorId, contractorId),
        eq(webhookEvents.service, SERVICE_HCP),
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
      eq(webhookEvents.service, SERVICE_HCP),
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
      eq(webhookEvents.service, SERVICE_HCP),
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
  lastBackfillAt: Date | null;
  lastBackfillSummary: string | null;
  backfillInProgress: boolean;
}> {
  const [latestEventResult, rejectionSpikeResult, rejectionCount24h, lastBackfill] = await Promise.all([
    db.select({ createdAt: webhookEvents.createdAt })
      .from(webhookEvents)
      .where(and(
        eq(webhookEvents.contractorId, contractorId),
        eq(webhookEvents.service, SERVICE_HCP),
        ne(webhookEvents.eventType, 'rejection'),
      ))
      .orderBy(desc(webhookEvents.createdAt))
      .limit(1),
    checkRejectionSpike(contractorId),
    getRejectionCount24h(contractorId),
    getLastBackfill(contractorId),
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
    lastBackfillAt: lastBackfill?.attemptedAt ?? null,
    lastBackfillSummary: lastBackfill?.summary ?? null,
    backfillInProgress: manualBackfillsInProgress.has(contractorId),
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
            eq(webhookEvents.service, SERVICE_HCP),
            ne(webhookEvents.eventType, 'rejection'),
          ))
          .orderBy(desc(webhookEvents.createdAt))
          .limit(1);

        const lastEventAt = latestEventResult[0]?.createdAt;
        if (!lastEventAt) continue;

        const ageMs = Date.now() - lastEventAt.getTime();
        if (ageMs < FAST_CHECK_THRESHOLD_MS) continue;

        // Already an open incident → notification was already sent in the
        // previous boot, do NOT re-notify (this is the whole point of
        // persisting the marker).
        const existing = await getOpenIncident(contractorId, KIND_STALENESS);
        if (existing) {
          log.info(`Startup fast-check: contractor ${contractorId} — open staleness incident already exists, suppressing duplicate alert`);
          continue;
        }

        let apiConnected = false;
        try {
          const apiResult = await housecallProService.getEmployees(contractorId);
          apiConnected = apiResult.success;
        } catch (_) { /* ignore */ }

        if (!apiConnected) {
          log.info(`Startup fast-check: contractor ${contractorId} — API not reachable, skipping alert`);
          continue;
        }

        const { incident, created } = await openIncidentAtomic(contractorId, KIND_STALENESS);
        if (!created) {
          log.info(`Startup fast-check: contractor ${contractorId} — staleness incident already exists (race), skipping`);
          continue;
        }
        const ageHours = Math.round(ageMs / 3600000 * 10) / 10;
        log.warn(`Startup fast-check: contractor ${contractorId} — no HCP webhook events in ${ageHours}h but API is alive, alerting admins`);

        // Auto-backfill on the startup path too — same logic as the
        // periodic checker, kept inline so the message can mention what
        // we already pulled.
        let backfillNote = '';
        try {
          const result = await runHcpWebhookBackfill(contractorId, lastEventAt);
          const summaryText = summarizeBackfill(result);
          await markIncidentBackfill(incident.id, summaryText);
          backfillNote = ` We already pulled the latest from HCP for you (${summaryText}).`;
        } catch (err) {
          log.error(`[backfill] contractor=${contractorId} startup auto-backfill threw`, err);
        }

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
            title: 'Housecall Pro Webhooks May Be Disabled',
            message: `No HCP webhook events have been received in the last ${ageHours} hours.${backfillNote} Open Settings → Integrations → Housecall Pro to verify the webhook URL is still active in the HCP dashboard, then click Resync now to pull anything that may still be missing.`,
            link: '/settings/integrations',
          });
        }

        await markIncidentNotified(incident.id);
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
