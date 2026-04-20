/**
 * Facebook Lead Ads polling sync.
 *
 * Why this exists:
 *   Facebook lead webhooks are unreliable — subscriptions silently drop, Meta delays
 *   delivery, tokens expire, etc. This module polls the Facebook Graph API every
 *   ~5 minutes for leads created since the last successful poll, so leads still flow
 *   in even when the webhook fails. Deduplication via lead-ingestion's
 *   `skipDuplicateLeadWithinHours` prevents double-importing leads already received
 *   via webhook.
 *
 * Also exports `processFacebookLead` — the shared lead processing function used by
 * the webhook handler, the manual sync endpoint, and this poller.
 */
import axios from 'axios';
import { CredentialService } from '../credential-service';
import { facebookService } from '../services/facebook-service';
import { ingestLead, type IngestLeadResult } from '../services/lead-ingestion';
import { logger } from '../utils/logger';
import { normalizePhoneForStorage } from '../utils/phone-normalizer';

const log = logger('FacebookLeadsSync');

const FB_API_VERSION = 'v25.0';
const FB_ADDRESS_FIELDS = ['street_address', 'city', 'state', 'zip', 'post_code', 'country'];

// Default look-back window when no last_poll_at is recorded yet.
const DEFAULT_LOOKBACK_MS = 60 * 60_000; // 1 hour

// Small overlap window so leads created right at the boundary are not missed
// if Meta's created_time and our clock differ slightly.
const POLL_OVERLAP_MS = 60_000; // 1 minute

export interface FacebookLeadResource {
  id: string;
  field_data?: Array<{ name: string; values: string[] }>;
  ad_id?: string;
  ad_name?: string;
  form_id?: string;
  created_time?: string;
}

export interface ProcessFacebookLeadOptions {
  contractorId: string;
  leadResource: FacebookLeadResource;
  /** Where this lead came from (used for logging only). */
  source: 'webhook' | 'poll' | 'manual-sync';
  /**
   * Form name from /{form_id}?fields=name. Optional — embedded in rawPayload.
   * For the webhook path we look it up; for the poll/manual-sync path the caller
   * already has the form name from the `/leadgen_forms` listing.
   */
  formName?: string;
  /** Page access token used to look up the form name when not provided. */
  pageAccessToken?: string;
  /** Override dedup window (defaults to 24 hours, matching webhook behavior). */
  skipDuplicateLeadWithinHours?: number;
  /** Override the request IP (used by manual sync to record requester IP). */
  ipAddress?: string;
  /** Pre-loaded credentials — if not provided they are fetched from CredentialService. */
  fieldMappings?: Record<string, string>;
  formTagRules?: Record<string, string[]>;
}

export interface ProcessFacebookLeadResult {
  leadgenId: string;
  result: IngestLeadResult;
}

/**
 * Convert a single Facebook leadgen API resource into a CRM lead via
 * `ingestLead`. Shared by the webhook handler, the manual sync endpoint, and the
 * automatic poller so they all apply identical field mapping, address assembly,
 * and tag rules.
 */
export async function processFacebookLead(
  opts: ProcessFacebookLeadOptions
): Promise<ProcessFacebookLeadResult> {
  const { contractorId, leadResource, source } = opts;
  const leadgenId = String(leadResource.id);

  // Load mappings + tag rules if the caller didn't pre-load them.
  let mappings: Record<string, string> = opts.fieldMappings ?? {};
  if (!opts.fieldMappings) {
    const mappingsStr = await CredentialService.getCredential(contractorId, 'facebook-leads', 'field_mappings');
    if (mappingsStr) {
      try { mappings = JSON.parse(mappingsStr); } catch (err) { log.error('Failed to parse field_mappings:', err); }
    }
  }

  let formTagRules: Record<string, string[]> = opts.formTagRules ?? {};
  if (!opts.formTagRules) {
    const formTagRulesStr = await CredentialService.getCredential(contractorId, 'facebook-leads', 'form_tag_rules');
    if (formTagRulesStr) {
      try { formTagRules = JSON.parse(formTagRulesStr); } catch (err) { log.error('Failed to parse form_tag_rules:', err); }
    }
  }

  const formId = leadResource.form_id ? String(leadResource.form_id) : '';
  if (!formId) {
    log.warn(`Facebook lead ${leadgenId} (${source}) for contractor ${contractorId} has no form_id — tag rules cannot be applied`);
  } else if (!formTagRules[formId]) {
    log.warn(`Facebook lead ${leadgenId} (${source}) for contractor ${contractorId} has form_id="${formId}" but no matching tag rule found — tags will not be assigned`);
  }
  const formTags: string[] = formId && formTagRules[formId] ? formTagRules[formId] : [];

  // Best-effort form name lookup for diagnostic purposes.
  let formName = opts.formName ?? '';
  if (!formName && formId && opts.pageAccessToken) {
    try {
      const formRes = await axios.get(`https://graph.facebook.com/${FB_API_VERSION}/${formId}`, {
        params: { fields: 'name', access_token: opts.pageAccessToken },
        timeout: 5000,
      });
      formName = formRes.data?.name ?? '';
    } catch {
      // form name is best-effort; don't fail lead ingestion
    }
  }

  // Flatten Facebook field_data → { fieldName: value }
  const fieldData = leadResource.field_data ?? [];
  const fields: Record<string, string> = {};
  for (const field of fieldData) {
    fields[field.name] = field.values?.[0] ?? '';
  }

  // Apply user-defined field mappings.
  let mappedName = '';
  let mappedEmail = '';
  let mappedPhone = '';
  let mappedAddress = '';
  let mappedNotes = '';
  const usedFields = new Set<string>();

  for (const [fbField, target] of Object.entries(mappings)) {
    const value = fields[fbField];
    if (!value) continue;
    if (target === 'name') { mappedName = value; usedFields.add(fbField); }
    else if (target === 'email') { mappedEmail = value; usedFields.add(fbField); }
    else if (target === 'phone') { mappedPhone = value; usedFields.add(fbField); }
    else if (target === 'address') { mappedAddress = value; usedFields.add(fbField); }
    else if (target === 'notes') {
      mappedNotes = (mappedNotes ? mappedNotes + '\n' : '') + `${fbField}: ${value}`;
      usedFields.add(fbField);
    }
  }

  // Fall back to Facebook's standard address components.
  const fbStreet = fields['street_address'] || undefined;
  const fbCity = fields['city'] || undefined;
  const fbState = fields['state'] || undefined;
  const fbZip = fields['zip'] || fields['post_code'] || undefined;
  if (!mappedAddress) {
    const stateZip = [fbState, fbZip].filter(Boolean).join(' ');
    const parts = [fbStreet, fbCity, stateZip].filter(Boolean);
    if (parts.length > 0) {
      mappedAddress = parts.join(', ');
      FB_ADDRESS_FIELDS.forEach(f => { if (fields[f]) usedFields.add(f); });
    }
  }

  const name = mappedName
    || fields['full_name']
    || fields['name']
    || [fields['first_name'], fields['last_name']].filter(Boolean).join(' ')
    || 'Unknown Lead';
  const email = mappedEmail || fields['email'] || '';
  const phone = mappedPhone || fields['phone_number'] || fields['phone'] || '';
  const adName = leadResource.ad_name || '';

  // Build "extra fields" notes from anything that wasn't already mapped/consumed.
  const coreFieldNames = ['full_name', 'name', 'first_name', 'last_name', 'email', 'phone_number', 'phone', ...FB_ADDRESS_FIELDS];
  const extraFields: string[] = [];
  for (const [fieldName, value] of Object.entries(fields)) {
    if (coreFieldNames.includes(fieldName) || usedFields.has(fieldName)) continue;
    if (value) extraFields.push(`${fieldName}: ${value}`);
  }
  if (mappedNotes) extraFields.unshift(mappedNotes);

  const emails = email ? [email] : [];
  const phones = phone ? [normalizePhoneForStorage(phone)].filter(Boolean) as string[] : [];

  let message = adName ? `Facebook Lead Ad: ${adName}` : 'Facebook Lead Ad';
  if (extraFields.length > 0) message += '\n\n' + extraFields.join('\n');

  const result = await ingestLead(contractorId, {
    name,
    emails,
    phones,
    address: mappedAddress || undefined,
    street: fbStreet,
    city: fbCity,
    state: fbState,
    zip: fbZip,
    source: 'facebook',
    message,
    rawPayload: JSON.stringify({ ...leadResource, _fb_form_name: formName || undefined }),
    utmSource: 'facebook',
    utmMedium: 'lead_ads',
    utmCampaign: adName || undefined,
    tags: formTags.length > 0 ? formTags : undefined,
    skipDuplicateLeadWithinHours: opts.skipDuplicateLeadWithinHours ?? 24,
    skipAutoAssign: false,
    ipAddress: opts.ipAddress,
    consentMetadata: {
      formId: leadResource.form_id,
      adId: leadResource.ad_id,
      adName: leadResource.ad_name,
      leadgenId,
    },
  });

  if (!result.skippedDuplicateLead) {
    void facebookService.sendConversionEvent(contractorId, result.lead, result.contact, 'Lead');
  }

  log.info(
    `[${source}] ${result.skippedDuplicateLead ? 'Deduplicated' : 'Created'} Facebook lead ${leadgenId} ` +
    `for contractor ${contractorId}, contact ${result.contact.id}`
  );

  return { leadgenId, result };
}

/**
 * Poll Facebook for leads created since `last_poll_at` (or the last hour if not
 * yet set) and ingest them. Called every 5 minutes by the sync scheduler when
 * the `facebook-leads` integration is enabled.
 *
 * Token errors are logged as warnings — they do NOT throw. This prevents a
 * tenant with a stale token from triggering scheduler-wide retry backoff for
 * all other tenants.
 */
export async function syncFacebookLeads(tenantId: string): Promise<void> {
  const [pageId, pageAccessToken, userAccessToken, lastPollAtStr, fieldMappingsStr, formTagRulesStr] = await Promise.all([
    CredentialService.getCredential(tenantId, 'facebook-leads', 'page_id'),
    CredentialService.getCredential(tenantId, 'facebook-leads', 'page_access_token'),
    CredentialService.getCredential(tenantId, 'facebook-leads', 'user_access_token'),
    CredentialService.getCredential(tenantId, 'facebook-leads', 'last_poll_at'),
    CredentialService.getCredential(tenantId, 'facebook-leads', 'field_mappings'),
    CredentialService.getCredential(tenantId, 'facebook-leads', 'form_tag_rules'),
  ]);

  if (!pageId || !pageAccessToken) {
    log.info(`[poll] Skipping contractor ${tenantId} — Facebook not connected (no page_id/page_access_token)`);
    return;
  }

  // Parse pre-loaded settings once so we don't re-read per lead.
  let fieldMappings: Record<string, string> = {};
  if (fieldMappingsStr) {
    try { fieldMappings = JSON.parse(fieldMappingsStr); } catch (err) { log.error('Failed to parse field_mappings:', err); }
  }
  let formTagRules: Record<string, string[]> = {};
  if (formTagRulesStr) {
    try { formTagRules = JSON.parse(formTagRulesStr); } catch (err) { log.error('Failed to parse form_tag_rules:', err); }
  }

  const pollStartedAt = new Date();
  const lastPollMs = lastPollAtStr ? Date.parse(lastPollAtStr) : NaN;
  const sinceMs = Number.isFinite(lastPollMs)
    ? lastPollMs - POLL_OVERLAP_MS
    : Date.now() - DEFAULT_LOOKBACK_MS;
  const sinceUnix = Math.floor(sinceMs / 1000);

  log.info(`[poll] contractor=${tenantId} page=${pageId} since=${new Date(sinceMs).toISOString()}`);

  // Fetch the list of lead forms — try page token first, fall back to user token on 403.
  const fetchForms = async (token: string) =>
    axios.get(`https://graph.facebook.com/${FB_API_VERSION}/${pageId}/leadgen_forms`, {
      params: { fields: 'id,name', access_token: token, limit: 100 },
      timeout: 10000,
    });

  let formsRes: any;
  let effectiveToken = pageAccessToken;
  try {
    formsRes = await fetchForms(pageAccessToken);
  } catch (err: any) {
    if (err?.response?.status === 403 && userAccessToken) {
      try {
        formsRes = await fetchForms(userAccessToken);
        effectiveToken = userAccessToken;
      } catch (fallbackErr: any) {
        const fbMsg = fallbackErr?.response?.data?.error?.message || fallbackErr?.message || String(fallbackErr);
        log.warn(`[poll] contractor=${tenantId} could not fetch lead forms (page+user token failed): ${fbMsg}`);
        return;
      }
    } else {
      const fbMsg = err?.response?.data?.error?.message || err?.message || String(err);
      log.warn(`[poll] contractor=${tenantId} could not fetch lead forms: ${fbMsg}`);
      return;
    }
  }

  const forms: Array<{ id: string; name: string }> = formsRes.data?.data ?? [];
  if (forms.length === 0) {
    log.info(`[poll] contractor=${tenantId} has no lead forms — nothing to poll`);
    await CredentialService.setCredential(tenantId, 'facebook-leads', 'last_poll_at', pollStartedAt.toISOString());
    return;
  }

  let processed = 0;
  let skipped = 0;
  let errors = 0;

  for (const form of forms) {
    let after: string | undefined = undefined;
    let hasMore = true;

    while (hasMore) {
      let leadsRes: any;
      try {
        leadsRes = await axios.get(`https://graph.facebook.com/${FB_API_VERSION}/${form.id}/leads`, {
          params: {
            fields: 'field_data,ad_id,ad_name,form_id,created_time',
            access_token: effectiveToken,
            limit: 100,
            after: after || undefined,
            filtering: JSON.stringify([
              { field: 'time_created', operator: 'GREATER_THAN', value: sinceUnix },
            ]),
          },
          timeout: 15000,
        });
      } catch (err: any) {
        const fbMsg = err?.response?.data?.error?.message || err?.message || String(err);
        log.warn(`[poll] contractor=${tenantId} form=${form.id} could not fetch leads: ${fbMsg}`);
        errors++;
        break;
      }

      const leads: FacebookLeadResource[] = leadsRes.data?.data ?? [];

      for (const leadData of leads) {
        try {
          const { result } = await processFacebookLead({
            contractorId: tenantId,
            leadResource: leadData,
            source: 'poll',
            formName: form.name,
            fieldMappings,
            formTagRules,
          });
          if (result.skippedDuplicateLead) skipped++;
          else processed++;
        } catch (err: any) {
          errors++;
          log.error(`[poll] contractor=${tenantId} failed to process lead ${leadData.id}:`, err?.message || err);
        }
      }

      const nextCursor = leadsRes.data?.paging?.cursors?.after;
      const hasNextPage = !!leadsRes.data?.paging?.next;
      if (hasNextPage && nextCursor) {
        after = nextCursor;
      } else {
        hasMore = false;
      }
    }
  }

  // Only advance last_poll_at if we successfully fetched (no fatal errors) so a
  // partial failure window doesn't get permanently skipped on the next poll.
  if (errors === 0) {
    await CredentialService.setCredential(tenantId, 'facebook-leads', 'last_poll_at', pollStartedAt.toISOString());
  }

  log.info(
    `[poll] contractor=${tenantId} done — processed=${processed} skipped=${skipped} errors=${errors} ` +
    `forms=${forms.length} nextPollWillStartFrom=${errors === 0 ? pollStartedAt.toISOString() : 'unchanged'}`
  );
}

/**
 * Find all contractors that currently have the facebook-leads integration enabled.
 * Used by the sync scheduler at startup to restore polling schedules for
 * pre-existing connections.
 */
export async function getContractorsWithFacebookEnabled(): Promise<string[]> {
  // Lazy import to avoid a circular dependency between sync-scheduler and this module.
  const { db } = await import('../db');
  const { contractorIntegrations } = await import('@shared/schema');
  const { and, eq } = await import('drizzle-orm');

  const rows = await db
    .select({ contractorId: contractorIntegrations.contractorId })
    .from(contractorIntegrations)
    .where(
      and(
        eq(contractorIntegrations.integrationName, 'facebook-leads'),
        eq(contractorIntegrations.isEnabled, true),
      )
    );

  return rows.map(r => r.contractorId);
}
