import { db } from '../db';
import { estimates } from '@shared/schema';
import { sql } from 'drizzle-orm';
import type { BookingRequest, SalespersonInfo } from '../types/scheduling';
import { logger } from '../utils/logger';
import { storage } from '../storage';

const log = logger('HcpSchedulingService');

/**
 * Creates or updates the local CRM estimate record linked to this booking.
 * If a webhook already created the estimate (via hcpEstimateId), it is updated
 * in place instead of duplicated.
 *
 * Returns the local CRM estimate id so callers can attach follow-up activity
 * rows (e.g. the customer's booking note) directly to the estimate. Returns
 * `undefined` only when an unexpected error path leaves no row to attach to —
 * callers should treat this as "estimate-link unknown" and fall back to a
 * contact-only attachment.
 */
export async function createCrmEstimate(
  tenantId: string,
  contactId: string,
  salesperson: SalespersonInfo,
  request: BookingRequest,
  endTime: Date,
  hcpEstimateId?: string
): Promise<string | undefined> {
  const baseValues = {
    contractorId: tenantId,
    contactId,
    title: request.title || 'Scheduled Estimate',
    description: request.notes,
    amount: '0',
    status: 'scheduled' as const,
    scheduledStart: request.startTime,
    scheduledEnd: endTime,
    scheduledEmployeeId: salesperson.housecallProUserId || undefined,
  };

  const hcpValues = hcpEstimateId ? {
    housecallProEstimateId: hcpEstimateId,
    externalId: hcpEstimateId,
    externalSource: 'housecall-pro' as const,
    syncedAt: new Date(),
  } : {};

  if (hcpEstimateId) {
    try {
      const [upserted] = await db.insert(estimates)
        .values({ ...baseValues, ...hcpValues })
        .onConflictDoUpdate({
          target: [estimates.contractorId, estimates.externalSource, estimates.externalId],
          targetWhere: sql`external_id IS NOT NULL AND external_source IS NOT NULL`,
          set: {
            scheduledStart: request.startTime,
            scheduledEnd: endTime,
            scheduledEmployeeId: salesperson.housecallProUserId || undefined,
            status: 'scheduled',
            syncedAt: new Date(),
            updatedAt: new Date(),
          },
        })
        .returning();
      log.info(`[scheduling] Upserted CRM estimate: ${upserted.id}`);
      return upserted.id;
    } catch (conflictErr: unknown) {
      const errMsg = conflictErr instanceof Error ? conflictErr.message : String(conflictErr);
      log.warn(`[scheduling] onConflictDoUpdate failed (${errMsg}), falling back to sequential dedup`);
      const alreadyCreatedByWebhook = await storage.getEstimateByHousecallProEstimateId(hcpEstimateId, tenantId);
      if (alreadyCreatedByWebhook) {
        await storage.updateEstimate(alreadyCreatedByWebhook.id, {
          scheduledStart: request.startTime,
          scheduledEnd: endTime,
          status: 'scheduled',
          syncedAt: new Date(),
        }, tenantId);
        log.info('[scheduling] Fallback dedup: updated existing CRM estimate:', alreadyCreatedByWebhook.id);
        return alreadyCreatedByWebhook.id;
      }
      const [crmEstimate] = await db.insert(estimates).values({ ...baseValues, ...hcpValues }).returning();
      log.info(`[scheduling] Fallback: created CRM estimate: ${crmEstimate.id}`);
      return crmEstimate.id;
    }
  } else {
    const [crmEstimate] = await db.insert(estimates)
      .values({ ...baseValues, ...hcpValues })
      .returning();
    log.info(`[scheduling] Created CRM estimate (no HCP link): ${crmEstimate.id}`);
    return crmEstimate.id;
  }
}
