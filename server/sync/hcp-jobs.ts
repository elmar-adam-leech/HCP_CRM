import { logger } from '../utils/logger';
import { housecallProService } from '../hcp/index';
import { storage } from '../storage';
import { db } from '../db';
import { contacts, jobs } from '@shared/schema';
import { randomUUID } from 'crypto';
import { splitIntoBatches } from '../utils/batch';
import { SYNC_BATCH_SIZE, HCP_SYNC_MAX_RUNTIME_MS } from './hcp-types';
import type { HcpJob, HcpPhoneNumber } from './hcp-types';
import { mapHcpJobStatus, extractHcpJobTitle, buildHcpLineItems, resolveSalespersonForHcpEntity } from './hcp-mappers';
import { resolveHcpContact, markLinkedEstimateApproved, isExcludedResult } from './hcp-contact-helpers';
import { buildFormattedAddress } from '../utils/address';
import type { UpdateJob } from '../storage-types';
import { normalizePhoneArrayForStorage } from '../utils/phone-normalizer';

const log = logger('HcpJobsSync');

/**
 * server/sync/hcp-jobs.ts — HCP jobs sync logic.
 *
 * Processes HCP jobs page-by-page, splitting each page into batches of
 * SYNC_BATCH_SIZE. For each item: update the existing job record if found,
 * otherwise resolve (or create) the contact and create the job. When a job
 * is linked to an HCP estimate, that local estimate is automatically marked
 * `approved`.
 */

export async function syncHousecallProJobs(tenantId: string): Promise<void> {
  log.info(`[sync-scheduler] Syncing Housecall Pro jobs for tenant ${tenantId}`);

  const syncStartDate = await storage.getHousecallProSyncStartDate(tenantId);

  const jobsParams = {
    ...(syncStartDate ? { modified_since: syncStartDate.toISOString() } : {}),
    sort_by: 'created_at',
    sort_direction: 'desc',
    page_size: 100,
    include: 'tags',
  };

  let jobPage = 1;
  let jobsKeepGoing = true;
  const jobSyncStartTime = Date.now();

  let newJobs = 0;
  let updatedJobs = 0;
  let failedJobs = 0;
  let totalJobsFetched = 0;

  while (jobsKeepGoing) {
    if (Date.now() - jobSyncStartTime > HCP_SYNC_MAX_RUNTIME_MS) {
      log.info(`[sync-scheduler] Job sync time limit reached at page ${jobPage}, aborting pagination`);
      break;
    }
    const pageParams = { ...jobsParams, page: jobPage };
    log.info(`[sync-scheduler] Fetching jobs page ${jobPage}...`);
    const jobsResult = await housecallProService.getJobs(tenantId, pageParams);
    if (!jobsResult.success) {
      throw new Error(`Failed to fetch jobs page ${jobPage}: ${jobsResult.error}`);
    }
    const pageJobs = (jobsResult.data || []) as HcpJob[];
    log.info(`[sync-scheduler] Jobs page ${jobPage}: fetched ${pageJobs.length} jobs`);
    if (!pageJobs.length) { break; }

    totalJobsFetched += pageJobs.length;

    const jobBatches = splitIntoBatches(pageJobs, SYNC_BATCH_SIZE);
    log.info(`[sync-scheduler] Processing jobs page ${jobPage} (${pageJobs.length} jobs) in ${jobBatches.length} batches of up to ${SYNC_BATCH_SIZE}`);

    for (let batchIndex = 0; batchIndex < jobBatches.length; batchIndex++) {
      const batch = jobBatches[batchIndex];
      log.info(`[sync-scheduler] Processing job batch ${batchIndex + 1}/${jobBatches.length} (${batch.length} items)`);

      const batchJobIds = batch.map((j: HcpJob) => j.id);
      const existingJobsMap = await storage.getJobsByExternalIds(batchJobIds, tenantId);

      const newJobCustomerIds = batch
        .filter(j => !existingJobsMap.has(j.id) && j.customer_id)
        .map(j => j.customer_id!);
      const batchJobContactsMap = await storage.getContactsByHousecallProCustomerIds(newJobCustomerIds, tenantId);
      log.info(`[sync-scheduler] Job batch: ${existingJobsMap.size} existing, ${batch.length - existingJobsMap.size} new, ${batchJobContactsMap.size} contacts pre-fetched`);

      for (const hcpJob of batch) {
        try {
          const existingJob = existingJobsMap.get(hcpJob.id);

          if (existingJob) {
            const scheduledStart = hcpJob.schedule?.scheduled_start || hcpJob.scheduled_start;
            const updateData: UpdateJob = {
              title: extractHcpJobTitle(hcpJob),
              status: mapHcpJobStatus(hcpJob.work_status || ''),
              value: ((hcpJob.total_amount || 0) / 100).toFixed(2),
              scheduledDate: scheduledStart ? new Date(scheduledStart) : null,
              lineItems: buildHcpLineItems(hcpJob) ?? null,
              salespersonUserId: await resolveSalespersonForHcpEntity(tenantId, hcpJob),
            };
            if (!existingJob.estimateId && hcpJob.estimate_id) {
              const localEstimateId = await markLinkedEstimateApproved(hcpJob.estimate_id, tenantId, existingJob.id);
              if (localEstimateId) updateData.estimateId = localEstimateId;
            }
            await storage.updateJob(existingJob.id, updateData, tenantId);
            const jobContact = await storage.getContact(existingJob.contactId, tenantId);
            if (jobContact && jobContact.type === 'lead') {
              await storage.updateContact(jobContact.id, { type: 'customer' as const, status: 'active' as const }, tenantId);
              log.info(`[sync-scheduler] Promoted contact ${jobContact.id} from lead to customer (job sync: existing job ${existingJob.id})`);
            }
            updatedJobs++;
          } else {
            const hcpCustomerId = hcpJob.customer_id;
            const hcpCustomer = hcpJob.customer;

            let contactId: string | null =
              (hcpCustomerId && batchJobContactsMap.get(hcpCustomerId)?.id) ?? null;
            if (!contactId) {
              contactId = await resolveHcpContact(hcpCustomerId, hcpCustomer, tenantId);
            }

            if (isExcludedResult(contactId)) {
              log.info(`[sync-scheduler] Skipping job ${hcpJob.id} - HCP customer ${hcpCustomerId} was excluded`);
              continue;
            }

            if (!contactId && hcpCustomer) {
              const customerEmail = hcpCustomer.email;
              const customerName = [hcpCustomer.first_name, hcpCustomer.last_name].filter(Boolean).join(' ') ||
                hcpCustomer.company || 'Unknown Customer';
              const rawPhones: string[] = hcpCustomer.phone_numbers?.length
                ? (hcpCustomer.phone_numbers.map((p: HcpPhoneNumber) => p.phone_number).filter((v): v is string => !!v))
                : ([hcpCustomer.mobile_number, hcpCustomer.home_number, hcpCustomer.work_number].filter((v): v is string => !!v));
              const jobPhones = normalizePhoneArrayForStorage(rawPhones);
              const emails = customerEmail ? [customerEmail] : [];
              const hcpAddr = hcpCustomer.address;
              const jobStreet = hcpAddr?.street || undefined;
              const jobCity = hcpAddr?.city || undefined;
              const jobState = hcpAddr?.state || undefined;
              const jobZip = hcpAddr?.zip || undefined;
              const address = buildFormattedAddress(jobStreet, jobCity, jobState, jobZip);

              const newContactId = randomUUID();
              const newJobId = randomUUID();
              const scheduledStartTx = hcpJob.schedule?.scheduled_start || hcpJob.scheduled_start;
              const jobStatus = mapHcpJobStatus(hcpJob.work_status || '');

              let linkedEstimateId: string | undefined;
              let linkedEstimateNeedsApproval = false;
              if (hcpJob.estimate_id) {
                const linkedEst = await storage.getEstimateByHousecallProEstimateId(hcpJob.estimate_id, tenantId);
                if (linkedEst) {
                  linkedEstimateId = linkedEst.id;
                  linkedEstimateNeedsApproval = linkedEst.status !== 'approved';
                }
              }

              await db.transaction(async (tx) => {
                await tx.insert(contacts).values({
                  id: newContactId,
                  name: customerName,
                  emails,
                  phones: jobPhones,
                  address,
                  street: jobStreet,
                  city: jobCity,
                  state: jobState,
                  zip: jobZip,
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

                await tx.insert(jobs).values({
                  id: newJobId,
                  contactId: newContactId,
                  title: extractHcpJobTitle(hcpJob),
                  type: 'Service',
                  status: jobStatus,
                  value: ((hcpJob.total_amount || 0) / 100).toFixed(2),
                  priority: 'medium',
                  contractorId: tenantId,
                  createdAt: new Date(),
                  updatedAt: new Date(),
                  scheduledDate: scheduledStartTx ? new Date(scheduledStartTx) : null,
                  estimatedHours: null, // HCP payload does not carry an hours estimate
                  externalId: hcpJob.id,
                  externalSource: 'housecall-pro',
                  estimateId: linkedEstimateId,
                  lineItems: buildHcpLineItems(hcpJob) ?? undefined,
                  salespersonUserId: await resolveSalespersonForHcpEntity(tenantId, hcpJob),
                });
              });

              if (linkedEstimateId && linkedEstimateNeedsApproval) {
                await storage.updateEstimate(linkedEstimateId, { status: 'approved' }, tenantId);
                log.info(
                  `[sync-scheduler] Marked estimate ${linkedEstimateId} (HCP: ${hcpJob.estimate_id}) as approved — linked to job ${newJobId}`,
                );
              }

              log.info(`[sync-scheduler] Created contact ${newContactId} and job ${newJobId} atomically`);
              newJobs++;
              continue;
            }

            if (!contactId) {
              log.info(`[sync-scheduler] Skipping job ${hcpJob.id} - no customer data available to create contact`);
              continue;
            }

            const scheduledStartNormal = hcpJob.schedule?.scheduled_start || hcpJob.scheduled_start;
            let normalEstimateId: string | undefined;
            if (hcpJob.estimate_id) {
              normalEstimateId = await markLinkedEstimateApproved(hcpJob.estimate_id, tenantId, hcpJob.id);
            }
            await storage.createJob({
              contactId,
              title: extractHcpJobTitle(hcpJob),
              type: 'Service',
              status: mapHcpJobStatus(hcpJob.work_status || ''),
              value: ((hcpJob.total_amount || 0) / 100).toFixed(2),
              priority: 'medium' as const,
              scheduledDate: scheduledStartNormal ? new Date(scheduledStartNormal) : null,
              estimatedHours: null, // HCP payload does not carry an hours estimate
              externalId: hcpJob.id,
              externalSource: 'housecall-pro' as const,
              estimateId: normalEstimateId,
              lineItems: buildHcpLineItems(hcpJob) ?? undefined,
              salespersonUserId: await resolveSalespersonForHcpEntity(tenantId, hcpJob),
            }, tenantId);
            const newJobContact = await storage.getContact(contactId, tenantId);
            if (newJobContact && newJobContact.type === 'lead') {
              await storage.updateContact(newJobContact.id, { type: 'customer' as const, status: 'active' as const }, tenantId);
              log.info(`[sync-scheduler] Promoted contact ${newJobContact.id} from lead to customer (job sync: new job for existing contact)`);
            }
            newJobs++;
          }
        } catch (itemError) {
          log.error(`[sync-scheduler] Failed to process job ${hcpJob.id}:`, itemError);
          failedJobs++;
        }
      }

      log.info(`[sync-scheduler] Job batch ${batchIndex + 1} complete - Running totals: ${newJobs} new, ${updatedJobs} updated, ${failedJobs} failed`);
    }

    if (pageJobs.length < jobsParams.page_size) { jobsKeepGoing = false; } else { jobPage++; }
  }

  log.info(`[sync-scheduler] Jobs sync completed across ${jobPage} pages (${totalJobsFetched} total fetched) - New: ${newJobs}, Updated: ${updatedJobs}, Failed: ${failedJobs}`);
}
