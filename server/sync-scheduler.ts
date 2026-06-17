/**
 * SyncScheduler — background job runner for integration data synchronisation.
 *
 * What it does:
 *   Polls the `sync_schedules` database table every SCHEDULER_POLL_INTERVAL_MS and
 *   runs any schedule whose `next_sync_at` timestamp has elapsed. Currently managed
 *   integrations: housecall-pro (daily), gmail (every 5 minutes).
 *
 * How to add a new sync provider:
 *   1. Create a `server/sync/<provider>.ts` module exporting an async `sync<Provider>(tenantId)` function.
 *   2. Register the integration name in `onIntegrationEnabled` / `onIntegrationDisabled`.
 *   3. Add a `case '<provider>':` entry in the `performSync` switch statement.
 *
 * Known scale limitation — in-memory lock (`activeSyncs`):
 *   Overlapping runs for the same tenant+integration are prevented with an in-memory Set.
 *   This is NOT safe for horizontal scaling (multiple server instances). If you ever run
 *   more than one server process you will need a distributed lock (e.g. Redis SETNX, or
 *   a `locked_at` database column with a heartbeat) instead.
 */
import { storage } from './storage';
import { isIntegrationEnabledCached } from './services/cache';
import { syncHousecallPro, syncHousecallProJobs } from './sync/housecall-pro';
import { syncGmail } from './sync/gmail';
import { syncFacebookLeads, getContractorsWithFacebookEnabled } from './sync/facebook-leads';
import {
  syncGoogleLocalServicesLeads,
  getContractorsWithGoogleLocalServicesEnabled,
  GLS_SERVICE,
} from './sync/google-local-services-leads';
import { syncLeadCaptureInbox } from './services/lead-capture-sync';
import { logger } from './utils/logger';
import { formatDbError } from './utils/db-error';

const log = logger('SyncScheduler');

// Maximum time the scheduler will sleep before re-checking for due syncs (milliseconds).
// The scheduler normally wakes exactly when the next sync is due; this cap ensures it
// never sleeps indefinitely if no syncs are scheduled, and also bounds how late a newly
// enabled sync can be picked up.
const SCHEDULER_MAX_SLEEP_MS = 5 * 60_000; // 5 minutes

// How long to wait before retrying a failed sync for non-lead-capture integrations (milliseconds)
const SYNC_RETRY_DELAY_MS = 60 * 60_000; // 1 hour

// Lead-capture retry backoff: starts at 5 minutes, doubles each failure, capped at 30 minutes
const LEAD_CAPTURE_RETRY_BASE_MS = 5 * 60_000;   // 5 minutes
const LEAD_CAPTURE_RETRY_MAX_MS  = 30 * 60_000;  // 30 minutes cap

export class SyncScheduler {
  private isRunning = false;
  private _scheduleTimer: NodeJS.Timeout | null = null;

  // In-memory failure counters for lead-capture exponential backoff.
  // Key format: "<contractorId>:lead-capture", value: consecutive failure count.
  private leadCaptureFailureCount = new Map<string, number>();

  // In-memory lock set to prevent overlapping syncs for the same tenant+integration.
  // Key format: "<tenantId>:<integrationName>"
  //
  // Without this, a slow sync (e.g., large HCP tenant taking >5 minutes) would be
  // started again by checkDueSyncs() on the next tick, creating concurrent runs that
  // can cause duplicate records and unique-constraint violations.
  //
  // The lock is released in a finally block so it is always cleared on both success
  // and failure. It is NOT persisted — on server restart, all locks are cleared and
  // any stale in-progress sync_schedule rows will be picked up naturally on the next
  // checkDueSyncs() tick.
  //
  // SCALING NOTE: This Set is in-process only. Running more than one Node.js process
  // (e.g. PM2 cluster mode, multiple pods) means each process has its own Set, so the
  // same tenant+integration sync can run simultaneously on different processes, causing
  // duplicate data and unique-constraint violations.
  //
  // To fix at scale: replace this Set with a distributed lock — e.g. Redis SETNX with
  // a TTL (so crashed processes auto-release the lock), or a `locked_at + locked_by`
  // column in the sync_schedules table updated atomically with a WHERE locked_at IS NULL
  // CAS update. Either approach ensures only one process holds the lock at a time.
  private activeSyncs = new Set<string>();

  /**
   * Start the adaptive sync scheduler.
   * Instead of polling on a fixed 60s interval, the scheduler queries the earliest
   * upcoming next_sync_at timestamp and sleeps precisely until then (capped at 5 min).
   * This eliminates most idle DB reads and lets the database suspend during quiet periods.
   */
  async start() {
    if (this.isRunning) {
      log.info('Already running');
      return;
    }

    log.info('Starting sync scheduler...');
    this.isRunning = true;

    await this.recoverSchedules();

    // Run immediately on startup, then schedule the next wake adaptively.
    this._tick();
  }

  /**
   * Run a single scheduler pass: recover any missing schedules, then process
   * all currently-due syncs once. Used by the standalone worker entrypoint
   * (server/worker.ts) so background syncs can run on a Replit Scheduled
   * Deployment instead of an always-on in-app timer. Does NOT arm the adaptive
   * self-scheduling timer — it resolves once the due syncs have been processed.
   */
  async runOnce(): Promise<void> {
    await this.recoverSchedules();
    await this.checkDueSyncs();
  }

  /**
   * Defensive schedule recovery: ensure every active integration has a sync
   * schedule row, self-healing missing rows after migrations, restarts, or any
   * other data loss. Shared by start() (in-app adaptive scheduler) and
   * runOnce() (scheduled-deployment worker) so both perform identical recovery
   * before checking for due syncs.
   */
  private async recoverSchedules(): Promise<void> {
    // Defensive schedule recovery: ensure every active lead-capture inbox has a sync schedule.
    // This self-heals missing rows after migrations, restarts, or any other data loss.
    try {
      const activeInboxes = await storage.getAllActiveLeadCaptureInboxes();
      for (const inbox of activeInboxes) {
        const existing = await storage.getSyncSchedule(inbox.contractorId, 'lead-capture');
        if (!existing) {
          await this.scheduleSync(inbox.contractorId, 'lead-capture', 'every-5-minutes');
          log.info(`[schedule-recovery] Restored missing lead-capture schedule for contractor: ${inbox.contractorId}`);
        }
      }
    } catch (err) {
      log.error(`[schedule-recovery] Failed to recover lead-capture schedules on startup: ${formatDbError(err)}`);
    }

    // Defensive schedule recovery: ensure every contractor with a connected
    // shared company email has the gmail integration enabled and a polling
    // schedule. Without this, tenants whose only inbound source is the shared
    // inbox would be skipped because performSync gates on isIntegrationEnabled.
    try {
      const sharedAccounts = await storage.getAllSharedEmailAccounts();
      for (const acct of sharedAccounts) {
        const enabled = await storage.isIntegrationEnabled(acct.contractorId, 'gmail');
        if (!enabled) {
          await storage.enableTenantIntegration(acct.contractorId, 'gmail', acct.connectedByUserId ?? undefined);
          log.info(`[schedule-recovery] Enabled gmail integration for shared-inbox-only contractor: ${acct.contractorId}`);
        }
        const existing = await storage.getSyncSchedule(acct.contractorId, 'gmail');
        if (!existing) {
          await this.scheduleSync(acct.contractorId, 'gmail', 'every-5-minutes');
          log.info(`[schedule-recovery] Restored missing gmail schedule for shared-inbox contractor: ${acct.contractorId}`);
        }
      }
    } catch (err) {
      log.error(`[schedule-recovery] Failed to recover shared-email gmail schedules on startup: ${formatDbError(err)}`);
    }

    // Defensive schedule recovery: ensure every contractor with Facebook Lead Ads
    // enabled has a polling schedule, in case the integration was connected before
    // automatic polling existed (or the schedule was deleted somehow).
    try {
      const fbContractorIds = await getContractorsWithFacebookEnabled();
      for (const contractorId of fbContractorIds) {
        const existing = await storage.getSyncSchedule(contractorId, 'facebook-leads');
        if (!existing) {
          await this.scheduleSync(contractorId, 'facebook-leads', 'every-5-minutes');
          log.info(`[schedule-recovery] Restored missing facebook-leads schedule for contractor: ${contractorId}`);
        }
      }
    } catch (err) {
      log.error(`[schedule-recovery] Failed to recover facebook-leads schedules on startup: ${formatDbError(err)}`);
    }

    // Same defensive recovery for Google Local Services Ads.
    try {
      const glsContractorIds = await getContractorsWithGoogleLocalServicesEnabled();
      for (const contractorId of glsContractorIds) {
        const existing = await storage.getSyncSchedule(contractorId, GLS_SERVICE);
        if (!existing) {
          await this.scheduleSync(contractorId, GLS_SERVICE, 'every-5-minutes');
          log.info(`[schedule-recovery] Restored missing ${GLS_SERVICE} schedule for contractor: ${contractorId}`);
        }
      }
    } catch (err) {
      log.error(`[schedule-recovery] Failed to recover ${GLS_SERVICE} schedules on startup: ${formatDbError(err)}`);
    }
  }

  /**
   * Stop the scheduler
   */
  stop() {
    log.info('Stopping sync scheduler...');
    this.isRunning = false;
    if (this._scheduleTimer) {
      clearTimeout(this._scheduleTimer);
      this._scheduleTimer = null;
    }
  }

  /**
   * Run one scheduler tick: process all due syncs, then schedule the next wake
   * to fire exactly when the next sync is due (capped at SCHEDULER_MAX_SLEEP_MS).
   */
  private _tick() {
    this.checkDueSyncs()
      .catch(err => log.error(`checkDueSyncs failed: ${formatDbError(err)}`))
      .finally(async () => {
        if (!this.isRunning) return;

        let sleepMs = SCHEDULER_MAX_SLEEP_MS;
        try {
          const nextDue = await storage.getNextDueSyncAt();
          if (nextDue) {
            const msUntilDue = nextDue.getTime() - Date.now();
            // If already overdue (msUntilDue <= 0), run again almost immediately.
            sleepMs = Math.min(Math.max(msUntilDue, 100), SCHEDULER_MAX_SLEEP_MS);
          }
        } catch (err) {
          log.error(`Failed to query next due sync time, falling back to max sleep: ${formatDbError(err)}`);
        }

        this._scheduleTimer = setTimeout(() => {
          this._scheduleTimer = null;
          if (this.isRunning) this._tick();
        }, sleepMs);
      });
  }

  /**
   * Add or update a sync schedule for a tenant
   */
  async scheduleSync(tenantId: string, integrationName: string, frequency: 'daily' | 'weekly' | 'hourly' | 'every-5-minutes' = 'daily') {
    const nextSyncAt = this.calculateNextSyncTime(frequency);
    const existing = await storage.getSyncSchedule(tenantId, integrationName);

    if (existing) {
      await storage.updateSyncSchedule(tenantId, integrationName, { frequency, nextSyncAt, isEnabled: true });
      log.info(`Updated ${frequency} sync for ${integrationName} (contractor: ${tenantId}) — next sync: ${nextSyncAt.toISOString()}`);
    } else {
      await storage.createSyncSchedule({ contractorId: tenantId, integrationName, frequency, nextSyncAt, isEnabled: true });
      log.info(`Created ${frequency} sync for ${integrationName} (contractor: ${tenantId}) — next sync: ${nextSyncAt.toISOString()}`);
    }
  }

  /**
   * Remove a sync schedule
   */
  async removeSchedule(tenantId: string, integrationName: string) {
    await storage.deleteSyncSchedule(tenantId, integrationName);
    // Clean up any in-memory failure counter so deregistered contractors don't
    // accumulate stale entries in leadCaptureFailureCount indefinitely.
    if (integrationName === 'lead-capture') {
      this.leadCaptureFailureCount.delete(`${tenantId}:lead-capture`);
    }
    log.info(`Removed sync schedule for ${integrationName} (contractor: ${tenantId})`);
  }

  /**
   * Get all schedules for a tenant
   */
  async getTenantSchedules(tenantId: string) {
    return await storage.getSyncSchedules(tenantId);
  }

  /**
   * Manually trigger a sync for a specific tenant and integration
   */
  async triggerSync(tenantId: string, integrationName: string): Promise<void> {
    log.info(`Manual sync triggered for ${integrationName} (tenant: ${tenantId})`);
    await this.performSync(tenantId, integrationName);
  }

  /**
   * Poll for syncs that are due to run based on their nextSyncAt timestamp.
   *
   * Queries the database for all sync_schedules where nextSyncAt <= now, then
   * delegates each to performSync().
   *
   * Each sync is protected by an in-memory lock (activeSyncs) so that a slow
   * sync started on a previous tick cannot be started again if it's still running.
   *
   * On failure, retry scheduling is integration-specific:
   *   - lead-capture: exponential backoff starting at 5 min, doubling per failure,
   *     capped at 30 min (tracked via in-memory leadCaptureFailureCount map).
   *   - all other integrations: flat 1-hour retry delay.
   */
  private async checkDueSyncs() {
    const now = new Date();

    // Sweep stale lead-capture failure counters: drop entries for contractors
    // that no longer have an active lead-capture sync schedule.
    if (this.leadCaptureFailureCount.size > 0) {
      for (const failKey of Array.from(this.leadCaptureFailureCount.keys())) {
        // failKey format: "<contractorId>:lead-capture"
        const contractorId = failKey.slice(0, failKey.lastIndexOf(':lead-capture'));
        const schedule = await storage.getSyncSchedule(contractorId, 'lead-capture');
        if (!schedule || !schedule.isEnabled) {
          this.leadCaptureFailureCount.delete(failKey);
          log.info(`[sweep] Removed stale lead-capture failure counter for contractor: ${contractorId}`);
        }
      }
    }

    const dueSchedules = await storage.getDueSyncSchedules();

    for (const schedule of dueSchedules) {
      log.info(`Sync due for ${schedule.integrationName} (contractor: ${schedule.contractorId})`);

      try {
        await this.performSync(schedule.contractorId, schedule.integrationName);

        const nextSyncAt = this.calculateNextSyncTime(schedule.frequency, now);
        await storage.updateSyncSchedule(schedule.contractorId, schedule.integrationName, {
          lastSyncAt: now,
          nextSyncAt,
        });

        // Clear any lead-capture failure counter on success
        if (schedule.integrationName === 'lead-capture') {
          this.leadCaptureFailureCount.delete(`${schedule.contractorId}:lead-capture`);
        }

        log.info(`Sync completed for ${schedule.integrationName} (contractor: ${schedule.contractorId}) — next sync: ${nextSyncAt.toISOString()}`);
      } catch (error) {
        log.error(`Sync failed for ${schedule.integrationName} (contractor: ${schedule.contractorId}): ${formatDbError(error)}`);

        let retryDelayMs: number;
        if (schedule.integrationName === 'lead-capture') {
          const failKey = `${schedule.contractorId}:lead-capture`;
          const failures = (this.leadCaptureFailureCount.get(failKey) ?? 0) + 1;
          this.leadCaptureFailureCount.set(failKey, failures);
          retryDelayMs = Math.min(LEAD_CAPTURE_RETRY_BASE_MS * Math.pow(2, failures - 1), LEAD_CAPTURE_RETRY_MAX_MS);
        } else {
          retryDelayMs = SYNC_RETRY_DELAY_MS;
        }

        const retryAt = new Date(now.getTime() + retryDelayMs);
        await storage.updateSyncSchedule(schedule.contractorId, schedule.integrationName, { nextSyncAt: retryAt });
        log.info(`Retry scheduled for: ${retryAt.toISOString()}`);
      }
    }
  }

  /**
   * Perform the actual sync operation — delegates to sync module functions.
   *
   * Uses an in-memory lock (activeSyncs) to prevent overlapping runs for the
   * same tenant+integration combination. If a sync is already running, the new
   * request is dropped with a warning instead of stacking up. The lock is always
   * released in the finally block, even if the sync throws.
   */
  private async performSync(tenantId: string, integrationName: string): Promise<void> {
    const lockKey = `${tenantId}:${integrationName}`;

    if (this.activeSyncs.has(lockKey)) {
      log.warn(`Sync already in progress for ${integrationName} (tenant: ${tenantId}), skipping to prevent overlap`);
      return;
    }

    this.activeSyncs.add(lockKey);
    log.info(`Starting sync for ${integrationName} (tenant: ${tenantId})`);

    try {
      const isEnabled = await isIntegrationEnabledCached(tenantId, integrationName);
      if (!isEnabled) {
        log.info(`Integration ${integrationName} is disabled for tenant ${tenantId}, skipping sync`);
        return;
      }

      switch (integrationName) {
        case 'housecall-pro':
          await syncHousecallPro(tenantId);
          break;
        case 'gmail':
          await syncGmail(tenantId);
          break;
        case 'facebook-leads':
          await syncFacebookLeads(tenantId);
          break;
        case GLS_SERVICE:
          await syncGoogleLocalServicesLeads(tenantId);
          break;
        case 'lead-capture': {
          const inbox = await storage.getLeadCaptureInbox(tenantId);
          if (inbox && inbox.isActive) {
            await syncLeadCaptureInbox(inbox);
          }
          break;
        }
        default:
          log.warn(`Unknown integration: ${integrationName}`);
      }
    } catch (error) {
      log.error(`Sync failed for ${integrationName}: ${formatDbError(error)}`);
      throw error;
    } finally {
      this.activeSyncs.delete(lockKey);
    }
  }

  /**
   * Public method for syncing HCP jobs directly (called from the HCP route)
   */
  async syncHousecallProJobs(tenantId: string): Promise<void> {
    return syncHousecallProJobs(tenantId);
  }

  /**
   * Calculate the next sync time based on frequency
   */
  private calculateNextSyncTime(frequency: 'daily' | 'weekly' | 'hourly' | 'every-5-minutes', fromTime: Date = new Date()): Date {
    const next = new Date(fromTime);

    switch (frequency) {
      case 'every-5-minutes':
        next.setMinutes(next.getMinutes() + 5);
        break;
      case 'hourly':
        next.setHours(next.getHours() + 1);
        break;
      case 'daily':
        next.setDate(next.getDate() + 1);
        next.setHours(2, 0, 0, 0);
        break;
      case 'weekly':
        next.setDate(next.getDate() + 7);
        next.setHours(2, 0, 0, 0);
        break;
    }

    return next;
  }

  /**
   * Enable auto-scheduling when an integration is enabled
   */
  async onIntegrationEnabled(tenantId: string, integrationName: string) {
    if (integrationName === 'housecall-pro') {
      await this.scheduleSync(tenantId, integrationName, 'daily');
    } else if (integrationName === 'gmail') {
      await this.scheduleSync(tenantId, integrationName, 'every-5-minutes');
    } else if (integrationName === 'lead-capture') {
      await this.scheduleSync(tenantId, integrationName, 'every-5-minutes');
    } else if (integrationName === 'facebook-leads') {
      await this.scheduleSync(tenantId, integrationName, 'every-5-minutes');
    } else if (integrationName === GLS_SERVICE) {
      await this.scheduleSync(tenantId, integrationName, 'every-5-minutes');
    }
  }

  /**
   * Remove scheduling when an integration is disabled
   */
  async onIntegrationDisabled(tenantId: string, integrationName: string) {
    await this.removeSchedule(tenantId, integrationName);
  }
}

export const syncScheduler = new SyncScheduler();
