import { storage } from "../../../../storage";
import { broadcastToContractor } from "../../../../websocket";
import { workflowEngine } from "../../../../workflow-engine";
import { toWorkflowEvent } from "../../../../utils/workflow/entity-adapter";
import { logger } from "../../../../utils/logger";
import { normalizePhoneForStorage } from "../../../../utils/phone-normalizer";
import { markContactScheduled } from "../../../../services/contact-status";
import type { HandlerResult } from "../utils";

const log = logger('HCPWebhook');

export async function handleLeadEvent(
  contractorId: string,
  event_type: string,
  data: any,
  _webhookEventId: string | undefined,
): Promise<HandlerResult> {
  if (event_type === 'lead.created') {
    const existingLead = data.id ? await storage.getLeadByHousecallProLeadId(data.id, contractorId) : null;
    if (!existingLead) {
      const name = [data.first_name, data.last_name].filter(Boolean).join(' ') || 'Unknown';
      const emails = data.email ? [data.email] : [];
      const phones = data.phone ? [normalizePhoneForStorage(data.phone)].filter(Boolean) : [];
      let contact = await storage.findMatchingContact(contractorId, emails, phones)
        .then(id => id ? storage.getContact(id, contractorId) : undefined);
      if (!contact) {
        contact = await storage.createContact({
          name,
          emails,
          phones,
          type: 'lead',
          status: 'new',
          source: data.source || 'housecall-pro',
          externalSource: 'housecall-pro',
        }, contractorId);
        broadcastToContractor(contractorId, { type: 'contact_created', contactId: contact.id });
        workflowEngine.triggerWorkflowsForEvent('contact_created', toWorkflowEvent(contact), contractorId).catch(err =>
          log.error('contact_created trigger error', err));
      } else if (contact.type !== 'lead') {
        const updatedContact = await storage.updateContact(contact.id, { type: 'lead' as const, status: 'new' as const }, contractorId);
        if (updatedContact) contact = updatedContact;
        broadcastToContractor(contractorId, { type: 'contact_updated', contactId: contact.id });
        workflowEngine.triggerWorkflowsForEvent('contact_updated', toWorkflowEvent(contact), contractorId).catch(err =>
          log.error('contact_updated trigger error', err));
        workflowEngine.triggerWorkflowsForEvent('contact_status_changed', toWorkflowEvent(contact), contractorId).catch(err =>
          log.error('contact_status_changed trigger error', err));
      }
      await storage.createLead({
        contactId: contact.id,
        status: 'new',
        source: data.source || 'housecall-pro',
        message: data.note || data.message || null,
        housecallProLeadId: data.id,
      }, contractorId);
    }
    return 'continue';
  }

  if (event_type === 'lead.updated') {
    const lead = data.id ? await storage.getLeadByHousecallProLeadId(data.id, contractorId) : null;
    if (lead) {
      const updates: Record<string, unknown> = {};
      if (data.note || data.message) updates.message = data.note || data.message;
      if (data.source) updates.source = data.source;
      if (Object.keys(updates).length > 0) {
        await storage.updateLead(lead.id, updates, contractorId);
      }
      let contact = await storage.getContact(lead.contactId, contractorId);
      if (contact) {
        const contactUpdates: Record<string, unknown> = {};
        const name = [data.first_name, data.last_name].filter(Boolean).join(' ');
        if (name) contactUpdates.name = name;
        if (data.email) contactUpdates.emails = [data.email];
        if (data.phone) contactUpdates.phones = [normalizePhoneForStorage(data.phone)].filter(Boolean);
        if (Object.keys(contactUpdates).length > 0) {
          const updatedContact = await storage.updateContact(contact.id, contactUpdates, contractorId);
          if (updatedContact) contact = updatedContact;
        }
        broadcastToContractor(contractorId, { type: 'contact_updated', contactId: contact.id });
        workflowEngine.triggerWorkflowsForEvent('contact_updated', toWorkflowEvent(contact), contractorId).catch(err =>
          log.error('contact_updated trigger error', err));
      }
    }
    return 'continue';
  }

  if (event_type === 'lead.deleted') {
    const lead = data.id ? await storage.getLeadByHousecallProLeadId(data.id, contractorId) : null;
    if (lead) {
      const contact = await storage.getContact(lead.contactId, contractorId);
      if (contact) {
        await storage.updateContact(contact.id, { type: 'inactive' as const }, contractorId);
        broadcastToContractor(contractorId, { type: 'contact_updated', contactId: contact.id });
        workflowEngine.triggerWorkflowsForEvent('contact_status_changed', toWorkflowEvent({ ...contact, type: 'inactive' }), contractorId).catch(err =>
          log.error('contact_status_changed trigger error', err));
      }
    }
    return 'continue';
  }

  if (event_type === 'lead.converted') {
    const lead = data.id ? await storage.getLeadByHousecallProLeadId(data.id, contractorId) : null;
    if (lead) {
      await storage.updateLead(lead.id, { status: 'converted', convertedAt: new Date() }, contractorId);
      // Centralized helper: idempotent — if the in-app booking flow already flipped
      // this contact to scheduled, the workflow trigger is NOT re-fired.
      await markContactScheduled(lead.contactId, contractorId, {
        source: 'hcp_lead_converted',
      }).catch(err => log.error('markContactScheduled (lead.converted) failed:', err));
    }
    return 'continue';
  }

  if (event_type === 'lead.lost') {
    const lead = data.id ? await storage.getLeadByHousecallProLeadId(data.id, contractorId) : null;
    if (lead) {
      // HCP "lead.lost" maps to our new lead_status='lost' (#516) — distinct from
      // disqualified, which is reserved for bad-fit/spam leads.
      await storage.updateLead(lead.id, { status: 'lost' }, contractorId);
      const contact = await storage.getContact(lead.contactId, contractorId);
      if (contact) {
        await storage.updateContact(contact.id, { status: 'lost' as const }, contractorId);
        broadcastToContractor(contractorId, { type: 'contact_updated', contactId: contact.id });
        workflowEngine.triggerWorkflowsForEvent('contact_status_changed', toWorkflowEvent({ ...contact, status: 'lost' }), contractorId).catch(err =>
          log.error('contact_status_changed trigger error', err));
      }
    }
    return 'continue';
  }

  return 'not-handled';
}
