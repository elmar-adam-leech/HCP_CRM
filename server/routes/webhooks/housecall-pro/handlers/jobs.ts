import { storage } from "../../../../storage";
import { broadcastToContractor } from "../../../../websocket";
import { workflowEngine } from "../../../../workflow-engine";
import { mapHcpJobStatus } from "../../../../sync/housecall-pro";
import { extractHcpJobTitle, buildHcpLineItems, resolveSalespersonForHcpEntity } from "../../../../sync/hcp-mappers";
import type { HcpPayment } from "../../../../sync/hcp-types";
import { housecallProService } from "../../../../hcp/index";
import { toWorkflowEvent } from "../../../../utils/workflow/entity-adapter";
import { logger } from "../../../../utils/logger";
import type { UpdateJob } from "../../../../storage-types";
import type { HandlerResult } from "../utils";
import { resolveHcpContact, isExcludedResult } from "../../../../sync/hcp-contact-helpers";
import { buildFormattedAddress } from "../../../../utils/address";

const log = logger('HCPWebhook');

/**
 * Build a normalized payment payload from an HCP job.paid webhook.
 * Prefers structured `data.payment` if HCP includes it; otherwise
 * derives totals from the fetched job. Amounts are dollars, not cents.
 */
function extractPaymentFromWebhook(data: any, hcpJob: any | null): {
  amount: number | undefined;
  method: string | undefined;
  paid_at: string | undefined;
  is_deposit: boolean;
} {
  const payment = data?.payment ?? {};
  const rawAmountCents = typeof payment.amount === 'number'
    ? payment.amount
    : (typeof data?.amount === 'number' ? data.amount : undefined);
  const totalCents = typeof hcpJob?.total_amount === 'number' ? hcpJob.total_amount : undefined;
  const paidCents = typeof hcpJob?.outstanding_balance === 'number' && totalCents != null
    ? totalCents - hcpJob.outstanding_balance
    : undefined;
  const amount = rawAmountCents != null ? rawAmountCents / 100 : (paidCents != null ? paidCents / 100 : undefined);
  const isDeposit = Boolean(
    payment.is_deposit ?? data?.is_deposit ??
    (totalCents != null && rawAmountCents != null && rawAmountCents > 0 && rawAmountCents < totalCents)
  );
  return {
    amount,
    method: payment.method ?? payment.payment_method ?? data?.payment_method,
    paid_at: payment.paid_at ?? payment.created_at ?? data?.paid_at ?? new Date().toISOString(),
    is_deposit: isDeposit,
  };
}

const JOB_EVENTS = new Set([
  'job.created',
  'job.updated',
  'job.completed',
  'job.scheduled',
  'job.started',
  'job.canceled',
  'job.deleted',
  'job.paid',
  'job.on_my_way',
]);

export async function handleJobEvent(
  contractorId: string,
  event_type: string,
  data: any,
  _webhookEventId: string | undefined,
): Promise<HandlerResult> {
  if (JOB_EVENTS.has(event_type)) {
    const job = await storage.getJobByHousecallProJobId(data.id, contractorId);
    if (!job) {
      // Job is missing locally — common during webhook-silence backfill, where
      // the auto-resync replays jobs we never received the original
      // `job.created` for. Skip cancellations/deletions (no point importing
      // a dead row) but otherwise create the job from the HCP payload so
      // brand-new jobs surface in the app.
      if (event_type === 'job.canceled' || event_type === 'job.deleted') {
        return 'continue';
      }
      const created = await createMissingJobFromHcp(contractorId, data);
      if (created) {
        broadcastToContractor(contractorId, { type: 'job_created', jobId: created.id });
        workflowEngine.triggerWorkflowsForEvent('job_created', toWorkflowEvent(created), contractorId).catch(err =>
          log.error('job_created trigger error (missing-job backfill)', err));
      }
      return 'continue';
    }
    if (job) {
      const hcpResponse = await housecallProService.getJob(data.id, contractorId);
      const hcpJob = hcpResponse.success ? hcpResponse.data : null;

      if (hcpJob) {
        const scheduledStart = hcpJob.schedule?.scheduled_start || hcpJob.scheduled_start;
        const newStatus = mapHcpJobStatus(hcpJob.work_status || '');
        const updateData: UpdateJob = {
          status: newStatus,
          title: extractHcpJobTitle(hcpJob),
          value: ((hcpJob.total_amount || 0) / 100).toFixed(2),
          scheduledDate: scheduledStart ? new Date(scheduledStart) : null,
          lineItems: buildHcpLineItems(hcpJob) ?? null,
          salespersonUserId: await resolveSalespersonForHcpEntity(contractorId, hcpJob),
        };

        // For job.paid, derive the most recent payment from hcpJob.payments[]
        // (latest by created_at) and write it to the new payment columns. Each
        // subsequent job.paid webhook overwrites these fields, so a deposit
        // followed by a balance payment ends with the balance recorded.
        if (event_type === 'job.paid') {
          const latestPayment = pickLatestPayment(hcpJob.payments);
          if (latestPayment) {
            const amountCents = typeof latestPayment.amount === 'number' ? latestPayment.amount : 0;
            updateData.paidAmount = (amountCents / 100).toFixed(2);
            updateData.paymentMethod = latestPayment.payment_method ?? latestPayment.method ?? latestPayment.type ?? null;
            const paidAtRaw = latestPayment.paid_at ?? latestPayment.created_at;
            updateData.paidAt = paidAtRaw ? new Date(paidAtRaw) : null;
            // HCP exposes deposit-ness either via an explicit `is_deposit` flag
            // or via `kind === 'deposit'`. Fall back to false rather than null
            // when we have a payment but no deposit hint.
            const kindIsDeposit = typeof latestPayment.kind === 'string' && latestPayment.kind.toLowerCase().includes('deposit');
            updateData.isDeposit = typeof latestPayment.is_deposit === 'boolean' ? latestPayment.is_deposit : kindIsDeposit;
          }
        }
        const statusChanged = newStatus !== job.status;
        const updated = await storage.updateJob(job.id, updateData, contractorId);

        if (updated) {
          if (event_type === 'job.created') {
            const jobContact = await storage.getContact(updated.contactId, contractorId);
            if (jobContact && jobContact.type === 'lead') {
              const promotedContact = await storage.updateContact(jobContact.id, { type: 'customer' as const, status: 'active' as const }, contractorId);
              const effectivePromoted = promotedContact || jobContact;
              broadcastToContractor(contractorId, { type: 'contact_updated', contactId: effectivePromoted.id });
              workflowEngine.triggerWorkflowsForEvent('contact_status_changed', toWorkflowEvent({ ...effectivePromoted, type: 'customer', status: 'active' }), contractorId).catch(err =>
                log.error('contact_status_changed trigger error (lead promotion)', err));
            }
          }

          const broadcastType = event_type === 'job.created' ? 'job_created' : 'job_updated';
          broadcastToContractor(contractorId, { type: broadcastType, jobId: updated.id });

          const workflowEventObj = toWorkflowEvent(updated);
          if (event_type === 'job.created') {
            workflowEngine.triggerWorkflowsForEvent('job_created', workflowEventObj, contractorId).catch(err =>
              log.error('job_created trigger error', err));
          } else {
            workflowEngine.triggerWorkflowsForEvent('job_updated', workflowEventObj, contractorId).catch(err =>
              log.error('job_updated trigger error', err));
          }
          if (statusChanged) {
            workflowEngine.triggerWorkflowsForEvent('job_status_changed', workflowEventObj, contractorId).catch(err =>
              log.error('job_status_changed trigger error', err));
          }
          if (event_type === 'job.paid') {
            workflowEngine.triggerWorkflowsForEvent('job_paid', workflowEventObj, contractorId).catch(err =>
              log.error('job_paid trigger error', err));
            const paymentPayload = extractPaymentFromWebhook(data, hcpJob);
            const eventWithPayment = { ...workflowEventObj, payment: paymentPayload };
            const paymentTriggerKey = paymentPayload.is_deposit ? 'deposit_received' : 'payment_received';
            workflowEngine.triggerWorkflowsForEvent(paymentTriggerKey, eventWithPayment, contractorId).catch(err =>
              log.error(`${paymentTriggerKey} trigger error`, err));
          }
        }
      } else {
        log.warn(`Failed to fetch full job ${data.id} from HCP, falling back to webhook payload`);
        const isCancelOrDelete = event_type === 'job.canceled' || event_type === 'job.deleted';
        const fallbackStatus = isCancelOrDelete ? 'cancelled' as const : mapHcpJobStatus(data.work_status || '');
        let fallbackResult = job;
        if (fallbackStatus !== job.status) {
          const fallbackUpdate: UpdateJob = { status: fallbackStatus };
          const updated = await storage.updateJob(job.id, fallbackUpdate, contractorId);
          if (updated) {
            fallbackResult = updated;
            broadcastToContractor(contractorId, { type: 'job_updated', jobId: updated.id });
            workflowEngine.triggerWorkflowsForEvent('job_updated', toWorkflowEvent(updated), contractorId).catch(err =>
              log.error('job_updated trigger error', err));
            workflowEngine.triggerWorkflowsForEvent('job_status_changed', toWorkflowEvent(updated), contractorId).catch(err =>
              log.error('job_status_changed trigger error', err));
          }
        }
        if (event_type === 'job.paid') {
          broadcastToContractor(contractorId, { type: 'job_updated', jobId: fallbackResult.id });
          const baseEvent = toWorkflowEvent(fallbackResult);
          workflowEngine.triggerWorkflowsForEvent('job_paid', baseEvent, contractorId).catch(err =>
            log.error('job_paid trigger error', err));
          const paymentPayload = extractPaymentFromWebhook(data, null);
          const eventWithPayment = { ...baseEvent, payment: paymentPayload };
          const paymentTriggerKey = paymentPayload.is_deposit ? 'deposit_received' : 'payment_received';
          workflowEngine.triggerWorkflowsForEvent(paymentTriggerKey, eventWithPayment, contractorId).catch(err =>
            log.error(`${paymentTriggerKey} trigger error`, err));
        }
      }
    }
    return 'continue';
  }

  if (event_type.startsWith('job.appointment.')) {
    const jobId = data.job_id || data.id;
    const job = jobId ? await storage.getJobByHousecallProJobId(jobId, contractorId) : null;
    if (job) {
      broadcastToContractor(contractorId, { type: 'job_updated', jobId: job.id });
      workflowEngine.triggerWorkflowsForEvent('job_updated', toWorkflowEvent(job), contractorId).catch(err =>
        log.error('job_updated trigger error', err));
    }
    return 'continue';
  }

  return 'not-handled';
}

/**
 * Creates a local job for a brand-new HCP job that we have no local record of.
 *
 * Used by the webhook-silence backfill so that jobs created during a webhook
 * outage actually appear in the app. Resolution order for the contact:
 *   1. Existing local contact (HCP customer id / phone / email).
 *   2. Create a new contact from the HCP customer payload.
 *   3. Skip with a warning if neither is possible.
 *
 * Returns the created job (or null if skipped).
 */
async function createMissingJobFromHcp(
  contractorId: string,
  data: any,
): Promise<{ id: string } | null> {
  const hcpJobId = data?.id;
  if (!hcpJobId) return null;

  // Pull the full job from HCP — the webhook payload is partial; the REST
  // record carries the customer block, line items, total, schedule, etc.
  const hcpResponse = await housecallProService.getJob(hcpJobId, contractorId);
  const hcpJob: any = hcpResponse.success ? hcpResponse.data : null;
  const source = hcpJob ?? data;
  const customerBlock = source?.customer ?? data?.customer;
  const customerId: string | undefined = customerBlock?.id ?? source?.customer_id ?? data?.customer_id;

  // Try to resolve to an existing local contact (HCP customer id, phone, email).
  let contactId: string | null = null;
  if (customerId || customerBlock) {
    const resolved = await resolveHcpContact(customerId, customerBlock, contractorId);
    if (isExcludedResult(resolved)) {
      log.info(`createMissingJobFromHcp: HCP customer ${customerId} is excluded, skipping job ${hcpJobId}`);
      return null;
    }
    contactId = resolved;
  }

  // No existing contact — create one from the HCP customer payload, mirroring
  // the same fallback the estimate.created handler uses.
  if (!contactId && customerBlock) {
    const phone =
      customerBlock.mobile_number || customerBlock.home_number || customerBlock.work_number ||
      (customerBlock.phone_numbers?.[0]?.phone_number);
    const name =
      [customerBlock.first_name, customerBlock.last_name].filter(Boolean).join(' ') ||
      customerBlock.company || 'Unknown';
    const hcpAddr = customerBlock.address;
    const street = hcpAddr?.street || undefined;
    const city = hcpAddr?.city || undefined;
    const state = hcpAddr?.state || undefined;
    const zip = hcpAddr?.zip || undefined;
    const address = buildFormattedAddress(street, city, state, zip);
    log.info(`createMissingJobFromHcp: creating new contact for HCP customer ${customerId ?? '?'} from job ${hcpJobId}`);
    const newContact = await storage.createContact({
      name,
      emails: customerBlock.email ? [customerBlock.email] : [],
      phones: phone ? [phone] : [],
      address,
      street,
      city,
      state,
      zip,
      type: 'customer',
      status: 'active',
      source: customerBlock.lead_source ?? null,
      externalId: customerId ?? null,
      externalSource: customerId ? 'housecall-pro' : undefined,
      housecallProCustomerId: customerId ?? null,
    } as any, contractorId);
    contactId = newContact.id;
    broadcastToContractor(contractorId, { type: 'contact_created', contactId: newContact.id });
    workflowEngine.triggerWorkflowsForEvent('contact_created', toWorkflowEvent(newContact), contractorId).catch(err =>
      log.error('contact_created trigger error (missing-job backfill)', err));
  }

  if (!contactId) {
    log.warn(`createMissingJobFromHcp: no contact and no customer payload for HCP job ${hcpJobId} — skipping`);
    return null;
  }

  // Link to a local estimate if one exists for this HCP job's estimate_id.
  let linkedEstimateId: string | undefined;
  const hcpEstimateId: string | undefined = source?.estimate_id ?? data?.estimate_id;
  if (hcpEstimateId) {
    const linkedEst = await storage.getEstimateByHousecallProEstimateId(hcpEstimateId, contractorId);
    if (linkedEst) {
      linkedEstimateId = linkedEst.id;
      if (linkedEst.status !== 'approved') {
        await storage.updateEstimate(linkedEst.id, { status: 'approved' }, contractorId);
      }
    }
  }

  const scheduledStart = source?.schedule?.scheduled_start || source?.scheduled_start;

  const created = await storage.createJob({
    contactId,
    title: extractHcpJobTitle(source),
    type: 'Service',
    status: mapHcpJobStatus(source?.work_status || ''),
    value: ((source?.total_amount || 0) / 100).toFixed(2),
    priority: 'medium' as const,
    scheduledDate: scheduledStart ? new Date(scheduledStart) : null,
    estimatedHours: null,
    externalId: hcpJobId,
    externalSource: 'housecall-pro' as const,
    estimateId: linkedEstimateId,
    lineItems: buildHcpLineItems(source) ?? undefined,
    salespersonUserId: await resolveSalespersonForHcpEntity(contractorId, source),
  } as any, contractorId);

  // Promote a lead contact to customer when their first job lands, matching
  // the existing job.created behavior.
  const jobContact = await storage.getContact(contactId, contractorId);
  if (jobContact && jobContact.type === 'lead') {
    const promoted = await storage.updateContact(jobContact.id, { type: 'customer' as const, status: 'active' as const }, contractorId);
    const effective = promoted || jobContact;
    broadcastToContractor(contractorId, { type: 'contact_updated', contactId: effective.id });
    workflowEngine.triggerWorkflowsForEvent('contact_status_changed', toWorkflowEvent({ ...effective, type: 'customer', status: 'active' }), contractorId).catch(err =>
      log.error('contact_status_changed trigger error (missing-job backfill)', err));
  }

  log.info(`createMissingJobFromHcp: created local job ${created.id} for HCP job ${hcpJobId}`);
  return created;
}

/**
 * Picks the most recent payment from a job's `payments` array. HCP doesn't
 * guarantee an order so we sort by `created_at` (or `paid_at` if missing) and
 * return the latest. Returns null when no payments are present.
 */
export function pickLatestPayment(payments: HcpPayment[] | undefined): HcpPayment | null {
  if (!Array.isArray(payments) || payments.length === 0) return null;
  const sorted = [...payments].sort((a, b) => {
    const ad = new Date(a.created_at || a.paid_at || 0).getTime();
    const bd = new Date(b.created_at || b.paid_at || 0).getTime();
    return bd - ad;
  });
  return sorted[0] ?? null;
}
