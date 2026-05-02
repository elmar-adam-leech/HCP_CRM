import { type Contact, type Lead } from '@shared/schema';
import { storage } from '../storage';
import { normalizePhoneForStorage, normalizePhoneForHcp, maskPhone } from '../utils/phone-normalizer';
import { workflowEngine } from '../workflow-engine';
import { toWorkflowEvent } from '../utils/workflow/entity-adapter';
import { autoAssignLead } from '../routes/assignments';
import { isIntegrationEnabledCached } from '../services/cache';
import { housecallProService } from '../hcp/index';
import { logger } from '../utils/logger';
import { resolveHcpLeadSource } from '../utils/hcp-helpers';
import { db } from '../db';
import { leads, activities } from '@shared/schema';
import { eq, and, gte } from 'drizzle-orm';
import { logConsent, hashIp } from '../utils/consent-log';
import { normalizeAddress } from '../utils/normalize-address';
import { buildContactEnrichment } from '../utils/contact-enrichment';
import { buildFormattedAddress, parseAddressString } from '../utils/address';
import { syncHcpCustomerAddress } from '../scheduling/hcp-customer';

const log = logger('LeadIngestion');

// HCP base client throws "Housecall Pro API key not configured for tenant <id>"
// when no credential row exists. Detect that string so we can record a
// dedicated `integration_credentials_missing` skip reason instead of a
// generic API failure.
function isCredentialsMissingError(error: string | undefined): boolean {
  if (!error) return false;
  return /api key not configured/i.test(error) || /failed to get housecall pro credentials/i.test(error);
}

export interface IngestLeadInput {
  name: string;
  emails?: string[];
  phones?: string[];
  address?: string;
  street?: string;
  city?: string;
  state?: string;
  zip?: string;
  notes?: string;
  tags?: string[];

  source: string;
  message?: string;
  rawPayload?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmTerm?: string;
  utmContent?: string;
  pageUrl?: string;
  followUpDate?: Date;

  skipDuplicateLeadWithinHours?: number;
  skipAutoAssign?: boolean;
  skipHcpSync?: boolean;
  skipWorkflows?: boolean;
  skipContactMatching?: boolean;
  activityNote?: string;
  activityExternalId?: string;

  ipAddress?: string;
  consentMetadata?: Record<string, unknown>;
}

export interface IngestLeadResult {
  contact: Contact;
  lead: Lead;
  isNewContact: boolean;
  skippedDuplicateLead: boolean;
}

export async function ingestLead(
  contractorId: string,
  input: IngestLeadInput
): Promise<IngestLeadResult> {
  const dedupHours = input.skipDuplicateLeadWithinHours ?? 24;

  log.info(`[phone-pipeline] lead-ingestion input phones: [${(input.phones || []).map(maskPhone).join(', ')}] — source: ${input.source}, contractor: ${contractorId}`);
  const normalizedPhones = (input.phones || [])
    .map(p => normalizePhoneForStorage(p))
    .filter(Boolean) as string[];
  log.info(`[phone-pipeline] lead-ingestion after re-normalization: [${normalizedPhones.map(maskPhone).join(', ')}]`);

  // Always recompute formatted address from structured fields when any are present,
  // so the address column stays in sync even if caller passed a stale address string.
  if (input.street || input.city || input.state || input.zip) {
    const computed = buildFormattedAddress(input.street, input.city, input.state, input.zip);
    if (computed) {
      input = { ...input, address: computed };
    }
  }

  // Normalize address via Google Places text-search before any DB writes
  if (input.address && input.address.trim()) {
    const canonical = await normalizeAddress(input.address, process.env.GOOGLE_MAPS_API_KEY);
    if (canonical) {
      input = { ...input, address: canonical };
    }
  }

  const emails = input.emails || [];

  const existingContactId = input.skipContactMatching
    ? null
    : await storage.findMatchingContact(
        contractorId,
        emails.length > 0 ? emails : undefined,
        normalizedPhones.length > 0 ? normalizedPhones : undefined
      );

  let contact: Contact | undefined;
  let isNewContact = false;

  if (existingContactId) {
    contact = await storage.getContact(existingContactId, contractorId);

    if (contact) {
      const contactLeads = await storage.getLeadsByContact(contact.id, contractorId);
      const hasAgedLeads = contactLeads.some(l => l.aged);
      if (hasAgedLeads) {
        await storage.unageLead(contact.id, contractorId);
        await storage.updateContact(contact.id, { contactedAt: new Date() }, contractorId);
        log.info(`Auto-reactivated aged leads for contact ${contact.id} due to new submission`);
      }
    }

    if (contact && dedupHours > 0) {
      const since = new Date(Date.now() - dedupHours * 60 * 60 * 1000);
      const recentLeads = await db.select({ id: leads.id })
        .from(leads)
        .where(and(
          eq(leads.contactId, contact.id),
          eq(leads.contractorId, contractorId),
          eq(leads.archived, false),
          gte(leads.createdAt, since)
        ))
        .limit(1);

      if (recentLeads.length > 0) {
        const existingLead = await db.select().from(leads)
          .where(and(eq(leads.id, recentLeads[0].id), eq(leads.contractorId, contractorId)))
          .limit(1);
        log.info(`Skipping duplicate lead for contact ${contact.id} — recent lead ${recentLeads[0].id} exists within ${dedupHours}h window`);

        const enrichment = buildContactEnrichment(contact, input, normalizedPhones);
        if (enrichment) {
          log.info(`Enriching contact ${contact.id} with new fields from duplicate lead: ${Object.keys(enrichment).join(', ')}`);
          const updated = await storage.updateContact(contact.id, enrichment, contractorId);
          if (updated) contact = updated;
        }

        return {
          contact,
          lead: existingLead[0],
          isNewContact: false,
          skippedDuplicateLead: true,
        };
      }
    }

    // Enrich the existing contact with any new non-empty fields from the incoming payload
    // (tags, notes, address, UTM fields, phones, emails) even when no duplicate lead exists
    if (contact) {
      const enrichment = buildContactEnrichment(contact, input, normalizedPhones);
      if (enrichment) {
        log.info(`Enriching existing contact ${contact.id} with fields from new lead: ${Object.keys(enrichment).join(', ')}`);
        const updated = await storage.updateContact(contact.id, enrichment, contractorId);
        if (updated) contact = updated;
      } else if (normalizedPhones.length > 0 && (!contact.phones || contact.phones.length === 0)) {
        const updated = await storage.updateContact(contact.id, { phones: normalizedPhones }, contractorId);
        if (updated) contact = updated;
      }
    }
  }

  if (!contact) {
    contact = await storage.createContact({
      name: input.name,
      emails,
      phones: normalizedPhones,
      address: input.address,
      street: input.street,
      city: input.city,
      state: input.state,
      zip: input.zip,
      source: input.source,
      notes: input.notes,
      tags: input.tags,
      type: 'lead',
      status: 'new',
      ...(input.utmSource && { utmSource: input.utmSource }),
      ...(input.utmMedium && { utmMedium: input.utmMedium }),
      ...(input.utmCampaign && { utmCampaign: input.utmCampaign }),
      ...(input.utmTerm && { utmTerm: input.utmTerm }),
      ...(input.utmContent && { utmContent: input.utmContent }),
      ...(input.pageUrl && { pageUrl: input.pageUrl }),
      ...(input.followUpDate && { followUpDate: input.followUpDate }),
    }, contractorId);
    isNewContact = true;
  }

  const lead = await storage.createLead({
    contactId: contact.id,
    status: 'new',
    source: input.source,
    message: input.message,
    rawPayload: input.rawPayload,
    utmSource: input.utmSource,
    utmMedium: input.utmMedium,
    utmCampaign: input.utmCampaign,
    utmTerm: input.utmTerm,
    utmContent: input.utmContent,
    pageUrl: input.pageUrl,
    followUpDate: input.followUpDate,
  }, contractorId);

  if (input.activityNote) {
    let skipNote = false;
    if (input.activityExternalId) {
      const existing = await db.select({ id: activities.id })
        .from(activities)
        .where(and(
          eq(activities.externalId, input.activityExternalId),
          eq(activities.externalSource, 'lead_capture'),
          eq(activities.contractorId, contractorId)
        ))
        .limit(1);
      skipNote = existing.length > 0;
    }
    if (!skipNote) {
      await storage.createActivity({
        type: 'note',
        title: `Lead captured: ${input.source}`,
        content: input.activityNote,
        contactId: contact.id,
        userId: null,
        externalId: input.activityExternalId,
        externalSource: 'lead_capture',
      }, contractorId);
    }
  }

  if (!input.skipWorkflows) {
    if (isNewContact) {
      workflowEngine.triggerWorkflowsForEvent('contact_created', toWorkflowEvent(contact), contractorId).catch(err => {
        log.error('Workflow trigger error (contact_created):', err instanceof Error ? err.message : err);
      });
    } else {
      workflowEngine.triggerWorkflowsForEvent('contact_updated', toWorkflowEvent(contact), contractorId).catch(err => {
        log.error('Workflow trigger error (contact_updated):', err instanceof Error ? err.message : err);
      });
    }
  }

  if (!input.skipAutoAssign) {
    autoAssignLead(lead.id, contractorId, {
      source: lead.source,
      message: lead.message,
      utmCampaign: lead.utmCampaign || null,
      status: lead.status,
      tags: contact.tags,
    }).catch(err => {
      log.error('Auto-assign error:', err instanceof Error ? err.message : err);
    });
  }

  if (!input.skipHcpSync) {
    setImmediate(async () => {
      const ctx = {
        contractorId,
        contactId: contact!.id,
        leadId: lead.id,
        source: input.source,
      };

      const recordSkip = async (reason: string, detail?: string) => {
        log.info(`HCP push skipped: reason=${reason} contractor=${ctx.contractorId} contact=${ctx.contactId} lead=${ctx.leadId} source=${ctx.source}${detail ? ` detail="${detail}"` : ''}`);
        try {
          await storage.updateLead(lead.id, { hcpSyncSkipReason: reason, hcpSyncSkipDetail: detail ?? null }, contractorId);
        } catch (e) {
          log.error(`HCP: failed to persist skip reason on lead ${lead.id}:`, e instanceof Error ? e.message : e);
        }
      };

      const recordFailure = async (reason: string, detail?: string) => {
        log.error(`HCP push failed: reason=${reason} contractor=${ctx.contractorId} contact=${ctx.contactId} lead=${ctx.leadId} source=${ctx.source} detail="${detail ?? ''}"`);
        try {
          await storage.updateLead(lead.id, { hcpSyncSkipReason: reason, hcpSyncSkipDetail: detail ?? null }, contractorId);
        } catch (e) {
          log.error(`HCP: failed to persist failure reason on lead ${lead.id}:`, e instanceof Error ? e.message : e);
        }
      };

      try {
        const hcpEnabled = await isIntegrationEnabledCached(contractorId, 'housecall-pro');
        if (!hcpEnabled) {
          await recordSkip('integration_disabled');
          return;
        }

        const contractor = await storage.getContractor(contractorId);
        if (!contractor) {
          await recordSkip('integration_disabled', 'contractor not found');
          return;
        }
        if (contractor.hcpSendLeads === false) {
          await recordSkip('send_leads_off');
          return;
        }
        const skipTags = (contractor.hcpSyncSkipTags ?? []).map(t => t.toLowerCase().trim());
        if (skipTags.length > 0 && contact && Array.isArray(contact.tags)) {
          const leadTags = (contact.tags as string[]).map(t => t.toLowerCase().trim());
          const matched = skipTags.find(tag => leadTags.includes(tag));
          if (matched) {
            await recordSkip('skip_tag_matched', `tag="${matched}"`);
            return;
          }
        }

        const freshContact = await storage.getContact(contact!.id, contractorId);
        if (!freshContact) {
          await recordSkip('integration_disabled', 'contact not found after creation');
          return;
        }

        // Build the structured service-address payload once so both the
        // new-customer and existing-customer branches can pass it through to
        // syncHcpCustomerAddress and end up with a verified `address_id` on
        // the resulting HCP lead.
        const ingestionAddressData: { street: string; city: string; state: string; zip: string; country?: string } | undefined =
          (freshContact.street || freshContact.city || freshContact.state || freshContact.zip)
            ? {
                street: freshContact.street || '',
                city: freshContact.city || '',
                state: freshContact.state || '',
                zip: freshContact.zip || '',
              }
            : (freshContact.address ? (() => {
                const parsed = parseAddressString(freshContact.address!);
                return parsed.street ? {
                  street: parsed.street,
                  city: parsed.city || '',
                  state: parsed.state || '',
                  zip: parsed.zip || '',
                } : undefined;
              })() : undefined);

        if (!freshContact.housecallProCustomerId) {
          const nameParts = freshContact.name.split(' ');
          const firstName = nameParts[0] || '';
          const lastName = nameParts.slice(1).join(' ') || '';

          let hcpCustomerId: string | undefined;
          const searchEmail = freshContact.emails?.[0];
          const searchPhone = freshContact.phones?.[0];
          // HCP rejects formatted phones (e.g. "(415) 555-1234") with
          // "Mobile number must be exactly 10 digits". Strip non-digits and
          // drop a leading 1 before sending to either search or create.
          const hcpPhone = normalizePhoneForHcp(searchPhone);

          if (!searchEmail && !searchPhone) {
            await recordSkip('no_email_or_phone');
            return;
          }

          const searchResult = await housecallProService.searchCustomers(contractorId, {
            email: searchEmail,
            phone: hcpPhone
          });
          if (searchResult.success && searchResult.data && searchResult.data.length > 0) {
            hcpCustomerId = searchResult.data[0].id;
          } else if (!searchResult.success && isCredentialsMissingError(searchResult.error)) {
            await recordSkip('integration_credentials_missing', searchResult.error);
            return;
          }

          const hcpLeadSource = await resolveHcpLeadSource(contractorId, input.source);
          if (!hcpCustomerId) {
            const hcpCustomerResult = await housecallProService.createCustomer(contractorId, {
              first_name: firstName,
              last_name: lastName,
              email: searchEmail,
              mobile_number: hcpPhone,
              lead_source: hcpLeadSource,
              notes: input.notes || undefined,
              addresses: ingestionAddressData ? [{
                street: ingestionAddressData.street,
                city: ingestionAddressData.city,
                state: ingestionAddressData.state,
                zip: ingestionAddressData.zip,
                type: 'service' as const,
              }] : undefined
            });
            if (hcpCustomerResult.success && hcpCustomerResult.data?.id) {
              hcpCustomerId = hcpCustomerResult.data.id;
            } else if (isCredentialsMissingError(hcpCustomerResult.error)) {
              await recordSkip('integration_credentials_missing', hcpCustomerResult.error);
              return;
            } else {
              await recordFailure('failed_create_customer', hcpCustomerResult.error || 'unknown error');
              return;
            }
          }

          await storage.updateContact(freshContact.id, { housecallProCustomerId: hcpCustomerId }, contractorId);

          // Sync the service address to recover the `address_id` HCP assigned
          // to it (the create response can omit the addresses array entirely),
          // and pass it through so the resulting lead is pinned to the right
          // address record. Failures here are non-fatal: we still create the
          // lead, just without `address_id`.
          let serviceAddressId: string | undefined;
          if (ingestionAddressData?.street) {
            try {
              const synced = await syncHcpCustomerAddress(contractorId, hcpCustomerId, ingestionAddressData);
              serviceAddressId = synced?.id;
            } catch (err) {
              log.warn(`HCP: address sync threw for new customer ${hcpCustomerId}: ${err instanceof Error ? err.message : String(err)}`);
            }
          }

          const hcpLeadResult = await housecallProService.createLead(contractorId, {
            customer_id: hcpCustomerId,
            lead_source: hcpLeadSource,
            note: input.message || undefined,
            address_id: serviceAddressId,
          });
          if (hcpLeadResult.success && hcpLeadResult.data?.id) {
            log.info(`HCP: created lead ${hcpLeadResult.data.id} for customer ${hcpCustomerId} addressId=${serviceAddressId ?? '<none>'}`);
            await storage.updateLead(lead.id, {
              housecallProLeadId: hcpLeadResult.data.id,
              hcpSyncSkipReason: null,
              hcpSyncSkipDetail: null,
            }, contractorId);
          } else if (isCredentialsMissingError(hcpLeadResult.error)) {
            await recordSkip('integration_credentials_missing', hcpLeadResult.error);
          } else {
            await recordFailure('failed_create_lead', hcpLeadResult.error || 'unknown error');
          }
        } else {
          const hcpLeadSource = await resolveHcpLeadSource(contractorId, input.source);

          // Existing HCP customer: previously this branch skipped the address
          // sync entirely, which meant the resulting lead inherited the
          // customer's billing address. Run the same sync used by the
          // scheduling flow so the lead gets pinned to the right service
          // address record.
          let serviceAddressId: string | undefined;
          if (ingestionAddressData?.street) {
            try {
              const synced = await syncHcpCustomerAddress(
                contractorId,
                freshContact.housecallProCustomerId,
                ingestionAddressData,
              );
              serviceAddressId = synced?.id;
            } catch (err) {
              log.warn(`HCP: address sync threw for existing customer ${freshContact.housecallProCustomerId}: ${err instanceof Error ? err.message : String(err)}`);
            }
          }

          const hcpLeadResult = await housecallProService.createLead(contractorId, {
            customer_id: freshContact.housecallProCustomerId,
            lead_source: hcpLeadSource,
            note: input.message || undefined,
            address_id: serviceAddressId,
          });
          if (hcpLeadResult.success && hcpLeadResult.data?.id) {
            log.info(`HCP: created lead ${hcpLeadResult.data.id} for existing customer ${freshContact.housecallProCustomerId} addressId=${serviceAddressId ?? '<none>'}`);
            await storage.updateLead(lead.id, {
              housecallProLeadId: hcpLeadResult.data.id,
              hcpSyncSkipReason: null,
              hcpSyncSkipDetail: null,
            }, contractorId);
          } else if (isCredentialsMissingError(hcpLeadResult.error)) {
            await recordSkip('integration_credentials_missing', hcpLeadResult.error);
          } else {
            await recordFailure('failed_create_lead', hcpLeadResult.error || 'unknown error');
          }
        }
      } catch (hcpError) {
        log.error(`HCP background sync error: contractor=${ctx.contractorId} contact=${ctx.contactId} lead=${ctx.leadId} source=${ctx.source}`, hcpError);
        await recordFailure('failed_create_lead', hcpError instanceof Error ? hcpError.message : String(hcpError));
      }
    });
  }

  logConsent({
    contractorId,
    contactId: contact.id,
    source: input.source,
    optInType: 'implied',
    ipHash: hashIp(input.ipAddress),
    metadata: {
      ...(input.consentMetadata ?? {}),
      source: input.source,
      leadId: lead.id,
    },
  }).catch(err => log.error('Consent log error (non-fatal):', err));

  log.info(`Ingested lead ${lead.id} for contact ${contact.id} (source=${input.source}, new=${isNewContact})`);
  return { contact, lead, isNewContact, skippedDuplicateLead: false };
}
