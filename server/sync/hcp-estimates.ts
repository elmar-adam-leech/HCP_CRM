/**
 * server/sync/hcp-estimates.ts — HCP estimates sync logic.
 *
 * Processes HCP estimates page-by-page, splitting each page into batches of
 * SYNC_BATCH_SIZE. For each item: update if already known, otherwise resolve
 * (or create) the contact and create the estimate. When an estimate becomes
 * `approved` for the first time it is automatically converted to a job.
 */
import { housecallProService } from '../hcp/index';
import { storage } from '../storage';
import { db } from '../db';
import { contacts, estimates } from '@shared/schema';
import { randomUUID } from 'crypto';
import { splitIntoBatches } from '../utils/batch';
import { SYNC_BATCH_SIZE, HCP_SYNC_MAX_RUNTIME_MS } from './hcp-types';
import type { HcpEstimate } from './hcp-types';
import { mapHcpEstimateStatus, resolveHcpEstimateStatus, extractHcpAmount, extractHcpEstimateTitle, extractHcpScheduledEmployeeId, buildHcpLineItems, resolveSalespersonForHcpEntity } from './hcp-mappers';
import { normalizePhoneArrayForStorage } from '../utils/phone-normalizer';
import { logger } from '../utils/logger';
import type { UpdateEstimate } from '../storage-types';
import type { HcpOptionEntry } from '@shared/schema';
import { resolveHcpContact, convertEstimateToJob, isExcludedResult } from './hcp-contact-helpers';
import { buildFormattedAddress } from '../utils/address';

const log = logger('HcpEstimatesSync');

/**
 * Build the local `hcp_options` jsonb representation of an HCP estimate's
 * option list. When `previousOptions` is provided (i.e. an existing local
 * estimate), each option's `approval_status_changed_at` is carried forward
 * unless the `approval_status` changed between the previous and incoming
 * versions — in which case it is stamped to the supplied `now` (default:
 * current time). This is what gives Task B its time-to-approval metric
 * straight from the polling sync, without relying solely on webhooks.
 */
export function buildHcpOptions(
  hcpEstimate: HcpEstimate,
  previousOptions?: HcpOptionEntry[] | null,
  now: Date = new Date(),
): HcpOptionEntry[] | undefined {
  if (!Array.isArray(hcpEstimate.options) || hcpEstimate.options.length === 0) return undefined;
  const prevById = new Map<string, HcpOptionEntry>();
  if (Array.isArray(previousOptions)) {
    for (const p of previousOptions) {
      if (p?.id) prevById.set(p.id, p);
    }
  }
  return hcpEstimate.options
    .filter(o => o.id)
    .map(o => {
      const prev = prevById.get(o.id!);
      const prevStatus = prev?.approval_status ?? null;
      const newStatus = o.approval_status ?? null;
      const prevTs = prev?.approval_status_changed_at ?? null;
      let approval_status_changed_at: string | null;
      if (newStatus && newStatus !== 'pending' && newStatus !== prevStatus) {
        approval_status_changed_at = now.toISOString();
      } else {
        approval_status_changed_at = prevTs;
      }
      return {
        id: o.id!,
        name: o.name,
        option_number: o.option_number,
        total_amount: o.total_amount,
        approval_status: o.approval_status,
        approval_status_changed_at,
      };
    });
}

export async function syncHousecallProEstimates(tenantId: string): Promise<void> {
  const syncStartDate = await storage.getHousecallProSyncStartDate(tenantId);
  log.info(`[sync-scheduler] Using sync start date filter: ${syncStartDate ? syncStartDate.toISOString() : 'none'}`);

  const baseEstimatesParams = {
    ...(syncStartDate ? { modified_since: syncStartDate.toISOString() } : {}),
    sort_by: 'created_at',
    sort_direction: 'desc',
    page_size: 100,
  };

  let page = 1;
  let keepGoing = true;
  const startTime = Date.now();

  let newEstimates = 0;
  let updatedEstimates = 0;
  let failedEstimates = 0;
  let totalFetched = 0;

  while (keepGoing) {
    if (Date.now() - startTime > HCP_SYNC_MAX_RUNTIME_MS) {
      log.info(`[sync-scheduler] Estimates: time limit reached at page ${page}, aborting pagination`);
      break;
    }

    const estimatesParams = { ...baseEstimatesParams, page };
    log.info(`[sync-scheduler] Fetching estimates page ${page}...`);

    const estimatesResult = await housecallProService.getEstimates(tenantId, estimatesParams);
    if (!estimatesResult.success) {
      throw new Error(`Failed to fetch estimates page ${page}: ${estimatesResult.error}`);
    }

    const pageEstimates = estimatesResult.data || [];
    log.info(`[sync-scheduler] Page ${page}: fetched ${pageEstimates.length} estimates`);

    if (!pageEstimates.length) {
      log.info(`[sync-scheduler] No more estimates found, stopping pagination`);
      break;
    }

    totalFetched += pageEstimates.length;

    const estimateBatches = splitIntoBatches(pageEstimates, SYNC_BATCH_SIZE);
    log.info(`[sync-scheduler] Processing page ${page} (${pageEstimates.length} estimates) in ${estimateBatches.length} batches of up to ${SYNC_BATCH_SIZE}`);

    for (let batchIndex = 0; batchIndex < estimateBatches.length; batchIndex++) {
      const batch = estimateBatches[batchIndex];
      log.info(`[sync-scheduler] Processing estimate batch ${batchIndex + 1}/${estimateBatches.length} (${batch.length} items)`);

      const batchHcpIds = batch.map((e: HcpEstimate) => e.id);
      const existingEstimatesMap = await storage.getEstimatesByHousecallProIds(batchHcpIds, tenantId);

      const newItemCustomerIds = batch
        .filter(e => !existingEstimatesMap.has(e.id) && e.customer?.id)
        .map(e => e.customer!.id!);
      const batchContactsMap = await storage.getContactsByHousecallProCustomerIds(newItemCustomerIds, tenantId);
      log.info(`[sync-scheduler] Estimate batch: ${existingEstimatesMap.size} existing, ${batch.length - existingEstimatesMap.size} new, ${batchContactsMap.size} contacts pre-fetched`);

      for (const hcpEstimate of batch) {
        try {
          const existingEstimate = existingEstimatesMap.get(hcpEstimate.id);

          if (existingEstimate) {
            const mappedStatus = mapHcpEstimateStatus(hcpEstimate);
            const newStatus = resolveHcpEstimateStatus(
              mappedStatus,
              existingEstimate.status,
              existingEstimate.statusManuallySet ?? false,
            );
            const updatedTitle = extractHcpEstimateTitle(hcpEstimate);
            log.info(`[sync-scheduler] Updating estimate ${hcpEstimate.id}: mapped=${mappedStatus} -> status=${newStatus} (was ${existingEstimate.status}, manual=${existingEstimate.statusManuallySet ?? false}), title="${updatedTitle}"`);

            const hcpScheduledStart = hcpEstimate.schedule?.scheduled_start;
            const hcpScheduledEnd = hcpEstimate.schedule?.scheduled_end;
            const updateData: Partial<UpdateEstimate> & { housecallProEstimateId?: string; housecallProCustomerId?: string; hcpOptions?: HcpOptionEntry[] } = {
              title: updatedTitle,
              status: newStatus,
              amount: extractHcpAmount(hcpEstimate).toString(),
              description: hcpEstimate.description || '',
              scheduledStart: hcpScheduledStart ? new Date(hcpScheduledStart) : null,
              scheduledEnd: hcpScheduledEnd ? new Date(hcpScheduledEnd) : null,
              scheduledEmployeeId: extractHcpScheduledEmployeeId(hcpEstimate),
              hcpOptions: buildHcpOptions(hcpEstimate, existingEstimate.hcpOptions ?? null) ?? undefined,
              lineItems: buildHcpLineItems(hcpEstimate) ?? null,
              salespersonUserId: await resolveSalespersonForHcpEntity(tenantId, hcpEstimate),
            };
            if (newStatus !== existingEstimate.status) {
              updateData.approvalStatusChangedAt = new Date();
              updateData.mostRecentStatusChangeReason = `polling-sync: ${existingEstimate.status} → ${newStatus}`;
            }
            // Task #721: sticky document-sent stamp. If HCP currently maps to
            // a sent-like state OR carries a `sent_at`, populate documentSentAt
            // (only when not already set). Never cleared.
            if (!existingEstimate.documentSentAt) {
              const hcpSentAt = hcpEstimate.sent_at;
              if (mappedStatus === 'sent' || hcpSentAt) {
                updateData.documentSentAt = hcpSentAt ? new Date(hcpSentAt) : new Date();
              }
            }
            if (!existingEstimate.housecallProEstimateId) updateData.housecallProEstimateId = hcpEstimate.id;
            const hcpCustId = hcpEstimate.customer?.id;
            if (!existingEstimate.housecallProCustomerId && hcpCustId) {
              updateData.housecallProCustomerId = hcpCustId;
            }

            await storage.updateEstimate(existingEstimate.id, updateData, tenantId);
            updatedEstimates++;

            if (newStatus === 'approved' && existingEstimate.status !== 'approved') {
              await convertEstimateToJob(existingEstimate, hcpEstimate, tenantId);
              log.info(`[sync-scheduler] Auto-converted approved estimate ${existingEstimate.id} to job`);
            }
          } else {
            const estimateStatus = mapHcpEstimateStatus(hcpEstimate);
            const estimateTitle = extractHcpEstimateTitle(hcpEstimate);
            const amountInDollars = extractHcpAmount(hcpEstimate);

            const hcpCustomerId = hcpEstimate.customer?.id;
            const hcpCustomer = hcpEstimate.customer;

            let contactId: string | null =
              (hcpCustomerId && batchContactsMap.get(hcpCustomerId)?.id) ?? null;
            if (!contactId) {
              contactId = await resolveHcpContact(hcpCustomerId, hcpCustomer, tenantId);
            }

            if (isExcludedResult(contactId)) {
              log.info(`[sync-scheduler] Skipping estimate ${hcpEstimate.id} - HCP customer ${hcpCustomerId} was excluded`);
              continue;
            }

            if (!contactId && hcpCustomer) {
              const customerEmail = hcpCustomer.email;
              const customerName = [hcpCustomer.first_name, hcpCustomer.last_name].filter(Boolean).join(' ') ||
                hcpCustomer.company || 'Unknown Customer';
              const rawPhones: string[] = hcpCustomer.phone_numbers?.length
                ? hcpCustomer.phone_numbers.map((p: any) => p.phone_number).filter(Boolean)
                : [hcpCustomer.mobile_number, hcpCustomer.home_number, hcpCustomer.work_number].filter(Boolean) as string[];
              const hcpPhones = normalizePhoneArrayForStorage(rawPhones);
              const emails = customerEmail ? [customerEmail] : [];
              const hcpAddr = hcpCustomer.address;
              const estStreet = hcpAddr?.street || undefined;
              const estCity = hcpAddr?.city || undefined;
              const estState = hcpAddr?.state || undefined;
              const estZip = hcpAddr?.zip || undefined;
              const address = buildFormattedAddress(estStreet, estCity, estState, estZip);

              const newContactId = randomUUID();
              const newEstimateId = randomUUID();

              await db.transaction(async (tx: any) => {
                await tx.insert(contacts).values({
                  id: newContactId,
                  name: customerName,
                  emails,
                  phones: hcpPhones,
                  address,
                  street: estStreet,
                  city: estCity,
                  state: estState,
                  zip: estZip,
                  type: 'customer',
                  status: 'new',
                  source: hcpCustomer.lead_source ?? null,
                  housecallProCustomerId: hcpCustomerId || undefined,
                  externalId: hcpCustomerId || undefined,
                  externalSource: hcpCustomerId ? 'housecall-pro' : undefined,
                  contractorId: tenantId,
                  createdAt: new Date(),
                  updatedAt: new Date(),
                });

                const schedStart = hcpEstimate.schedule?.scheduled_start;
                const schedEnd = hcpEstimate.schedule?.scheduled_end;
                const hcpCreatedAt = hcpEstimate.created_at ? new Date(hcpEstimate.created_at) : new Date();
                await tx.insert(estimates).values({
                  contactId: newContactId,
                  title: estimateTitle,
                  description: hcpEstimate.description || '',
                  amount: amountInDollars.toString(),
                  status: estimateStatus,
                  contractorId: tenantId,
                  createdAt: hcpCreatedAt,
                  updatedAt: new Date(),
                  scheduledStart: schedStart ? new Date(schedStart) : null,
                  scheduledEnd: schedEnd ? new Date(schedEnd) : null,
                  scheduledEmployeeId: extractHcpScheduledEmployeeId(hcpEstimate),
                  externalId: hcpEstimate.id,
                  externalSource: 'housecall-pro',
                  housecallProEstimateId: hcpEstimate.id,
                  housecallProCustomerId: hcpCustomerId || undefined,
                  hcpOptions: buildHcpOptions(hcpEstimate) ?? undefined,
                  lineItems: buildHcpLineItems(hcpEstimate) ?? undefined,
                  salespersonUserId: await resolveSalespersonForHcpEntity(tenantId, hcpEstimate),
                  documentSentAt: (estimateStatus === 'sent' || hcpEstimate.sent_at)
                    ? (hcpEstimate.sent_at ? new Date(hcpEstimate.sent_at) : new Date())
                    : null,
                });
              });

              log.info(`[sync-scheduler] Created contact ${newContactId} and estimate ${newEstimateId} atomically`);
              newEstimates++;
              continue;
            }

            if (!contactId) {
              log.info(`[sync-scheduler] Skipping estimate ${hcpEstimate.id} - no customer data available to create contact`);
              continue;
            }

            const schedStart2 = hcpEstimate.schedule?.scheduled_start;
            const schedEnd2 = hcpEstimate.schedule?.scheduled_end;
            const hcpCreatedAt2 = hcpEstimate.created_at ? new Date(hcpEstimate.created_at) : new Date();
            const estimateData = {
              contactId,
              title: estimateTitle,
              description: hcpEstimate.description || '',
              amount: amountInDollars.toString(),
              status: estimateStatus,
              contractorId: tenantId,
              createdAt: hcpCreatedAt2,
              updatedAt: new Date(),
              scheduledStart: schedStart2 ? new Date(schedStart2) : null,
              scheduledEnd: schedEnd2 ? new Date(schedEnd2) : null,
              scheduledEmployeeId: extractHcpScheduledEmployeeId(hcpEstimate),
              externalId: hcpEstimate.id,
              externalSource: 'housecall-pro' as const,
              housecallProEstimateId: hcpEstimate.id,
              housecallProCustomerId: hcpCustomerId || undefined,
              hcpOptions: buildHcpOptions(hcpEstimate) ?? undefined,
              lineItems: buildHcpLineItems(hcpEstimate) ?? undefined,
              salespersonUserId: await resolveSalespersonForHcpEntity(tenantId, hcpEstimate),
              documentSentAt: (estimateStatus === 'sent' || hcpEstimate.sent_at)
                ? (hcpEstimate.sent_at ? new Date(hcpEstimate.sent_at) : new Date())
                : undefined,
            };

            await storage.createEstimate(estimateData, tenantId);
            newEstimates++;
          }
        } catch (itemError) {
          log.error(`[sync-scheduler] Failed to process estimate ${hcpEstimate.id}:`, itemError);
          failedEstimates++;
        }
      }

      log.info(`[sync-scheduler] Estimate batch ${batchIndex + 1} complete - Running totals: ${newEstimates} new, ${updatedEstimates} updated, ${failedEstimates} failed`);
    }

    if (pageEstimates.length < baseEstimatesParams.page_size) {
      log.info(`[sync-scheduler] Page ${page} returned ${pageEstimates.length} estimates (< ${baseEstimatesParams.page_size}), stopping pagination`);
      keepGoing = false;
    } else {
      page++;
    }
  }

  log.info(`[sync-scheduler] Estimate sync completed - Fetched: ${totalFetched} total, New: ${newEstimates}, Updated: ${updatedEstimates}, Failed: ${failedEstimates}`);
}
