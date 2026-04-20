/**
 * server/sync/hcp-backfill-employee-id.ts
 *
 * One-time idempotent backfill: populate scheduledEmployeeId on estimates that
 * have a scheduledStart but a null scheduledEmployeeId.
 *
 * Background: historically imported HCP estimates were not written with the
 * employee assignment data, so the availability calculator treated those
 * time slots as free even though the salesperson was already booked.
 *
 * The fix runs once per tenant on every sync invocation but is fully idempotent:
 * it only touches rows where scheduledEmployeeId IS NULL, so rows that have
 * already been backfilled are silently skipped.
 *
 * Rate-limiting: to avoid hammering the HCP API, estimates are fetched one at
 * a time with a small delay between calls (DELAY_BETWEEN_CALLS_MS).
 */

import { db } from '../db';
import { estimates } from '@shared/schema';
import { and, isNull, isNotNull, eq } from 'drizzle-orm';
import { housecallProService } from '../hcp/index';
import { extractHcpScheduledEmployeeId } from './hcp-mappers';
import { logger } from '../utils/logger';

const log = logger('HcpBackfillEmployeeId');

const DELAY_BETWEEN_CALLS_MS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Backfill scheduledEmployeeId for all estimates belonging to `tenantId` that
 * have a scheduledStart but a null scheduledEmployeeId.
 *
 * Safe to call multiple times — only unset rows are touched.
 */
export async function backfillScheduledEmployeeId(tenantId: string): Promise<void> {
  const rows = await db
    .select({
      id: estimates.id,
      housecallProEstimateId: estimates.housecallProEstimateId,
    })
    .from(estimates)
    .where(
      and(
        eq(estimates.contractorId, tenantId),
        isNotNull(estimates.scheduledStart),
        isNull(estimates.scheduledEmployeeId),
        isNotNull(estimates.housecallProEstimateId),
      )
    );

  if (rows.length === 0) {
    log.info(`[backfill] No estimates need backfill for tenant ${tenantId}`);
    return;
  }

  log.info(`[backfill] ${rows.length} estimates need scheduledEmployeeId backfill for tenant ${tenantId}`);

  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of rows) {
    const hcpId = row.housecallProEstimateId!;
    try {
      const result = await housecallProService.getEstimate(tenantId, hcpId);

      if (!result.success || !result.data) {
        log.warn(`[backfill] Could not fetch HCP estimate ${hcpId} for tenant ${tenantId}: ${result.error}`);
        skipped++;
        await sleep(DELAY_BETWEEN_CALLS_MS);
        continue;
      }

      const employeeId = extractHcpScheduledEmployeeId(result.data);

      if (!employeeId) {
        log.info(`[backfill] HCP estimate ${hcpId} has no employee assignment — skipping`);
        skipped++;
        await sleep(DELAY_BETWEEN_CALLS_MS);
        continue;
      }

      await db
        .update(estimates)
        .set({ scheduledEmployeeId: employeeId })
        .where(
          and(
            eq(estimates.id, row.id),
            eq(estimates.contractorId, tenantId),
          )
        );

      log.info(`[backfill] Updated estimate ${row.id} (HCP: ${hcpId}) with scheduledEmployeeId=${employeeId}`);
      updated++;
    } catch (err) {
      log.error(`[backfill] Error processing estimate ${row.id} (HCP: ${hcpId}):`, err);
      failed++;
    }

    await sleep(DELAY_BETWEEN_CALLS_MS);
  }

  log.info(`[backfill] Completed for tenant ${tenantId} — updated: ${updated}, skipped: ${skipped}, failed: ${failed}`);
}
