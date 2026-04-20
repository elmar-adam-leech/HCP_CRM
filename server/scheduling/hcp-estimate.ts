import { db } from '../db';
import { estimates, leads } from '@shared/schema';
import { eq, and, desc, isNotNull } from 'drizzle-orm';
import { housecallProService } from '../hcp/index';
import type { BookingRequest, SalespersonInfo, AddressComponents } from '../types/scheduling';
import type { HousecallProEstimate, HcpLeadConvertResponse } from '../hcp/types';
import { logger } from '../utils/logger';
import { ARRIVAL_WINDOW_MINUTES } from './availability';
import { resolveAddressComponents } from './hcp-customer';

const log = logger('HcpSchedulingService');

/**
 * Builds a notes string with the service address appended.
 */
function buildNotesWithAddress(notes: string | undefined, address: AddressComponents | undefined): string {
  const base = notes || '';
  if (!address?.street) return base || 'Scheduled estimate appointment';
  const addressLine = [address.street, address.city, address.state, address.zip]
    .filter(Boolean).join(', ');
  const addressBlock = `Service Address: ${addressLine}`;
  return base ? `${base}\n\n${addressBlock}` : addressBlock;
}

export interface HcpEstimateResult {
  hcpEstimateId: string;
  scheduleError?: string;
}

/**
 * Attempts to recover the HCP estimate that was just created by a convertLead
 * call when the response did not include a parseable estimate ID.
 * Fetches the most recent estimate for the given HCP customer and returns it
 * if it was created within the last 2 minutes, otherwise returns undefined.
 * This avoids creating a duplicate estimate when the conversion actually succeeded.
 */
async function recoverConvertedEstimate(
  tenantId: string,
  hcpCustomerId: string,
): Promise<HousecallProEstimate | undefined> {
  const RECOVER_WINDOW_MS = 2 * 60 * 1000;
  const listResult = await housecallProService.getEstimates(tenantId, {
    customer_id: hcpCustomerId,
    sort_by: 'created_at',
    sort_direction: 'desc',
    page_size: 5,
  });
  if (!listResult.success || !listResult.data?.length) {
    return undefined;
  }
  const cutoff = new Date(Date.now() - RECOVER_WINDOW_MS);
  for (const est of listResult.data) {
    const createdAt = est.created_at ? new Date(est.created_at) : null;
    if (createdAt && createdAt >= cutoff) {
      log.info(`[scheduling] Recovered recently-converted estimate ${est.id} for HCP customer ${hcpCustomerId} (created ${createdAt.toISOString()})`);
      const fullResult = await housecallProService.getEstimate(tenantId, est.id);
      if (fullResult.success && fullResult.data) {
        return fullResult.data;
      }
      log.warn(`[scheduling] Could not fetch full estimate ${est.id} during recovery, using list entry`);
      return est;
    }
  }
  return undefined;
}

/**
 * Creates (or converts from lead) an HCP estimate for this booking, then
 * updates the first option's schedule with the appointment time.
 * Returns an object with the HCP estimate ID and an optional scheduleError
 * when the estimate was created but scheduling failed.
 * Returns undefined when the estimate itself could not be created.
 */
export async function createOrConvertHcpEstimate(
  tenantId: string,
  hcpCustomerId: string,
  salesperson: SalespersonInfo,
  request: BookingRequest,
  endTime: Date,
  contactAddress?: string | null,
  contact?: { street?: string | null; city?: string | null; state?: string | null; zip?: string | null } | null
): Promise<HcpEstimateResult | undefined> {
  const estimateAddress = resolveAddressComponents(request, contactAddress, contact);

  let hcpLeadId: string | undefined;
  if (request.contactId) {
    const [leadWithHcpId] = await db.select()
      .from(leads)
      .where(and(
        eq(leads.contactId, request.contactId),
        eq(leads.contractorId, tenantId),
        isNotNull(leads.housecallProLeadId),
      ))
      .orderBy(desc(leads.createdAt))
      .limit(1);
    if (leadWithHcpId?.housecallProLeadId) {
      hcpLeadId = leadWithHcpId.housecallProLeadId;
    }
  }

  const hcpEmployeeId: string | undefined = salesperson.housecallProUserId ?? undefined;

  let rawEstimateData: HousecallProEstimate | undefined;
  let usedConvertPath = false;
  let usedReusePath = false;

  const RETRY_DEDUP_WINDOW_MS = 5 * 60 * 1000;
  if (request.contactId) {
    const dedupeThreshold = new Date(Date.now() - RETRY_DEDUP_WINDOW_MS);
    const [recentEstimate] = await db.select()
      .from(estimates)
      .where(and(
        eq(estimates.contactId, request.contactId),
        eq(estimates.contractorId, tenantId),
        isNotNull(estimates.housecallProEstimateId),
      ))
      .orderBy(desc(estimates.createdAt))
      .limit(1);

    if (
      recentEstimate?.housecallProEstimateId &&
      recentEstimate.createdAt &&
      recentEstimate.createdAt >= dedupeThreshold
    ) {
      log.info(`[scheduling] Found recent HCP estimate ${recentEstimate.housecallProEstimateId} (created ${recentEstimate.createdAt.toISOString()}) for contact — reusing to avoid duplicate on retry`);
      const existingHcpResult = await housecallProService.getEstimate(tenantId, recentEstimate.housecallProEstimateId);
      if (existingHcpResult.success && existingHcpResult.data) {
        rawEstimateData = existingHcpResult.data;
        usedConvertPath = false;
        usedReusePath = true;

        // Apply the booking's address + notes onto the reused estimate so a
        // re-schedule / quick retry doesn't silently inherit the previous
        // booking's data.
        const reuseNotesText = request.notes || '';
        const reuseHasNotes = reuseNotesText.length > 0;
        const reuseHasAddress = !!estimateAddress?.street;
        if (reuseHasNotes || reuseHasAddress) {
          const updatePayload: Partial<HousecallProEstimate> = {};
          const notesWithAddress = buildNotesWithAddress(reuseNotesText || undefined, estimateAddress);
          updatePayload.message = notesWithAddress;
          const firstOptionId = rawEstimateData.options?.[0]?.id;
          if (firstOptionId) {
            updatePayload.options = [{ id: firstOptionId, message: notesWithAddress }];
          }
          if (reuseHasAddress) {
            updatePayload.address = {
              street: estimateAddress!.street,
              city: estimateAddress!.city,
              state: estimateAddress!.state,
              zip: estimateAddress!.zip,
              country: estimateAddress!.country || 'US',
            };
          }
          log.info(`[scheduling] Updating reused estimate ${rawEstimateData.id} with notes/address (notes=${reuseHasNotes}, address=${reuseHasAddress})`);
          try {
            const updateResult = await housecallProService.updateEstimate(tenantId, rawEstimateData.id, updatePayload);
            if (updateResult.success) {
              log.info(`[scheduling] Successfully updated reused estimate ${rawEstimateData.id} with notes/address`);
            } else {
              log.warn(`[scheduling] Failed to update reused estimate ${rawEstimateData.id}: ${updateResult.error}`);
            }
          } catch (err) {
            log.warn(`[scheduling] Unexpected error updating reused estimate ${rawEstimateData.id}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    }
  }

  if (!rawEstimateData) {
    if (hcpLeadId) {
      log.info(`[scheduling] Converting HCP lead ${hcpLeadId} to estimate (convert path)`);
      const convertResult = await housecallProService.convertLead(tenantId, hcpLeadId, {
        employee_id: hcpEmployeeId,
      });
      if (convertResult.success && convertResult.data) {
        const responseData = convertResult.data as HousecallProEstimate | HcpLeadConvertResponse;
        const asConvertResponse = responseData as HcpLeadConvertResponse;
        const asEstimate = responseData as HousecallProEstimate;

        const hasConversionsArray = Array.isArray(asConvertResponse.conversions);

        if (hasConversionsArray) {
          const conversionId = (asConvertResponse.conversions as Array<{ id: string }>)[0]?.id;
          if (conversionId) {
            log.info(`[scheduling] convertLead returned lead object with conversion ID: ${conversionId}`);
            const estimateResult = await housecallProService.getEstimate(tenantId, conversionId);
            if (estimateResult.success && estimateResult.data) {
              rawEstimateData = estimateResult.data;
              usedConvertPath = true;
            } else {
              rawEstimateData = { id: conversionId } as HousecallProEstimate;
              usedConvertPath = true;
              log.warn(`[scheduling] Could not fetch converted estimate ${conversionId} from HCP, using synthetic object`);
            }
          } else {
            log.warn(`[scheduling] convertLead returned lead object with empty conversions array; attempting HCP customer estimate lookup`);
            const recoveredEstimate = await recoverConvertedEstimate(tenantId, hcpCustomerId);
            if (recoveredEstimate) {
              rawEstimateData = recoveredEstimate;
              usedConvertPath = true;
            } else {
              log.warn(`[scheduling] Could not recover converted estimate for HCP customer ${hcpCustomerId}; aborting to avoid duplicate`);
            }
          }
        } else if (asEstimate.id) {
          rawEstimateData = asEstimate;
          usedConvertPath = true;
        } else {
          log.warn(`[scheduling] convertLead succeeded but response has no usable ID; attempting HCP customer estimate lookup`);
          const recoveredEstimate = await recoverConvertedEstimate(tenantId, hcpCustomerId);
          if (recoveredEstimate) {
            rawEstimateData = recoveredEstimate;
            usedConvertPath = true;
          } else {
            log.warn(`[scheduling] Could not recover converted estimate for HCP customer ${hcpCustomerId}; aborting to avoid duplicate`);
          }
        }
      } else {
        log.warn(`[scheduling] Convert lead failed (${convertResult.error}), falling back to createEstimate`);
        const fallbackNotes = request.notes || request.title || 'Estimate appointment';
        const fallbackResult = await housecallProService.createEstimate(tenantId, {
          customer_id: hcpCustomerId,
          employee_id: hcpEmployeeId,
          message: buildNotesWithAddress(fallbackNotes, estimateAddress),
          options: [{ name: request.title || 'Estimate Appointment', message: buildNotesWithAddress(fallbackNotes, estimateAddress) }],
          address: estimateAddress,
        });
        if (fallbackResult.success) rawEstimateData = fallbackResult.data;
      }

      if (usedConvertPath && rawEstimateData) {
        const notesText = request.notes || '';
        const hasNotes = notesText.length > 0;
        const hasAddress = !!estimateAddress?.street;

        if (hasNotes || hasAddress) {
          const updatePayload: Partial<HousecallProEstimate> = {};
          const notesWithAddress = buildNotesWithAddress(notesText || undefined, estimateAddress);
          updatePayload.message = notesWithAddress;
          const firstOptionId = rawEstimateData.options?.[0]?.id;
          if (firstOptionId) {
            updatePayload.options = [{ id: firstOptionId, message: notesWithAddress }];
          }
          if (hasAddress) {
            updatePayload.address = {
              street: estimateAddress!.street,
              city: estimateAddress!.city,
              state: estimateAddress!.state,
              zip: estimateAddress!.zip,
              country: estimateAddress!.country || 'US',
            };
          }
          log.info(`[scheduling] Updating converted estimate ${rawEstimateData.id} with notes/address (notes=${hasNotes}, address=${hasAddress})`);
          try {
            const updateResult = await housecallProService.updateEstimate(tenantId, rawEstimateData.id, updatePayload);
            if (updateResult.success) {
              log.info(`[scheduling] Successfully updated converted estimate ${rawEstimateData.id} with notes/address`);
            } else {
              log.warn(`[scheduling] Failed to update converted estimate ${rawEstimateData.id}: ${updateResult.error}`);
            }
          } catch (err) {
            log.warn(`[scheduling] Unexpected error updating converted estimate ${rawEstimateData.id}: ${err instanceof Error ? err.message : String(err)}`);
          }
        } else {
          log.info(`[scheduling] Convert path used for estimate ${rawEstimateData.id} but no notes or address to apply`);
        }
      }
    } else {
      log.info('[scheduling] No HCP lead ID found, using direct createEstimate path');
      const directNotes = request.notes || request.title || 'Estimate appointment';
      const createResult = await housecallProService.createEstimate(tenantId, {
        customer_id: hcpCustomerId,
        employee_id: hcpEmployeeId,
        message: buildNotesWithAddress(directNotes, estimateAddress),
        options: [{ name: request.title || 'Estimate Appointment', message: buildNotesWithAddress(directNotes, estimateAddress) }],
        address: estimateAddress,
      });
      if (createResult.success) rawEstimateData = createResult.data;
    }
  }

  if (!rawEstimateData?.id) {
    log.warn('Failed to create/convert HCP estimate');
    return undefined;
  }

  const hcpEstimateId = rawEstimateData.id;
  const pathLabel = usedReusePath
    ? 'reused recent estimate'
    : usedConvertPath
      ? 'converted from lead'
      : 'direct create';
  log.info(`[scheduling] HCP estimate ready: ${hcpEstimateId} (${pathLabel})`);

  if (estimateAddress?.street) {
    const addressLine = [estimateAddress.street, estimateAddress.city, estimateAddress.state, estimateAddress.zip]
      .filter(Boolean).join(', ');
    const noteContent = `Service Address: ${addressLine}`;
    housecallProService.addEstimateNote(tenantId, hcpEstimateId, noteContent).then((noteResult) => {
      if (noteResult.success) {
        log.info(`[scheduling] Added address note to HCP estimate ${hcpEstimateId}`);
      } else {
        log.warn(`[scheduling] Failed to add address note to HCP estimate ${hcpEstimateId}: ${noteResult.error}`);
      }
    }).catch((err) => {
      log.warn(`[scheduling] Unexpected error adding address note to HCP estimate ${hcpEstimateId}: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  const customerNotes = (request.notes || '').trim();
  if (customerNotes.length > 0) {
    housecallProService.addEstimateNote(tenantId, hcpEstimateId, customerNotes).then((noteResult) => {
      if (noteResult.success) {
        log.info(`[scheduling] Added customer note to HCP estimate ${hcpEstimateId}`);
      } else {
        log.warn(`[scheduling] Failed to add customer note to HCP estimate ${hcpEstimateId}: ${noteResult.error}`);
      }
    }).catch((err) => {
      log.warn(`[scheduling] Unexpected error adding customer note to HCP estimate ${hcpEstimateId}: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  const optionId = rawEstimateData.options?.[0]?.id;
  let scheduleError: string | undefined;
  if (optionId && hcpEmployeeId) {
    log.info(`[scheduling] Updating HCP estimate option schedule, option: ${optionId}`);
    const scheduleResult = await housecallProService.updateEstimateOptionSchedule(
      tenantId,
      hcpEstimateId,
      optionId,
      {
        start_time: request.startTime.toISOString(),
        end_time: endTime.toISOString(),
        arrival_window_in_minutes: ARRIVAL_WINDOW_MINUTES,
        notify: false,
        notify_pro: true,
        dispatched_employees: [{ employee_id: hcpEmployeeId }],
      }
    );
    if (scheduleResult.success) {
      log.info('[scheduling] Successfully scheduled HCP estimate option');
    } else {
      const msg = `Estimate created in HCP (${hcpEstimateId}) but could not be scheduled: ${scheduleResult.error}`;
      log.warn(`[scheduling] ${msg}`);
      scheduleError = 'Estimate was created in HousecallPro but the date/time could not be set automatically. Please open HousecallPro to assign the appointment time.';
    }
  } else {
    log.warn('[scheduling] Could not get option ID from estimate, skipping schedule update');
    scheduleError = 'Estimate was created in HousecallPro but no option ID was found to schedule. Please open HousecallPro to assign the appointment time.';
  }

  return { hcpEstimateId, scheduleError };
}
