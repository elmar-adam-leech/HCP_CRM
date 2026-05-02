import { db } from '../db';
import { estimates, leads } from '@shared/schema';
import { eq, and, desc, isNotNull } from 'drizzle-orm';
import { housecallProService } from '../hcp/index';
import type { BookingRequest, SalespersonInfo, AddressComponents } from '../types/scheduling';
import type { HousecallProEstimate, HcpLeadConvertResponse } from '../hcp/types';
import { logger } from '../utils/logger';
import { ARRIVAL_WINDOW_MINUTES } from './availability';
import { resolveAddressComponents } from './hcp-customer';
import { createActivityAndBroadcast } from '../utils/activity';

const log = logger('HcpSchedulingService');

const ESTIMATE_NOTE_RETRY_DELAYS_MS = [250, 500, 1000];

// Stable token callers grep for to detect booker-note failures (vs. matching
// the human-readable scheduleError string).
export const BOOKER_NOTES_MISSING_TOKEN = '[booker_notes_missing]';

// HCP sometimes drops POST /estimates/{id}/notes immediately after convertLead.
// Short backoffs win the race in practice without delaying the response.
async function addEstimateNoteWithRetry(
  tenantId: string,
  estimateId: string,
  content: string,
  label: string,
): Promise<boolean> {
  for (let attempt = 0; attempt <= ESTIMATE_NOTE_RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      const delay = ESTIMATE_NOTE_RETRY_DELAYS_MS[attempt - 1];
      log.info(`[scheduling] Retrying ${label} note on HCP estimate ${estimateId} after ${delay}ms (attempt ${attempt + 1})`);
      await new Promise((r) => setTimeout(r, delay));
    }
    try {
      const result = await housecallProService.addEstimateNote(tenantId, estimateId, content);
      if (result.success) {
        log.info(`[scheduling] Added ${label} note to HCP estimate ${estimateId}${attempt > 0 ? ` (attempt ${attempt + 1})` : ''}`);
        return true;
      }
      log.info(`[scheduling] addEstimateNote(${label}) attempt ${attempt + 1} on ${estimateId} failed: ${result.error}`);
    } catch (err) {
      log.info(`[scheduling] addEstimateNote(${label}) attempt ${attempt + 1} on ${estimateId} threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  log.warn(`[scheduling] All ${ESTIMATE_NOTE_RETRY_DELAYS_MS.length + 1} attempts to add ${label} note to HCP estimate ${estimateId} failed`);
  return false;
}

// Re-fetches the estimate's notes feed and confirms the booker text landed.
// Substring match on the first 80 chars handles HCP's whitespace normalization.
async function verifyBookerNoteOnEstimate(
  tenantId: string,
  estimateId: string,
  bookerNote: string,
): Promise<boolean> {
  if (!bookerNote) return true;
  const needle = bookerNote.slice(0, 80);
  try {
    const result = await housecallProService.getEstimateNotes(tenantId, estimateId);
    if (!result.success || !result.data) {
      log.warn(`[scheduling] Could not verify booker note on estimate ${estimateId}: ${result.error ?? 'no data'}`);
      return false;
    }
    const found = result.data.some((n) => typeof n.content === 'string' && n.content.includes(needle));
    if (!found) {
      log.warn(`[scheduling] Verification fetch for estimate ${estimateId} did not contain booker note (${result.data.length} notes returned)`);
    }
    return found;
  } catch (err) {
    log.warn(`[scheduling] Verification fetch for estimate ${estimateId} threw: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

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
  contact?: { street?: string | null; city?: string | null; state?: string | null; zip?: string | null } | null,
  serviceAddressId?: string,
  /**
   * Set when the customer's service-address record was deleted and recreated
   * during sync (so any existing HCP estimate's `address_id` is now dangling).
   * Forces the reuse path to PATCH the existing estimate's address+address_id
   * onto the new record even outside the normal 5-minute retry-dedup window.
   */
  serviceAddressRecreated: boolean = false,
): Promise<HcpEstimateResult | undefined> {
  const estimateAddress = resolveAddressComponents(request, contactAddress, contact);
  log.info(`[scheduling] createOrConvertHcpEstimate entry: customerId=${hcpCustomerId} serviceAddressId=${serviceAddressId ?? '<none>'} serviceAddressRecreated=${serviceAddressRecreated}`);

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

    // Reuse the existing HCP estimate ONLY when it was created within the
    // 5-minute retry-dedup window. We intentionally do NOT widen this gate
    // for `serviceAddressRecreated`: doing so would mutate potentially old,
    // already-acted-on estimates (approved, rejected, archived) just because
    // a service-address record happened to get recreated during a much later
    // booking. Instead, when the dedupe window has elapsed, this branch
    // skips reuse and we fall through to creating a brand-new estimate
    // below — which will be pinned to the correct (new) `serviceAddressId`
    // on creation.
    //
    // `serviceAddressRecreated` only takes effect INSIDE this reuse path:
    // it forces the `address_id` PATCH on the just-selected reuse estimate,
    // covering the case where HCP echoes the new id back yet the local row
    // was already pinned to the deleted one.
    const withinDedupWindow =
      !!recentEstimate?.createdAt && recentEstimate.createdAt >= dedupeThreshold;

    if (recentEstimate?.housecallProEstimateId && withinDedupWindow) {
      log.info(`[scheduling] Reusing HCP estimate ${recentEstimate.housecallProEstimateId} (created ${recentEstimate.createdAt?.toISOString() ?? '<unknown>'}) — within retry-dedup window${serviceAddressRecreated ? ' (service-address recreated, will force address_id repin)' : ''}`);
      const existingHcpResult = await housecallProService.getEstimate(tenantId, recentEstimate.housecallProEstimateId);
      if (existingHcpResult.success && existingHcpResult.data) {
        rawEstimateData = existingHcpResult.data;
        usedConvertPath = false;
        usedReusePath = true;

        // Apply the booking's address + notes onto the reused estimate so a
        // re-schedule / quick retry doesn't silently inherit the previous
        // booking's data. When the address record was recreated we always
        // PATCH (even if everything else looks unchanged) so the dangling
        // `address_id` gets repinned.
        const reuseNotesText = request.notes || '';
        const reuseHasNotes = reuseNotesText.length > 0;
        const reuseHasAddress = !!estimateAddress?.street;
        if (reuseHasNotes || reuseHasAddress || serviceAddressRecreated) {
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
          if (serviceAddressId) {
            const currentAddrId = rawEstimateData.address_id || rawEstimateData.address?.id;
            // When the address record was recreated, the local `currentAddrId`
            // we just read may still equal `serviceAddressId` if HCP echoed
            // the new id back — but the estimate may have been pinned to the
            // old (now-deleted) id moments earlier. Force the PATCH in that
            // case so HCP's estimate row is unambiguously repinned.
            if (currentAddrId !== serviceAddressId || serviceAddressRecreated) {
              updatePayload.address_id = serviceAddressId;
            }
          }
          log.info(`[scheduling] Updating reused estimate ${rawEstimateData.id} with notes/address (notes=${reuseHasNotes}, address=${reuseHasAddress}, addressId=${updatePayload.address_id ?? '<unchanged>'}, recreated=${serviceAddressRecreated})`);
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
      // Pre-stage booker notes onto the lead before convert; HCP carries lead
      // notes forward into the estimate, dodging the post-convert race.
      // (PATCH /leads/{id} is not a real HCP endpoint — address pinning is
      // done via updateEstimate further down.)
      const preConvertNoteText = (request.notes || '').trim();
      if (preConvertNoteText.length > 0 || estimateAddress?.street) {
        const leadNoteContent = buildNotesWithAddress(
          preConvertNoteText.length > 0 ? preConvertNoteText : undefined,
          estimateAddress,
        );
        try {
          const leadNoteResult = await housecallProService.addLeadNote(tenantId, hcpLeadId, leadNoteContent);
          if (leadNoteResult.success) {
            log.info(`[scheduling] Pre-staged booker note onto HCP lead ${hcpLeadId} before convert (${leadNoteContent.length} chars)`);
          } else {
            log.warn(`[scheduling] Failed to pre-stage booker note on HCP lead ${hcpLeadId}: ${leadNoteResult.error}. Will rely on post-convert addEstimateNote retries.`);
          }
        } catch (err) {
          log.warn(`[scheduling] Unexpected error pre-staging booker note on HCP lead ${hcpLeadId}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

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
          address_id: serviceAddressId,
        });
        if (fallbackResult.success) rawEstimateData = fallbackResult.data;
      }

      if (usedConvertPath && rawEstimateData) {
        const notesText = request.notes || '';
        const hasNotes = notesText.length > 0;
        const hasAddress = !!estimateAddress?.street;

        if (hasNotes || hasAddress || serviceAddressId) {
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
          if (serviceAddressId) {
            updatePayload.address_id = serviceAddressId;
          }
          log.info(`[scheduling] Updating converted estimate ${rawEstimateData.id} with notes/address (notes=${hasNotes}, address=${hasAddress}, addressId=${updatePayload.address_id ?? '<none>'})`);
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
        address_id: serviceAddressId,
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
  log.info(`[scheduling] HCP estimate ready: ${hcpEstimateId} (${pathLabel}) addressId=${serviceAddressId ?? '<none>'}`);

  if (serviceAddressId) {
    try {
      const verifyResult = await housecallProService.getEstimate(tenantId, hcpEstimateId);
      if (verifyResult.success && verifyResult.data) {
        const persistedId = verifyResult.data.address_id || verifyResult.data.address?.id;
        if (persistedId === serviceAddressId) {
          log.info(`[scheduling] HCP estimate ${hcpEstimateId} address pinned to ${serviceAddressId}`);
        } else {
          log.warn(`[scheduling] HCP estimate ${hcpEstimateId} address did not pin to ${serviceAddressId} after PATCH; HCP returned ${JSON.stringify({ address_id: verifyResult.data.address_id, address: verifyResult.data.address })}`);
        }
      } else {
        log.warn(`[scheduling] HCP estimate ${hcpEstimateId} verify re-fetch failed (could not confirm address pin to ${serviceAddressId}): ${verifyResult.error}`);
      }
    } catch (err) {
      log.warn(`[scheduling] HCP estimate ${hcpEstimateId} verify re-fetch threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Notes are awaited; failures surface via scheduleError (previously fire-and-forget).
  const noteFailures: string[] = [];

  if (estimateAddress?.street) {
    const addressLine = [estimateAddress.street, estimateAddress.city, estimateAddress.state, estimateAddress.zip]
      .filter(Boolean).join(', ');
    const noteContent = `Service Address: ${addressLine}`;
    const ok = await addEstimateNoteWithRetry(tenantId, hcpEstimateId, noteContent, 'service address');
    if (!ok) noteFailures.push('service address');
  }

  const customerNotes = (request.notes || '').trim();
  let bookerNoteAttached = customerNotes.length === 0;
  if (customerNotes.length > 0) {
    const ok = await addEstimateNoteWithRetry(tenantId, hcpEstimateId, customerNotes, 'booker notes');
    bookerNoteAttached = ok;
    if (!ok) noteFailures.push('booker notes');
  }

  // Verify the note actually landed; success here can override an earlier
  // POST failure (the lead-notes pre-staging path may have delivered it).
  if (customerNotes.length > 0) {
    const verified = await verifyBookerNoteOnEstimate(tenantId, hcpEstimateId, customerNotes);
    if (!verified) {
      bookerNoteAttached = false;
      if (!noteFailures.includes('booker notes')) noteFailures.push('booker notes');
    } else {
      bookerNoteAttached = true;
      const idx = noteFailures.indexOf('booker notes');
      if (idx !== -1) noteFailures.splice(idx, 1);
    }
  }

  // Activity-feed breadcrumb for the salesperson.
  if (bookerNoteAttached && customerNotes.length > 0 && request.contactId) {
    createActivityAndBroadcast(
      tenantId,
      {
        type: 'note',
        contactId: request.contactId,
        content: `Booking notes attached to HCP estimate ${hcpEstimateId}`,
      },
      { type: 'activity_created', contactId: request.contactId },
    ).catch((err) => log.warn(`[scheduling] Failed to write booker-notes activity breadcrumb (non-fatal): ${err instanceof Error ? err.message : String(err)}`));
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

  if (noteFailures.length > 0) {
    let noteMsg = `Estimate was created in HousecallPro but the following note(s) could not be added automatically: ${noteFailures.join(', ')}. Please open HousecallPro to add them manually.`;
    if (noteFailures.includes('booker notes')) noteMsg += ` ${BOOKER_NOTES_MISSING_TOKEN}`;
    scheduleError = scheduleError ? `${scheduleError} ${noteMsg}` : noteMsg;
  }

  return { hcpEstimateId, scheduleError };
}
