/**
 * server/sync/housecall-pro.ts — Housecall Pro sync orchestrator.
 *
 * This file is the top-level entry point: it calls the three sub-modules in
 * sequence and re-exports the public symbols that callers rely on.
 *
 * Sub-modules:
 *   hcp-employees.ts  — employee list sync
 *   hcp-estimates.ts  — estimate page-by-page sync
 *   hcp-jobs.ts       — job page-by-page sync
 *
 * Shared primitives:
 *   hcp-types.ts      — TypeScript interfaces + shared constants
 *   hcp-mappers.ts    — status-mapping pure functions
 *   hcp-contact-helpers.ts — contact resolution, estimate→job conversion
 */

import { logger } from '../utils/logger';
import { CredentialService } from '../credential-service';
import { housecallProService } from '../hcp/index';

const log = logger('HcpSync');

export { mapHcpEstimateStatus, mapHcpJobStatus } from './hcp-mappers';
export { syncHousecallProEmployees } from './hcp-employees';
export { syncHousecallProEstimates } from './hcp-estimates';
export { syncHousecallProJobs } from './hcp-jobs';
export { syncHcpCalendarEvents } from './hcp-calendar-events';

import { syncHousecallProEmployees } from './hcp-employees';
import { syncHousecallProEstimates } from './hcp-estimates';
import { syncHousecallProJobs } from './hcp-jobs';
import { syncHcpCalendarEvents } from './hcp-calendar-events';
import { backfillScheduledEmployeeId } from './hcp-backfill-employee-id';

/**
 * Fetches the HCP lead source list and caches it in contractor_credentials
 * under key `lead_sources_cache` (JSON array of name strings).
 */
export async function syncHcpLeadSources(tenantId: string): Promise<void> {
  try {
    const result = await housecallProService.getLeadSources(tenantId);
    if (result.success && result.data) {
      await CredentialService.setCredential(
        tenantId,
        'housecall-pro',
        'lead_sources_cache',
        JSON.stringify(result.data),
      );
      log.info(`[HcpSync] Cached ${result.data.length} lead sources for tenant ${tenantId}`);
    } else {
      log.warn(`[HcpSync] Failed to fetch lead sources for tenant ${tenantId}: ${result.error}`);
    }
  } catch (err) {
    log.warn(`[HcpSync] Error syncing lead sources for tenant ${tenantId}:`, err);
  }
}

export async function syncHousecallPro(tenantId: string): Promise<void> {
  log.info(`[sync-scheduler] Syncing Housecall Pro data for tenant ${tenantId}`);
  await syncHcpLeadSources(tenantId);
  await syncHousecallProEmployees(tenantId);
  await syncHousecallProEstimates(tenantId);
  await syncHousecallProJobs(tenantId);
  await syncHcpCalendarEvents(tenantId);

  try {
    await backfillScheduledEmployeeId(tenantId);
  } catch (err) {
    log.warn(`[sync-scheduler] scheduledEmployeeId backfill failed for tenant ${tenantId} (non-fatal):`, err);
  }
}
