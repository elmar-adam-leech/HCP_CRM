import { storage } from "../../../../storage";
import { broadcastToContractor } from "../../../../websocket";
import { workflowEngine } from "../../../../workflow-engine";
import { toWorkflowEvent } from "../../../../utils/workflow/entity-adapter";
import { logger } from "../../../../utils/logger";
import { isHcpCustomerEchoPending, clearHcpCustomerEcho } from "../../../../utils/hcp-echo-suppression";
import { buildFormattedAddress } from "../../../../utils/address";
import type { HandlerResult } from "../utils";

const log = logger('HCPWebhook');

export async function handleCustomerEvent(
  contractorId: string,
  event_type: string,
  data: any,
  _webhookEventId: string | undefined,
): Promise<HandlerResult> {
  if (event_type === 'customer.created' || event_type === 'customer.updated') {
    if (event_type === 'customer.created' && isHcpCustomerEchoPending(data.id)) {
      log.debug(`skipping echo for recently pushed customer ${data.id}`);
      clearHcpCustomerEcho(data.id);
    } else {
      const contact = await storage.getContactByExternalId(data.id, 'housecall-pro', contractorId);
      if (contact) {
        // Sync HCP lead_source onto contacts.source for existing HCP contacts.
        // We only overwrite if the local value is null or the legacy system
        // marker 'housecall-pro' so admin-set values are preserved.
        const incomingSource = (typeof data.lead_source === 'string' && data.lead_source.trim() !== '')
          ? data.lead_source.trim()
          : null;
        const localSource = contact.source ?? null;
        const isLegacyOrEmpty = localSource === null || localSource === 'housecall-pro';
        let effectiveContact = contact;
        if (isLegacyOrEmpty && incomingSource !== localSource) {
          const updated = await storage.updateContact(contact.id, { source: incomingSource }, contractorId);
          if (updated) effectiveContact = updated;
        }
        const eventKey = event_type === 'customer.created' ? 'contact_created' : 'contact_updated';
        broadcastToContractor(contractorId, { type: eventKey, contactId: effectiveContact.id });
        workflowEngine.triggerWorkflowsForEvent(eventKey, toWorkflowEvent(effectiveContact), contractorId).catch(err =>
          log.error(`${eventKey} trigger error`, err));
      } else if (event_type === 'customer.created') {
        // No local contact linked to this HCP customer ID yet.
        // Run phone-based deduplication: match an existing contact by normalized
        // phone and update its HCP customer ID, or create a new contact.
        const excluded = await storage.isHcpCustomerExcluded(contractorId, data.id);
        if (excluded) {
          log.info(`customer.created: HCP customer ${data.id} is excluded, skipping`);
        } else {
          const customerPhone =
            data.mobile_number || data.home_number || data.work_number ||
            (data.phone_numbers?.[0]?.phone_number);
          let resolvedContact = customerPhone
            ? await storage.getContactByPhone(customerPhone, contractorId)
            : undefined;

          if (resolvedContact) {
            // Phone match found — link this HCP customer ID to the existing contact.
            log.info(`customer.created: phone match found for HCP customer ${data.id} → contact ${resolvedContact.id}, updating housecallProCustomerId`);
            const incomingSource = (typeof data.lead_source === 'string' && data.lead_source.trim() !== '')
              ? data.lead_source.trim()
              : null;
            const localSource = resolvedContact.source ?? null;
            const sourcePatch = (localSource === null || localSource === 'housecall-pro')
              ? { source: incomingSource }
              : {};
            const updated = await storage.updateContact(resolvedContact.id, {
              housecallProCustomerId: data.id,
              externalId: data.id,
              externalSource: 'housecall-pro',
              ...sourcePatch,
            }, contractorId);
            const effectiveContact = updated || resolvedContact;
            broadcastToContractor(contractorId, { type: 'contact_updated', contactId: effectiveContact.id });
            workflowEngine.triggerWorkflowsForEvent('contact_updated', toWorkflowEvent(effectiveContact), contractorId).catch(err =>
              log.error('contact_updated trigger error', err));
          } else {
            // No phone match — create a new contact from the HCP customer payload.
            const name = [data.first_name, data.last_name].filter(Boolean).join(' ') || data.company || 'Unknown';
            const emails = data.email ? [data.email] : [];
            const phones = customerPhone ? [customerPhone] : [];
            const custStreet = data.address?.street || undefined;
            const custCity = data.address?.city || undefined;
            const custState = data.address?.state || undefined;
            const custZip = data.address?.zip || undefined;
            const address = buildFormattedAddress(custStreet, custCity, custState, custZip);
            log.info(`customer.created: no phone match for HCP customer ${data.id}, creating new contact`);
            const newContact = await storage.createContact({
              name,
              emails,
              phones,
              address,
              street: custStreet,
              city: custCity,
              state: custState,
              zip: custZip,
              type: 'customer',
              status: 'active',
              source: data.lead_source ?? null,
              externalId: data.id,
              externalSource: 'housecall-pro',
              housecallProCustomerId: data.id,
            }, contractorId);
            broadcastToContractor(contractorId, { type: 'contact_created', contactId: newContact.id });
            workflowEngine.triggerWorkflowsForEvent('contact_created', toWorkflowEvent(newContact), contractorId).catch(err =>
              log.error('contact_created trigger error', err));
          }
        }
      }
    }
    return 'continue';
  }

  if (event_type === 'customer.deleted') {
    const contact = await storage.getContactByExternalId(data.id, 'housecall-pro', contractorId);
    if (contact) {
      await storage.updateContact(contact.id, { type: 'inactive' as const }, contractorId);
      broadcastToContractor(contractorId, { type: 'contact_updated', contactId: contact.id });
      workflowEngine.triggerWorkflowsForEvent('contact_status_changed', toWorkflowEvent({ ...contact, type: 'inactive' }), contractorId).catch(err =>
        log.error('contact_status_changed trigger error', err));
    }
    return 'continue';
  }

  return 'not-handled';
}
