import { storage } from "../../../../storage";
import { db } from "../../../../db";
import { webhookEvents } from "@shared/schema";
import { eq } from "drizzle-orm";
import { broadcastToContractor } from "../../../../websocket";
import { workflowEngine } from "../../../../workflow-engine";
import { mapHcpEstimateStatus } from "../../../../sync/housecall-pro";
import { extractHcpAmount, extractHcpEstimateTitle, extractHcpScheduledEmployeeId, resolveHcpEstimateStatus, buildHcpLineItems, resolveSalespersonForHcpEntity, isHcpDeclinedOptionStatus, isHcpApprovedOptionStatus, isHcpExpiredOptionStatus } from "../../../../sync/hcp-mappers";
import { buildHcpOptions } from "../../../../sync/hcp-estimates";
import { housecallProService } from "../../../../hcp/index";
import { toWorkflowEvent } from "../../../../utils/workflow/entity-adapter";
import { logger } from "../../../../utils/logger";
import { buildFormattedAddress } from "../../../../utils/address";
import type { HandlerResult } from "../utils";

const log = logger('HCPWebhook');

/**
 * Stamp `approvalStatusChangedAt` and `mostRecentStatusChangeReason` on an
 * estimate update payload when the resolved status differs from what was
 * already on the row. Centralised so every webhook branch records the same
 * provenance string and uses the webhook's `occurred_at` (when supplied) over
 * wall-clock time — that way replays / out-of-order deliveries do not drift
 * the recorded transition time.
 */
function stampStatusChangeMeta(
  updateData: Record<string, unknown>,
  previousStatus: string,
  eventType: string,
  occurredAt: Date | undefined,
  rawData: any,
): void {
  const nextStatus = updateData.status as string | undefined;
  if (!nextStatus || nextStatus === previousStatus) return;
  updateData.approvalStatusChangedAt = occurredAt ?? new Date();
  // Prefer an explicit reason/note from HCP if present (e.g. customer rejection
  // notes), otherwise fall back to a structured "<event>: <prev> → <next>" tag
  // so reports always have something useful to display.
  const explicit = (rawData?.reason || rawData?.note || rawData?.decline_reason || '').toString().trim();
  updateData.mostRecentStatusChangeReason = explicit
    ? `${eventType}: ${explicit}`
    : `${eventType}: ${previousStatus} → ${nextStatus}`;
}

export async function handleEstimateEvent(
  contractorId: string,
  event_type: string,
  data: any,
  webhookEventId: string | undefined,
  occurredAt?: Date,
): Promise<HandlerResult> {
  if (event_type === 'estimate.updated' || event_type === 'estimate.completed') {
    const estimate = await storage.getEstimateByHousecallProEstimateId(data.id, contractorId);
    if (estimate) {
      const fetchResult = await housecallProService.getEstimate(contractorId, data.id);
      const fetched = fetchResult.success && fetchResult.data ? fetchResult.data : null;
      const source = fetched || data;
      const mapped = mapHcpEstimateStatus(source);
      const newStatus = resolveHcpEstimateStatus(mapped, estimate.status, estimate.statusManuallySet ?? false);
      const updateData: Record<string, any> = {
        status: newStatus as "sent" | "scheduled" | "in_progress" | "approved" | "rejected",
        syncedAt: new Date(),
      };
      if (fetched) {
        updateData.title = extractHcpEstimateTitle(fetched);
        updateData.amount = extractHcpAmount(fetched).toString();
        updateData.description = fetched.description ?? null;
        updateData.hcpOptions = buildHcpOptions(fetched, estimate.hcpOptions ?? null) ?? null;
        updateData.lineItems = buildHcpLineItems(fetched) ?? null;
        updateData.salespersonUserId = await resolveSalespersonForHcpEntity(contractorId, fetched);
        const fetchedStart = fetched.schedule?.scheduled_start || fetched.scheduled_start;
        const fetchedEnd = fetched.schedule?.scheduled_end || fetched.scheduled_end;
        updateData.scheduledStart = fetchedStart ? new Date(fetchedStart) : null;
        updateData.scheduledEnd = fetchedEnd ? new Date(fetchedEnd) : null;
        updateData.scheduledEmployeeId = extractHcpScheduledEmployeeId(fetched);
      }
      // Sticky document-sent stamp (task #721): if the source mapped to a sent-like
      // state OR carries a `sent_at`, record the first time we saw it. Never clear.
      if (!estimate.documentSentAt) {
        const sourceMapped = mapHcpEstimateStatus(source);
        const sourceSentAt = (source as { sent_at?: string }).sent_at;
        if (sourceMapped === 'sent' || sourceSentAt) {
          updateData.documentSentAt = sourceSentAt ? new Date(sourceSentAt) : (occurredAt ?? new Date());
        }
      }
      stampStatusChangeMeta(updateData, estimate.status, event_type, occurredAt, data);
      const updated = await storage.updateEstimate(estimate.id, updateData, contractorId);
      if (updated) {
        broadcastToContractor(contractorId, { type: 'estimate_updated', estimateId: updated.id });
        workflowEngine.triggerWorkflowsForEvent('estimate_updated', toWorkflowEvent(updated), contractorId).catch(err =>
          log.error('estimate_updated trigger error', err));
        if (updated.status !== estimate.status) {
          workflowEngine.triggerWorkflowsForEvent('estimate_status_changed', toWorkflowEvent(updated), contractorId).catch(err =>
            log.error('estimate_status_changed trigger error', err));
        }
      }
    }
    return 'continue';
  }

  if (event_type === 'estimate.created') {
    const existing = await storage.getEstimateByHousecallProEstimateId(data.id, contractorId);
    if (!existing) {
      const customerId = data.customer_id || data.customer?.id;
      if (customerId) {
        const excluded = await storage.isHcpCustomerExcluded(contractorId, customerId);
        if (excluded) {
          log.info(`estimate.created: HCP customer ${customerId} is excluded, skipping estimate ${data.id}`);
          if (webhookEventId) {
            await db.update(webhookEvents).set({ processed: true }).where(eq(webhookEvents.id, webhookEventId));
          }
          return 'stop';
        }
      }
      let contact = customerId ? await storage.getContactByExternalId(customerId, 'housecall-pro', contractorId) : undefined;
      if (!contact && customerId) {
        // Safety-net fallback: if the contact wasn't found by HCP customer ID, attempt
        // a phone-based lookup using the customer phone from the estimate payload.
        const estimateCustomerPhone =
          data.customer?.mobile_number || data.customer?.home_number || data.customer?.work_number ||
          (data.customer?.phone_numbers?.[0]?.phone_number);
        if (estimateCustomerPhone) {
          const phoneMatch = await storage.getContactByPhone(estimateCustomerPhone, contractorId);
          if (phoneMatch) {
            log.info(`estimate.created: phone fallback matched contact ${phoneMatch.id} for HCP customer ${customerId}, estimate ${data.id}`);
            await storage.updateContact(phoneMatch.id, {
              housecallProCustomerId: customerId,
              externalId: customerId,
              externalSource: 'housecall-pro',
            }, contractorId);
            contact = phoneMatch;
          }
        }
        // Task #798: before fabricating a new customer/active contact, try an
        // email match. Email-only leads (no phone on the local record) were
        // previously unmatched by the phone-only fallback above and got
        // re-created as `customer`/`active`, vanishing from the Leads pipeline.
        // Linking the HCP customer ID onto the existing lead keeps it a lead.
        if (!contact) {
          const estimateCustomerEmail = data.customer?.email;
          if (estimateCustomerEmail) {
            const emailMatchId = await storage.findMatchingContact(contractorId, [estimateCustomerEmail], undefined);
            if (emailMatchId) {
              const emailMatch = await storage.getContact(emailMatchId, contractorId);
              if (emailMatch) {
                log.info(`estimate.created: email fallback matched contact ${emailMatch.id} for HCP customer ${customerId}, estimate ${data.id}`);
                await storage.updateContact(emailMatch.id, {
                  housecallProCustomerId: customerId,
                  externalId: customerId,
                  externalSource: 'housecall-pro',
                }, contractorId);
                contact = emailMatch;
              }
            }
          }
        }
        // Task #748: if we still have no contact (either no phone on the
        // payload, or no phone match), create one from the estimate's
        // customer block — symmetric with the jobs handler. Previously
        // this fallback was nested under `if (estimateCustomerPhone)` so
        // estimates whose HCP customer had no phone were silently dropped
        // on backfill (the most common cause of "resync didn't import my
        // older estimates"). The contact rather than the estimate is the
        // entity we cannot fabricate, so missing-contact must create one
        // rather than skip.
        if (!contact && data.customer) {
          const estimateCustomer = data.customer;
          const name = [estimateCustomer.first_name, estimateCustomer.last_name].filter(Boolean).join(' ') || estimateCustomer.company || 'Unknown';
          const emails = estimateCustomer.email ? [estimateCustomer.email] : [];
          const phones = estimateCustomerPhone ? [estimateCustomerPhone] : [];
          const hcpAddr = estimateCustomer.address;
          const estStreet = hcpAddr?.street || undefined;
          const estCity = hcpAddr?.city || undefined;
          const estState = hcpAddr?.state || undefined;
          const estZip = hcpAddr?.zip || undefined;
          const address = buildFormattedAddress(estStreet, estCity, estState, estZip);
          log.info(`estimate.created: creating new contact from estimate payload for HCP customer ${customerId}, estimate ${data.id} (phone=${estimateCustomerPhone ? 'yes' : 'no'})`);
          contact = await storage.createContact({
            name,
            emails,
            phones,
            address,
            street: estStreet,
            city: estCity,
            state: estState,
            zip: estZip,
            type: 'customer',
            status: 'active',
            source: estimateCustomer.lead_source ?? null,
            externalId: customerId,
            externalSource: 'housecall-pro',
            housecallProCustomerId: customerId,
          }, contractorId);
          broadcastToContractor(contractorId, { type: 'contact_created', contactId: contact.id });
          workflowEngine.triggerWorkflowsForEvent('contact_created', toWorkflowEvent(contact), contractorId).catch(err =>
            log.error('contact_created trigger error', err));
        }
      }
      if (contact) {
        const fetchResult = await housecallProService.getEstimate(contractorId, data.id);
        const fetched = fetchResult.success && fetchResult.data ? fetchResult.data : null;
        const source = fetched || data;
        const title = fetched ? extractHcpEstimateTitle(fetched) : (source.subject || source.description || 'Estimate');
        const amount = fetched ? extractHcpAmount(fetched).toString() : String((source.total_amount ?? source.amount ?? 0) / 100);
        const status = fetched ? mapHcpEstimateStatus(fetched) : mapHcpEstimateStatus(data);
        const description = source.description || null;
        const hcpOptions = fetched ? (buildHcpOptions(fetched) ?? null) : null;
        const lineItems = fetched ? (buildHcpLineItems(fetched) ?? null) : null;
        const salespersonUserId = fetched ? await resolveSalespersonForHcpEntity(contractorId, fetched) : null;
        const scheduledStart = fetched
          ? (fetched.schedule?.scheduled_start ? new Date(fetched.schedule.scheduled_start) : (fetched.scheduled_start ? new Date(fetched.scheduled_start) : undefined))
          : (source.scheduled_start ? new Date(source.scheduled_start) : undefined);
        const scheduledEnd = fetched
          ? (fetched.schedule?.scheduled_end ? new Date(fetched.schedule.scheduled_end) : (fetched.scheduled_end ? new Date(fetched.scheduled_end) : undefined))
          : (source.scheduled_end ? new Date(source.scheduled_end) : undefined);
        const scheduledEmployeeId = fetched ? extractHcpScheduledEmployeeId(fetched) : extractHcpScheduledEmployeeId(data);
        // Task #721: stamp documentSentAt on creation when the source already
        // carries a sent-like state or `sent_at`. Mirrors the polling/webhook
        // updates so an estimate that arrives already in 'sent' is correctly
        // counted in the Sent tab from day one.
        const createdSentAt = (source as { sent_at?: string }).sent_at;
        const documentSentAt = (status === 'sent' || createdSentAt)
          ? (createdSentAt ? new Date(createdSentAt) : (occurredAt ?? new Date()))
          : undefined;
        const estimate = await storage.createEstimate({
          title,
          description,
          amount,
          status,
          hcpOptions,
          lineItems,
          salespersonUserId,
          contactId: contact.id,
          housecallProEstimateId: data.id,
          externalId: data.id,
          externalSource: 'housecall-pro',
          scheduledStart,
          scheduledEnd,
          scheduledEmployeeId,
          documentSentAt,
          syncedAt: new Date(),
        }, contractorId);
        broadcastToContractor(contractorId, { type: 'estimate_created', estimateId: estimate.id });
        workflowEngine.triggerWorkflowsForEvent('estimate_created', toWorkflowEvent(estimate), contractorId).catch(err =>
          log.error('estimate_created trigger error', err));
      } else {
        log.info(`estimate.created: no local contact found for HCP customer ${customerId}, estimate ${data.id} — will be picked up by next sync`);
      }
    }
    return 'continue';
  }

  if (event_type === 'estimate.scheduled') {
    const estimate = await storage.getEstimateByHousecallProEstimateId(data.id, contractorId);
    if (estimate) {
      const fetchResult = await housecallProService.getEstimate(contractorId, data.id);
      const fetched = fetchResult.success && fetchResult.data ? fetchResult.data : null;
      const updateData: Record<string, any> = {
        status: resolveHcpEstimateStatus('scheduled', estimate.status, estimate.statusManuallySet ?? false),
        scheduledStart: data.scheduled_start ? new Date(data.scheduled_start) : undefined,
        scheduledEnd: data.scheduled_end ? new Date(data.scheduled_end) : undefined,
        syncedAt: new Date(),
      };
      if (fetched) {
        const mapped = mapHcpEstimateStatus(fetched);
        updateData.status = resolveHcpEstimateStatus(mapped, estimate.status, estimate.statusManuallySet ?? false);
        updateData.title = extractHcpEstimateTitle(fetched);
        updateData.amount = extractHcpAmount(fetched).toString();
        updateData.description = fetched.description ?? null;
        updateData.hcpOptions = buildHcpOptions(fetched, estimate.hcpOptions ?? null) ?? null;
        updateData.lineItems = buildHcpLineItems(fetched) ?? null;
        updateData.salespersonUserId = await resolveSalespersonForHcpEntity(contractorId, fetched);
        updateData.scheduledStart = fetched.schedule?.scheduled_start ? new Date(fetched.schedule.scheduled_start) : (fetched.scheduled_start ? new Date(fetched.scheduled_start) : updateData.scheduledStart);
        updateData.scheduledEnd = fetched.schedule?.scheduled_end ? new Date(fetched.schedule.scheduled_end) : (fetched.scheduled_end ? new Date(fetched.scheduled_end) : updateData.scheduledEnd);
        updateData.scheduledEmployeeId = extractHcpScheduledEmployeeId(fetched);
      }
      stampStatusChangeMeta(updateData, estimate.status, event_type, occurredAt, data);
      const updated = await storage.updateEstimate(estimate.id, updateData, contractorId);
      if (updated) {
        broadcastToContractor(contractorId, { type: 'estimate_updated', estimateId: updated.id });
        workflowEngine.triggerWorkflowsForEvent('estimate_updated', toWorkflowEvent(updated), contractorId).catch(err =>
          log.error('estimate_updated trigger error', err));
      }
    }
    return 'continue';
  }

  if (event_type === 'estimate.sent') {
    const estimate = await storage.getEstimateByHousecallProEstimateId(data.id, contractorId);
    if (estimate) {
      const fetchResult = await housecallProService.getEstimate(contractorId, data.id);
      const fetched = fetchResult.success && fetchResult.data ? fetchResult.data : null;
      const updateData: Record<string, any> = {
        status: resolveHcpEstimateStatus('sent', estimate.status, estimate.statusManuallySet ?? false),
        syncedAt: new Date(),
      };
      if (fetched) {
        const mapped = mapHcpEstimateStatus(fetched);
        // Only allow the re-fetched status to override the 'sent' default for terminal states
        // (approved/rejected). This prevents a stale or ambiguous HCP response from
        // accidentally downgrading a sent estimate back to 'scheduled'.
        if (mapped === 'approved' || mapped === 'rejected') {
          updateData.status = resolveHcpEstimateStatus(mapped, estimate.status, estimate.statusManuallySet ?? false);
        }
        updateData.title = extractHcpEstimateTitle(fetched);
        updateData.amount = extractHcpAmount(fetched).toString();
        updateData.description = fetched.description ?? null;
        updateData.hcpOptions = buildHcpOptions(fetched, estimate.hcpOptions ?? null) ?? null;
        updateData.lineItems = buildHcpLineItems(fetched) ?? null;
        updateData.salespersonUserId = await resolveSalespersonForHcpEntity(contractorId, fetched);
        const sentFetchedStart = fetched.schedule?.scheduled_start || fetched.scheduled_start;
        const sentFetchedEnd = fetched.schedule?.scheduled_end || fetched.scheduled_end;
        updateData.scheduledStart = sentFetchedStart ? new Date(sentFetchedStart) : null;
        updateData.scheduledEnd = sentFetchedEnd ? new Date(sentFetchedEnd) : null;
        updateData.scheduledEmployeeId = extractHcpScheduledEmployeeId(fetched);
      }
      // Task #721: estimate.sent is the canonical document-sent signal. Always
      // stamp documentSentAt when not already set. Sticky once set.
      if (!estimate.documentSentAt) {
        const sentAtFromHcp = (fetched as { sent_at?: string } | null)?.sent_at
          ?? (data as { sent_at?: string }).sent_at;
        updateData.documentSentAt = sentAtFromHcp ? new Date(sentAtFromHcp) : (occurredAt ?? new Date());
      }
      stampStatusChangeMeta(updateData, estimate.status, event_type, occurredAt, data);
      const updated = await storage.updateEstimate(estimate.id, updateData, contractorId);
      if (updated) {
        broadcastToContractor(contractorId, { type: 'estimate_updated', estimateId: updated.id });
        workflowEngine.triggerWorkflowsForEvent('estimate_updated', toWorkflowEvent(updated), contractorId).catch(err =>
          log.error('estimate_updated trigger error', err));
        if (updated.status !== estimate.status) {
          workflowEngine.triggerWorkflowsForEvent('estimate_status_changed', toWorkflowEvent(updated), contractorId).catch(err =>
            log.error('estimate_status_changed trigger error', err));
        }
      }
    }
    return 'continue';
  }

  if (event_type === 'estimate.on_my_way') {
    const estimate = await storage.getEstimateByHousecallProEstimateId(data.id, contractorId);
    if (estimate) {
      const updateData: Record<string, any> = {
        status: resolveHcpEstimateStatus('in_progress', estimate.status, estimate.statusManuallySet ?? false),
        syncedAt: new Date(),
      };
      stampStatusChangeMeta(updateData, estimate.status, event_type, occurredAt, data);
      const updated = await storage.updateEstimate(estimate.id, updateData, contractorId);
      if (updated) {
        broadcastToContractor(contractorId, { type: 'estimate_updated', estimateId: updated.id });
        workflowEngine.triggerWorkflowsForEvent('estimate_updated', toWorkflowEvent(updated), contractorId).catch(err =>
          log.error('estimate_updated trigger error', err));
        if (updated.status !== estimate.status) {
          workflowEngine.triggerWorkflowsForEvent('estimate_status_changed', toWorkflowEvent(updated), contractorId).catch(err =>
            log.error('estimate_status_changed trigger error', err));
        }
      }
    }
    return 'continue';
  }

  if (event_type === 'estimate.copy_to_job') {
    const estimate = data.estimate_id ? await storage.getEstimateByHousecallProEstimateId(data.estimate_id, contractorId) : null;
    const job = data.job_id ? await storage.getJobByHousecallProJobId(data.job_id, contractorId) : null;
    if (estimate && job) {
      await storage.updateJob(job.id, { estimateId: estimate.id }, contractorId);
      broadcastToContractor(contractorId, { type: 'estimate_updated', estimateId: estimate.id });
      broadcastToContractor(contractorId, { type: 'job_updated', jobId: job.id });
    } else if (estimate) {
      broadcastToContractor(contractorId, { type: 'estimate_updated', estimateId: estimate.id });
    }
    return 'continue';
  }

  if (event_type === 'estimate.option.created') {
    const estimateId = data.estimate_id || data.id;
    const estimate = estimateId ? await storage.getEstimateByHousecallProEstimateId(estimateId, contractorId) : null;
    if (estimate) {
      const fetchResult = await housecallProService.getEstimate(contractorId, estimateId);
      const fetched = fetchResult.success && fetchResult.data ? fetchResult.data : null;
      if (fetched) {
        const updateData: Record<string, any> = {
          title: extractHcpEstimateTitle(fetched),
          amount: extractHcpAmount(fetched).toString(),
          hcpOptions: buildHcpOptions(fetched, estimate.hcpOptions ?? null) ?? null,
          lineItems: buildHcpLineItems(fetched) ?? null,
          salespersonUserId: await resolveSalespersonForHcpEntity(contractorId, fetched),
          syncedAt: new Date(),
        };
        const updated = await storage.updateEstimate(estimate.id, updateData, contractorId);
        if (updated) {
          broadcastToContractor(contractorId, { type: 'estimate_updated', estimateId: updated.id });
          workflowEngine.triggerWorkflowsForEvent('estimate_updated', toWorkflowEvent(updated), contractorId).catch(err =>
            log.error('estimate_updated trigger error', err));
        }
      } else {
        broadcastToContractor(contractorId, { type: 'estimate_updated', estimateId: estimate.id });
        workflowEngine.triggerWorkflowsForEvent('estimate_updated', toWorkflowEvent(estimate), contractorId).catch(err =>
          log.error('estimate_updated trigger error', err));
      }
    }
    return 'continue';
  }

  if (event_type === 'estimate.option.approval_status_changed') {
    const estimateId = data.estimate_id || data.id;
    const estimate = estimateId ? await storage.getEstimateByHousecallProEstimateId(estimateId, contractorId) : null;
    if (estimate) {
      const approvalStatus = (data.approval_status || data.status || '').toString();
      // `inboundOptionStatus` is used ONLY to decide whether to fire the
      // per-option workflow trigger below. It must NOT short-circuit the
      // parent estimate's status — the parent is always re-derived from the
      // freshly fetched full options array via the corrected mapper. This
      // fixes the Task #484 bug where a single 'pro declined' event would
      // force the parent to 'rejected' even when other options were
      // approved or still pending.
      let inboundOptionStatus: "approved" | "rejected" | undefined;
      if (isHcpApprovedOptionStatus(approvalStatus)) inboundOptionStatus = 'approved';
      else if (isHcpDeclinedOptionStatus(approvalStatus) || isHcpExpiredOptionStatus(approvalStatus)) inboundOptionStatus = 'rejected';
      const fetchResult = await housecallProService.getEstimate(contractorId, estimateId);
      const fetched = fetchResult.success && fetchResult.data ? fetchResult.data : null;
      const updateData: Record<string, any> = {
        syncedAt: new Date(),
      };
      if (fetched) {
        // Re-derive the parent from the FRESHLY fetched full options array.
        // resolveHcpEstimateStatus already treats 'rejected' as terminal and
        // overrides the manual flag, so we can pass the mapped value through
        // it unconditionally without losing the "rejected always wins" rule.
        const mapped = mapHcpEstimateStatus(fetched);
        updateData.status = resolveHcpEstimateStatus(
          mapped,
          estimate.status,
          estimate.statusManuallySet ?? false,
        );
        updateData.title = extractHcpEstimateTitle(fetched);
        updateData.amount = extractHcpAmount(fetched).toString();
        updateData.description = fetched.description ?? null;
        // Pass existing options so buildHcpOptions can stamp approval_status_changed_at
        // for the option whose status flipped in this webhook (and only that one).
        // Prefer the webhook-supplied occurred_at/created_at over wall-clock time so
        // queued or replayed deliveries don't drift the recorded approval timestamp.
        updateData.hcpOptions = buildHcpOptions(fetched, estimate.hcpOptions ?? null, occurredAt ?? new Date()) ?? null;
        updateData.lineItems = buildHcpLineItems(fetched) ?? null;
        updateData.salespersonUserId = await resolveSalespersonForHcpEntity(contractorId, fetched);
        const approvalFetchedStart = fetched.schedule?.scheduled_start || fetched.scheduled_start;
        const approvalFetchedEnd = fetched.schedule?.scheduled_end || fetched.scheduled_end;
        updateData.scheduledStart = approvalFetchedStart ? new Date(approvalFetchedStart) : null;
        updateData.scheduledEnd = approvalFetchedEnd ? new Date(approvalFetchedEnd) : null;
        updateData.scheduledEmployeeId = extractHcpScheduledEmployeeId(fetched);
      }
      // If we couldn't fetch the full estimate, leave the parent status
      // untouched. We have no idea what the OTHER options on the estimate
      // are, and the inbound single-option signal is not enough to safely
      // re-derive parent state. The per-option workflow trigger below still
      // fires so workflow authors can react to the option event itself.
      let updated = estimate;
      if (updateData.status) {
        stampStatusChangeMeta(updateData, estimate.status, event_type, occurredAt, data);
        const result = await storage.updateEstimate(estimate.id, updateData, contractorId);
        if (result) {
          updated = result;
          broadcastToContractor(contractorId, { type: 'estimate_updated', estimateId: result.id });
          if (result.status !== estimate.status) {
            workflowEngine.triggerWorkflowsForEvent('estimate_status_changed', toWorkflowEvent(result), contractorId).catch(err =>
              log.error('estimate_status_changed trigger error', err));
          }
        }
      }
      // Fire option-approved / option-rejected triggers regardless of whether
      // the parent estimate's status changed (multi-option estimates can see
      // one option approved while others remain pending — the parent stays
      // 'sent' but a workflow author still wants to react to the per-option
      // event). Triggers fire once per webhook so multiple option approvals
      // produce multiple events naturally.
      if (inboundOptionStatus === 'approved' || inboundOptionStatus === 'rejected') {
        const optionId: string | undefined = data.option_id || data.id;
        const optionFromFetched = (fetched && Array.isArray((fetched as any).options))
          ? ((fetched as any).options as any[]).find((o) => o?.id === optionId)
          : undefined;
        const optionPayload = {
          id: optionId,
          name: optionFromFetched?.name ?? data.name,
          option_number: optionFromFetched?.option_number ?? data.option_number,
          total_amount: typeof optionFromFetched?.total_amount === 'number'
            ? optionFromFetched.total_amount / 100
            : (typeof data.total_amount === 'number' ? data.total_amount / 100 : undefined),
          approval_status_changed_at: data.approval_status_changed_at || new Date().toISOString(),
        };
        const triggerKey = inboundOptionStatus === 'approved' ? 'estimate_option_approved' : 'estimate_option_rejected';
        const optionField = inboundOptionStatus === 'approved' ? 'approved_option' : 'rejected_option';
        workflowEngine.triggerWorkflowsForEvent(triggerKey, {
          ...toWorkflowEvent(updated),
          [optionField]: optionPayload,
        }, contractorId).catch(err => log.error(`${triggerKey} trigger error`, err));
      }
    }
    return 'continue';
  }

  if (event_type === 'estimate.deleted') {
    const estimate = await storage.getEstimateByHousecallProEstimateId(data.id, contractorId);
    if (estimate) {
      const updateData: Record<string, any> = {
        status: 'rejected' as const,
        scheduledStart: null,
        scheduledEnd: null,
        scheduledEmployeeId: null,
        syncedAt: new Date(),
      };
      stampStatusChangeMeta(updateData, estimate.status, event_type, occurredAt, data);
      const updated = await storage.updateEstimate(estimate.id, updateData, contractorId);
      if (updated) {
        broadcastToContractor(contractorId, { type: 'estimate_updated', estimateId: updated.id });
        workflowEngine.triggerWorkflowsForEvent('estimate_updated', toWorkflowEvent(updated), contractorId).catch(err =>
          log.error('estimate_updated trigger error', err));
        if (updated.status !== estimate.status) {
          workflowEngine.triggerWorkflowsForEvent('estimate_status_changed', toWorkflowEvent(updated), contractorId).catch(err =>
            log.error('estimate_status_changed trigger error', err));
        }
      }
    }
    return 'continue';
  }

  return 'not-handled';
}
