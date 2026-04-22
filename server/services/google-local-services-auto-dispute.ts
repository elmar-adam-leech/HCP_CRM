/**
 * Auto-dispute newly-ingested Google Local Services leads when they match
 * a contractor-defined rule (e.g. "ZIP outside service area" → WRONG_GEO).
 *
 * Loaded once per sync cycle (loadAutoDisputeRules) and evaluated against
 * every newly-created lead. On a match we file the dispute via the existing
 * GLS client and stamp the same `_gls_dispute_*` markers the manual dispute
 * route uses, so the lead detail UI shows "Dispute submitted" without any
 * UI-level branching for auto vs. manual disputes.
 *
 * Failure handling mirrors the manual dispute route:
 *   - Google 4xx / 5xx errors are caught and recorded as `_gls_dispute_status:
 *     'failed'` so the contractor sees Google's reason on the lead.
 *   - The poller never throws on auto-dispute failure — one bad lead must
 *     not stop the rest of the sync.
 */
import { CredentialService } from '../credential-service';
import { storage } from '../storage';
import { logger } from '../utils/logger';
import { resolveGlsCredentials } from './google-local-services-credentials';
import { googleLocalServicesClient, type GlsDetailedLead } from './google-local-services-client';
import {
  glsAutoDisputeRulesSchema,
  type GlsAutoDisputeRule,
} from '@shared/google-local-services-rules';

const log = logger('GlsAutoDispute');

export const GLS_AUTO_DISPUTE_RULES_KEY = 'auto_dispute_rules';

/**
 * Load and parse the per-tenant auto-dispute rules. Returns [] when the
 * stored blob is missing, empty, or fails Zod validation (defensive — we'd
 * rather skip auto-dispute than file the wrong dispute on bad config).
 */
export async function loadAutoDisputeRules(
  tenantId: string,
  service: string,
): Promise<GlsAutoDisputeRule[]> {
  const raw = await CredentialService.getCredential(tenantId, service, GLS_AUTO_DISPUTE_RULES_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    const result = glsAutoDisputeRulesSchema.safeParse(parsed);
    if (!result.success) {
      log.warn(`[load] contractor=${tenantId} stored auto-dispute rules failed validation — ignoring all rules: ${result.error.message}`);
      return [];
    }
    return result.data;
  } catch (err: any) {
    log.warn(`[load] contractor=${tenantId} could not parse auto-dispute rules: ${err?.message || err}`);
    return [];
  }
}

/**
 * Pull the comparable strings out of a GLS lead, mirroring the same precedence
 * `mapGlsLead` uses (booking → message → phone) so what the contractor sees
 * in the CRM matches what the rule evaluates against.
 */
function extractLeadFields(glsLead: GlsDetailedLead): {
  zip: string;
  jobType: string;
  message: string;
  leadType: string;
} {
  const zip = (glsLead.bookingLead as any)?.postalCode
    || glsLead.messageLead?.postalCode
    || glsLead.geo
    || '';
  const jobType = glsLead.bookingLead?.jobType
    || glsLead.messageLead?.jobType
    || glsLead.leadCategory
    || '';
  const message = glsLead.messageLead?.message || '';
  const leadType = glsLead.leadType || '';
  return {
    zip: String(zip).trim(),
    jobType: String(jobType).trim(),
    message: String(message),
    leadType: String(leadType).trim(),
  };
}

/**
 * Find the first enabled rule that matches the lead. Rule order is the
 * persistence order — contractors can re-order in the UI to control
 * precedence (e.g. "spam keyword" before "service-area allowlist").
 */
export function findMatchingRule(
  rules: GlsAutoDisputeRule[],
  glsLead: GlsDetailedLead,
): GlsAutoDisputeRule | null {
  const fields = extractLeadFields(glsLead);
  for (const rule of rules) {
    if (!rule.enabled) continue;
    const values = rule.values.map(v => v.trim()).filter(Boolean);
    if (values.length === 0) continue;
    switch (rule.conditionType) {
      case 'zip_in':
        if (fields.zip && values.some(v => v.toLowerCase() === fields.zip.toLowerCase())) {
          return rule;
        }
        break;
      case 'zip_not_in':
        // Service-area allowlist: dispute if we *do* have a zip and it isn't
        // on the allowlist. Skip when no zip was provided rather than
        // disputing every PHONE_CALL lead (which often has no zip).
        if (fields.zip && !values.some(v => v.toLowerCase() === fields.zip.toLowerCase())) {
          return rule;
        }
        break;
      case 'job_type_in':
        if (fields.jobType && values.some(v => v.toLowerCase() === fields.jobType.toLowerCase())) {
          return rule;
        }
        break;
      case 'message_contains': {
        if (!fields.message) break;
        const msg = fields.message.toLowerCase();
        if (values.some(v => msg.includes(v.toLowerCase()))) {
          return rule;
        }
        break;
      }
      case 'lead_type_in':
        if (fields.leadType && values.some(v => v.toLowerCase() === fields.leadType.toLowerCase())) {
          return rule;
        }
        break;
    }
  }
  return null;
}

/**
 * Try to auto-dispute a freshly-ingested CRM lead. Safe to call from inside
 * the poller — never throws.
 *
 * @param tenantId       Contractor whose rules + credentials apply
 * @param service        GLS_SERVICE constant ('google-local-services')
 * @param crmLeadId      The CRM lead row id we just created
 * @param glsLead        The GLS payload that drove the ingestion
 * @param rules          Pre-loaded rule list (loadAutoDisputeRules)
 */
export async function maybeAutoDisputeLead(opts: {
  tenantId: string;
  service: string;
  crmLeadId: string;
  glsLead: GlsDetailedLead;
  rules: GlsAutoDisputeRule[];
}): Promise<{ disputed: boolean; ruleId?: string; status?: 'submitted' | 'already_disputed' | 'failed' }> {
  const { tenantId, service, crmLeadId, glsLead, rules } = opts;
  if (rules.length === 0) return { disputed: false };

  const rule = findMatchingRule(rules, glsLead);
  if (!rule) return { disputed: false };

  // Re-load the lead so we can merge our markers with whatever the ingestion
  // pipeline (or another concurrent update) just wrote.
  const lead = await storage.getLead(crmLeadId, tenantId);
  if (!lead) {
    log.warn(`[auto] contractor=${tenantId} lead=${crmLeadId} disappeared before auto-dispute`);
    return { disputed: false };
  }

  let parsedPayload: Record<string, unknown> = {};
  try { parsedPayload = JSON.parse(lead.rawPayload ?? '{}'); } catch { /* ignore */ }

  const [refreshToken, accountIdCred] = await Promise.all([
    CredentialService.getCredential(tenantId, service, 'refresh_token'),
    CredentialService.getCredential(tenantId, service, 'account_id'),
  ]);
  const accountId = (parsedPayload.accountId as string | undefined)
    || (parsedPayload.account_id as string | undefined)
    || accountIdCred
    || glsLead.accountId
    || '';
  if (!refreshToken || !accountId) {
    log.warn(`[auto] contractor=${tenantId} lead=${crmLeadId} matched rule ${rule.id} but Google is not connected — skipping`);
    return { disputed: false };
  }

  const creds = await resolveGlsCredentials(tenantId);
  if (!creds.configured) {
    log.warn(`[auto] contractor=${tenantId} lead=${crmLeadId} matched rule ${rule.id} but credentials are not configured — skipping`);
    return { disputed: false };
  }

  const nowIso = new Date().toISOString();
  try {
    const outcome = await googleLocalServicesClient.disputeLead({
      creds,
      refreshToken,
      accountId,
      leadId: glsLead.leadId,
      reason: rule.reason,
      notes: rule.notes,
    });
    const updatedPayload = JSON.stringify({
      ...parsedPayload,
      _gls_dispute_status: 'submitted',
      _gls_dispute_reason: rule.reason,
      _gls_dispute_notes: rule.notes ?? null,
      _gls_dispute_submitted_at: nowIso,
      _gls_dispute_response: outcome.response,
      _gls_dispute_error: null,
      _gls_dispute_error_status: null,
      _gls_auto_disputed: true,
      _gls_auto_dispute_rule_id: rule.id,
      disputeStatus: 'DISPUTED',
    });
    await storage.updateLead(lead.id, { rawPayload: updatedPayload }, tenantId);
    log.info(`[auto] contractor=${tenantId} lead=${lead.id} gls=${glsLead.leadId} rule=${rule.id} reason=${rule.reason} → ${outcome.status}`);
    return { disputed: true, ruleId: rule.id, status: outcome.status };
  } catch (err: any) {
    const status = err?.response?.status;
    const apiMsg =
      err?.response?.data?.error?.message ||
      (typeof err?.response?.data === 'string' ? err.response.data : undefined) ||
      err?.message || 'Unknown error';
    log.warn(`[auto] contractor=${tenantId} lead=${lead.id} gls=${glsLead.leadId} rule=${rule.id} dispute failed (status=${status ?? 'n/a'}): ${apiMsg}`);
    const failedPayload = JSON.stringify({
      ...parsedPayload,
      _gls_dispute_status: 'failed',
      _gls_dispute_reason: rule.reason,
      _gls_dispute_notes: rule.notes ?? null,
      _gls_dispute_attempted_at: nowIso,
      _gls_dispute_error: apiMsg,
      _gls_dispute_error_status: status ?? null,
      _gls_auto_disputed: true,
      _gls_auto_dispute_rule_id: rule.id,
    });
    try {
      await storage.updateLead(lead.id, { rawPayload: failedPayload }, tenantId);
    } catch (writeErr: any) {
      log.error(`[auto] contractor=${tenantId} lead=${lead.id} could not record dispute failure: ${writeErr?.message || writeErr}`);
    }
    return { disputed: true, ruleId: rule.id, status: 'failed' };
  }
}
