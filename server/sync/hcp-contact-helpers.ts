import { storage } from '../storage';
import type { HcpEstimate, HcpCustomer } from './hcp-types';

import { logger } from '../utils/logger';

const log = logger('HcpContactHelpers');

const EXCLUDED_SENTINEL = '__hcp_excluded__';

/**
 * resolveHcpContact — finds (or creates) the local contact for an HCP customer.
 *
 * Matching strategy (in priority order):
 *   0. Check if the HCP customer ID has been excluded (user deleted the contact).
 *      If excluded, return the sentinel value so callers know to skip creation.
 *   1. By `housecall_pro_customer_id` (indexed — fastest path).
 *   2. By phone number fuzzy match.
 *   3. By email match.
 *   4. If no match, returns `null` — the caller decides whether to create a
 *      new contact (estimates/jobs do; employees do not).
 */
export function isExcludedResult(result: string | null): boolean {
  return result === EXCLUDED_SENTINEL;
}

export async function resolveHcpContact(
  hcpCustomerId: string | undefined,
  hcpCustomer: HcpCustomer | undefined,
  tenantId: string,
): Promise<string | null> {
  if (hcpCustomerId) {
    const excluded = await storage.isHcpCustomerExcluded(tenantId, hcpCustomerId);
    if (excluded) {
      log.info(`[resolveHcpContact] HCP customer ${hcpCustomerId} is excluded for tenant ${tenantId}, skipping`);
      return EXCLUDED_SENTINEL;
    }

    const existing = await storage.getContactByHousecallProCustomerId(hcpCustomerId, tenantId);
    if (existing) return existing.id;
  }

  if (!hcpCustomer) return null;

  const customerPhone =
    hcpCustomer.mobile_number || hcpCustomer.home_number || hcpCustomer.work_number ||
    (hcpCustomer.phone_numbers?.[0]?.phone_number);
  const customerEmail = hcpCustomer.email;

  if (customerPhone) {
    const phoneMatch = await storage.getContactByPhone(customerPhone, tenantId);
    if (phoneMatch) {
      if (hcpCustomerId) {
        await storage.updateContact(phoneMatch.id, { housecallProCustomerId: hcpCustomerId }, tenantId);
      }
      return phoneMatch.id;
    }
  }

  if (customerEmail) {
    const emailMatch = await storage.findMatchingContact(tenantId, [customerEmail], undefined);
    if (emailMatch) {
      if (hcpCustomerId) {
        await storage.updateContact(emailMatch, { housecallProCustomerId: hcpCustomerId }, tenantId);
      }
      return emailMatch;
    }
  }

  return null;
}

export async function convertEstimateToJob(
  estimate: { id: string; contactId: string | null; title: string | null; amount: string | null },
  hcpEstimate: HcpEstimate,
  tenantId: string,
): Promise<void> {
  try {
    const existingJob = await storage.getJobByEstimateId(estimate.id, tenantId);
    if (existingJob) {
      log.info(`[sync-scheduler] Job already exists for estimate ${estimate.id}`);
      return;
    }

    const jobData = {
      contactId: estimate.contactId!,
      estimateId: estimate.id,
      title: estimate.title || 'Job from Approved Estimate',
      type: 'Installation',
      status: 'in_progress' as const,
      value: estimate.amount || '0',
      priority: 'medium' as const,
      scheduledDate: hcpEstimate.schedule?.scheduled_start ? new Date(hcpEstimate.schedule.scheduled_start) : null,
      estimatedHours: 4,
      externalId: hcpEstimate.id,
      externalSource: 'housecall-pro' as const,
    };

    const createdJob = await storage.createJob(jobData, tenantId);
    log.info(`[sync-scheduler] Created job from approved estimate: ${estimate.id} -> ${createdJob.id}`);
  } catch (error) {
    log.error(`[sync-scheduler] Failed to convert estimate ${estimate.id} to job:`, error);
  }
}

/**
 * Resolves an HCP estimate ID to a local estimate and, if that estimate is not
 * already marked `approved`, updates it. Returns the local estimate's ID so
 * callers can use it to link the job — or `undefined` if no matching estimate
 * exists in the DB.
 */
export async function markLinkedEstimateApproved(
  hcpEstimateId: string,
  tenantId: string,
  jobRef: string,
): Promise<string | undefined> {
  const linkedEst = await storage.getEstimateByHousecallProEstimateId(hcpEstimateId, tenantId);
  if (!linkedEst) return undefined;
  if (linkedEst.status !== 'approved') {
    await storage.updateEstimate(linkedEst.id, { status: 'approved' }, tenantId);
    log.info(
      `[sync-scheduler] Marked estimate ${linkedEst.id} (HCP: ${hcpEstimateId}) as approved — linked to job ${jobRef}`,
    );
  }
  return linkedEst.id;
}
