/**
 * Google Local Services (GLS) lead sync.
 *
 * Why this exists:
 *   GLS does not provide real-time webhooks. We poll the GLS detailed-leads
 *   report every ~5 minutes per connected contractor, ingest new leads through
 *   the shared `ingestLead` pipeline, and update the status of previously
 *   ingested leads (e.g. charge disputed → rejected).
 *
 * Per-contractor cursor:
 *   `last_poll_at` (ISO timestamp) stored under service `google-local-services`.
 *   We poll a window of [last_poll_at - 1 hour, now]. The 1h overlap re-checks
 *   recent leads so we can pick up status changes (charge_status / dispute_status)
 *   that happen after a lead was first ingested.
 *
 * Deduplication:
 *   ingestLead's contact-level dedup window (24h) prevents duplicate contacts.
 *   On top of that we look up the existing CRM lead by Google `leadId`
 *   (embedded in `rawPayload`) so re-ingestion of the same Google lead either
 *   updates the existing row in place (status change) or is skipped (no change).
 */
import { CredentialService } from '../credential-service';
import { ingestLead } from '../services/lead-ingestion';
import { googleLocalServicesClient, type GlsDetailedLead } from '../services/google-local-services-client';
import { resolveGlsCredentials } from '../services/google-local-services-credentials';
import { logger } from '../utils/logger';
import { normalizePhoneForStorage } from '../utils/phone-normalizer';
import { db } from '../db';
import { leads, type InsertLead } from '@shared/schema';
import { and, eq } from 'drizzle-orm';
import { storage } from '../storage';
import {
  loadAutoDisputeRules,
  maybeAutoDisputeLead,
} from '../services/google-local-services-auto-dispute';
import type { GlsAutoDisputeRule } from '@shared/google-local-services-rules';

const log = logger('GoogleLocalServicesSync');

export const GLS_SOURCE = 'google_local_services';
export const GLS_SERVICE = 'google-local-services';

// Default look-back when no last_poll_at is recorded.
const DEFAULT_LOOKBACK_DAYS = 7;
// Status-update window: every poll re-checks the trailing N days of leads so
// that lifecycle changes that happen days after a lead was first ingested
// (most importantly DISPUTE_APPROVED and booking confirmations — both of
// which Google can issue weeks later) flow back into the CRM. A 60-day
// trailing window matches Google's typical dispute resolution timeline.
const STATUS_RECHECK_WINDOW_DAYS = 60;

interface ProcessedSummary {
  created: number;
  updated: number;
  skipped: number;
  errors: number;
}

/**
 * Map a GLS detailed lead to consolidated CRM fields (name/email/phone/address/message).
 */
function mapGlsLead(lead: GlsDetailedLead): {
  name: string;
  email: string | null;
  phone: string | null;
  zip: string | null;
  message: string;
  jobType: string | null;
} {
  let name = '';
  let phone = '';
  let email = '';
  let zip = lead.geo ?? '';
  let jobType = lead.leadCategory ?? '';
  const messageLines: string[] = [];

  if (lead.messageLead) {
    name = lead.messageLead.customerName || name;
    phone = lead.messageLead.consumerPhoneNumber || phone;
    zip = lead.messageLead.postalCode || zip;
    jobType = lead.messageLead.jobType || jobType;
    if (lead.messageLead.message) messageLines.push(lead.messageLead.message);
  }
  if (lead.phoneLead) {
    phone = lead.phoneLead.consumerPhoneNumber || phone;
    if (lead.phoneLead.chargedConnectedCallDurationSeconds) {
      messageLines.push(`Call duration: ${lead.phoneLead.chargedConnectedCallDurationSeconds}s`);
    }
  }
  if (lead.bookingLead) {
    name = lead.bookingLead.customerName || name;
    phone = lead.bookingLead.consumerPhoneNumber || phone;
    email = lead.bookingLead.customerEmail || email;
    jobType = lead.bookingLead.jobType || jobType;
    if (lead.bookingLead.bookingAppointmentTimestamp) {
      messageLines.push(`Booking: ${lead.bookingLead.bookingAppointmentTimestamp}`);
    }
  }

  if (!name) name = phone || `Google Local Services Lead ${lead.leadId}`;

  const header = `Google Local Services ${lead.leadType.toLowerCase().replace('_', ' ')} lead`
    + (jobType ? ` — ${jobType}` : '');
  const message = [header, ...messageLines].filter(Boolean).join('\n');

  return {
    name,
    email: email || null,
    phone: phone || null,
    zip: zip || null,
    message,
    jobType: jobType || null,
  };
}

/**
 * Look up an existing CRM lead for this contractor that was ingested from a
 * specific Google leadId. Backed by the partial unique index
 * `leads_google_lead_id_unique_idx` on (contractor_id, google_lead_id) — an
 * O(1) index hit per poll iteration even for tenants with thousands of GLS
 * leads (task #490). The previous implementation LIKE-scanned `rawPayload`,
 * which degraded linearly with lead volume.
 */
async function findLeadByGoogleId(contractorId: string, googleLeadId: string) {
  const rows = await db
    .select()
    .from(leads)
    .where(and(
      eq(leads.contractorId, contractorId),
      eq(leads.googleLeadId, googleLeadId),
    ))
    .limit(1);
  return rows[0];
}

/**
 * Translate GLS charge / dispute state into the closest CRM lead status.
 *  - DISPUTE_APPROVED → disqualified  (Google credited the lead back)
 *  - BOOKING / booked → qualified
 *  - everything else  → leave status alone (caller workflow decides)
 */
function inferStatusFromGls(lead: GlsDetailedLead): 'new' | 'qualified' | 'disqualified' | null {
  if (lead.disputeStatus === 'DISPUTE_APPROVED') return 'disqualified';
  if (lead.leadType === 'BOOKING' && lead.bookingLead?.bookingAppointmentTimestamp) return 'qualified';
  return null;
}

/**
 * Process a single GLS lead — either ingest it (new) or update the matching
 * CRM lead in place (status changed in Google).
 */
export async function processGlsLead(
  contractorId: string,
  glsLead: GlsDetailedLead,
  autoDisputeRules: GlsAutoDisputeRule[] = [],
): Promise<'created' | 'updated' | 'skipped'> {
  const existing = await findLeadByGoogleId(contractorId, glsLead.leadId);

  // Preserve internal `_gls_dispute_*` markers across re-ingestion. The
  // poller overwrites the lead's rawPayload with Google's latest state on
  // every cycle; without this merge we'd lose any dispute submission this
  // CRM made between polls.
  let preservedMarkers: Record<string, unknown> = {};
  if (existing?.rawPayload) {
    try {
      const prev = JSON.parse(existing.rawPayload);
      for (const k of Object.keys(prev)) {
        if (k.startsWith('_gls_dispute_')) preservedMarkers[k] = prev[k];
      }
    } catch { /* ignore corrupt payload */ }
  }

  // Mirror Google's authoritative dispute outcome onto our internal status
  // marker so the UI reflects approval/rejection without us having to add a
  // dedicated column. (Google's poller is the source of truth here.)
  if (glsLead.disputeStatus === 'DISPUTE_APPROVED') {
    preservedMarkers._gls_dispute_status = 'approved';
  } else if (glsLead.disputeStatus === 'DISPUTE_REJECTED') {
    preservedMarkers._gls_dispute_status = 'rejected';
  } else if (glsLead.disputeStatus === 'DISPUTED' && !preservedMarkers._gls_dispute_status) {
    // Lead was disputed directly in the GLS dashboard (not via this CRM) —
    // record it so the UI shows "Submitted" instead of a dispute button.
    preservedMarkers._gls_dispute_status = 'submitted';
  }

  // Embed the Google leadId so future polls can locate this CRM lead.
  const payload = JSON.stringify({
    ...glsLead.raw,
    ...preservedMarkers,
    _gls_lead_id: glsLead.leadId,
    _gls_lead_type: glsLead.leadType,
  });

  if (existing) {
    const inferredStatus = inferStatusFromGls(glsLead);
    const statusChanged = !!inferredStatus && existing.status !== inferredStatus;
    const payloadChanged = (existing.rawPayload ?? '') !== payload;
    // Backfill the indexed column on the fly for rows ingested before
    // task #490 promoted google_lead_id to a first-class column.
    const googleIdMissing = existing.googleLeadId !== glsLead.leadId;

    // Skip the write entirely when nothing material changed. This is critical
    // because the trailing 60-day status-recheck window touches every recent
    // lead on every poll — without change-detection that would generate
    // pointless DB writes and updatedAt churn for every active tenant.
    if (!statusChanged && !payloadChanged && !googleIdMissing) {
      return 'skipped';
    }

    const updates: Partial<InsertLead> = {};
    if (payloadChanged) updates.rawPayload = payload;
    if (statusChanged) updates.status = inferredStatus!;
    if (googleIdMissing) updates.googleLeadId = glsLead.leadId;

    await storage.updateLead(existing.id, updates, contractorId);
    log.info(`[gls] Updated existing CRM lead ${existing.id} from Google leadId=${glsLead.leadId} (status=${statusChanged ? inferredStatus : 'unchanged'}, payload=${payloadChanged ? 'changed' : 'unchanged'})`);
    return 'updated';
  }

  const mapped = mapGlsLead(glsLead);
  const normalizedPhone = mapped.phone ? normalizePhoneForStorage(mapped.phone) : '';

  const ingestResult = await ingestLead(contractorId, {
    name: mapped.name,
    emails: mapped.email ? [mapped.email] : [],
    phones: normalizedPhone ? [normalizedPhone] : [],
    zip: mapped.zip || undefined,
    source: GLS_SOURCE,
    message: mapped.message,
    rawPayload: payload,
    utmSource: 'google',
    utmMedium: 'local_services',
    utmCampaign: mapped.jobType || undefined,
    skipDuplicateLeadWithinHours: 24,
    consentMetadata: {
      glsLeadId: glsLead.leadId,
      glsAccountId: glsLead.accountId,
      glsLeadType: glsLead.leadType,
    },
  });

  if (ingestResult.skippedDuplicateLead) return 'skipped';

  // Stamp the indexed Google leadId on the freshly ingested lead so the next
  // poll's findLeadByGoogleId hits the partial unique index instead of a
  // sequential scan (task #490).
  await storage.updateLead(ingestResult.lead.id, { googleLeadId: glsLead.leadId }, contractorId);

  // Auto-dispute step (task #532). Runs only on freshly created leads so
  // disputes never fire twice for the same Google lead, even when the
  // status-recheck window re-touches the lead on later polls.
  if (autoDisputeRules.length > 0) {
    try {
      await maybeAutoDisputeLead({
        tenantId: contractorId,
        service: GLS_SERVICE,
        crmLeadId: ingestResult.lead.id,
        glsLead,
        rules: autoDisputeRules,
      });
    } catch (err: any) {
      // Defense-in-depth: maybeAutoDisputeLead already swallows its own
      // errors, but a thrown anything here must not break the poller.
      log.warn(`[auto] contractor=${contractorId} lead=${ingestResult.lead.id} unexpected auto-dispute failure: ${err?.message || err}`);
    }
  }

  return 'created';
}

/**
 * Poll Google Local Services for new + updated leads since `last_poll_at`.
 * Token errors are logged as warnings — they do NOT throw, so a single tenant
 * with bad credentials cannot trigger scheduler-wide retry backoff.
 */
export async function syncGoogleLocalServicesLeads(tenantId: string): Promise<void> {
  const [refreshToken, accountId, lastPollAtStr] = await Promise.all([
    CredentialService.getCredential(tenantId, GLS_SERVICE, 'refresh_token'),
    CredentialService.getCredential(tenantId, GLS_SERVICE, 'account_id'),
    CredentialService.getCredential(tenantId, GLS_SERVICE, 'last_poll_at'),
  ]);

  if (!refreshToken || !accountId) {
    log.info(`[poll] Skipping contractor ${tenantId} — Google Local Services not connected (no refresh_token/account_id)`);
    return;
  }

  const creds = await resolveGlsCredentials(tenantId);
  if (!creds.configured) {
    const msg = 'Google Local Services credentials are not configured (missing OAuth client or developer token)';
    log.warn(`[poll] contractor=${tenantId} ${msg}`);
    await CredentialService.setCredential(tenantId, GLS_SERVICE, 'last_error', msg);
    await CredentialService.setCredential(tenantId, GLS_SERVICE, 'last_error_at', new Date().toISOString());
    return;
  }

  const pollStartedAt = new Date();
  const lastPollMs = lastPollAtStr ? Date.parse(lastPollAtStr) : NaN;

  // Two-window strategy mirrors how Facebook + GLS lifecycles actually work:
  //   - The "new lead" window is small (since last_poll_at) — fast, cheap, low
  //     latency for fresh leads.
  //   - The "status recheck" window is wide (last STATUS_RECHECK_WINDOW_DAYS)
  //     so dispute outcomes / booked-after-the-fact transitions land in the
  //     CRM even when they happen days after the original lead was ingested.
  // Both windows funnel through processGlsLead → findLeadByGoogleId, which
  // updates an existing CRM lead in place rather than re-creating it, so it's
  // safe to overlap them aggressively.
  const recheckSinceMs = Date.now() - STATUS_RECHECK_WINDOW_DAYS * 24 * 60 * 60_000;
  const newLeadSinceMs = Number.isFinite(lastPollMs)
    ? lastPollMs
    : Date.now() - DEFAULT_LOOKBACK_DAYS * 24 * 60 * 60_000;
  // Always at least the trailing recheck window — never narrower.
  const startMs = Math.min(recheckSinceMs, newLeadSinceMs);
  const startDate = new Date(startMs);

  log.info(`[poll] contractor=${tenantId} account=${accountId} since=${startDate.toISOString()} (recheck window=${STATUS_RECHECK_WINDOW_DAYS}d)`);

  let detailedLeads: GlsDetailedLead[];
  try {
    detailedLeads = await googleLocalServicesClient.fetchDetailedLeads({
      creds,
      refreshToken,
      accountId,
      startDate,
      endDate: pollStartedAt,
    });
  } catch (err: any) {
    const status = err?.response?.status;
    const msg = err?.response?.data?.error?.message || err?.message || String(err);
    log.warn(`[poll] contractor=${tenantId} could not fetch GLS leads (status=${status ?? 'n/a'}): ${msg}`);
    await CredentialService.setCredential(tenantId, GLS_SERVICE, 'last_error', msg);
    await CredentialService.setCredential(tenantId, GLS_SERVICE, 'last_error_at', new Date().toISOString());
    return;
  }

  // Auto-dispute rules are loaded once per poll and passed into every
  // processGlsLead call. Rules are tiny (≤ 50 entries), reads are encrypted
  // single-row credential lookups, and a per-lead reload would multiply the
  // round-trips for high-volume tenants.
  const autoDisputeRules = await loadAutoDisputeRules(tenantId, GLS_SERVICE);

  const summary: ProcessedSummary = { created: 0, updated: 0, skipped: 0, errors: 0 };
  for (const lead of detailedLeads) {
    try {
      const outcome = await processGlsLead(tenantId, lead, autoDisputeRules);
      summary[outcome]++;
    } catch (err: any) {
      summary.errors++;
      log.error(`[poll] contractor=${tenantId} failed to process lead ${lead.leadId}:`, err?.message || err);
    }
  }

  // Only advance the cursor on a fully successful poll so a transient blip
  // doesn't leave a window permanently unprocessed.
  if (summary.errors === 0) {
    await CredentialService.setCredential(tenantId, GLS_SERVICE, 'last_poll_at', pollStartedAt.toISOString());
    await CredentialService.setCredential(tenantId, GLS_SERVICE, 'last_success_at', pollStartedAt.toISOString());
    await CredentialService.setCredential(tenantId, GLS_SERVICE, 'last_error', '');
  }

  log.info(
    `[poll] contractor=${tenantId} done — created=${summary.created} updated=${summary.updated} ` +
    `skipped=${summary.skipped} errors=${summary.errors} fetched=${detailedLeads.length}`
  );
}

/**
 * Used by the sync scheduler at startup to restore polling schedules for
 * pre-existing connections.
 */
export async function getContractorsWithGoogleLocalServicesEnabled(): Promise<string[]> {
  const { contractorIntegrations } = await import('@shared/schema');
  const rows = await db
    .select({ contractorId: contractorIntegrations.contractorId })
    .from(contractorIntegrations)
    .where(and(
      eq(contractorIntegrations.integrationName, GLS_SERVICE),
      eq(contractorIntegrations.isEnabled, true),
    ));
  return rows.map(r => r.contractorId);
}
