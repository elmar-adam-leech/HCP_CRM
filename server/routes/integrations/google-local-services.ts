/**
 * Google Local Services (GLS) integration routes.
 *
 * Mirrors the Facebook integration's connect/callback/disconnect/status pattern:
 *   - GET  /api/integrations/google-local-services/connect      → returns Google authUrl
 *   - GET  /api/integrations/google-local-services/callback     → exchanges code, lists accounts
 *   - GET  /api/integrations/google-local-services/accounts     → lists accounts after consent
 *   - POST /api/integrations/google-local-services/select-account → persist chosen account
 *   - POST /api/integrations/google-local-services/disconnect   → revoke + clear creds
 *   - POST /api/integrations/google-local-services/sync-now     → manual poll trigger
 *   - GET  /api/integrations/google-local-services/status       → connection + last poll info
 *   - GET  /api/integrations/google-local-services/credentials  → which per-tenant creds are set
 *   - PUT  /api/integrations/google-local-services/credentials  → upsert per-tenant creds
 *
 * Per-tenant credentials override the platform-level env vars
 * (GOOGLE_LOCAL_SERVICES_CLIENT_ID/SECRET/DEVELOPER_TOKEN). See
 * `services/google-local-services-credentials.ts` for resolution rules.
 *
 * Required env vars (only when no per-tenant credentials are set):
 *   GOOGLE_LOCAL_SERVICES_CLIENT_ID
 *   GOOGLE_LOCAL_SERVICES_CLIENT_SECRET
 *   GOOGLE_LOCAL_SERVICES_DEVELOPER_TOKEN
 *   JWT_SECRET (for signed OAuth state — same as Facebook integration)
 */
import type { Express, Request, Response, RequestHandler } from 'express';
import crypto from 'crypto';
import { type AuthedRequest } from '../../auth-service';
import { CredentialService } from '../../credential-service';
import { asyncHandler } from '../../utils/async-handler';
import { logger } from '../../utils/logger';
import { storage } from '../../storage';
import { syncScheduler } from '../../sync-scheduler';
import { googleLocalServicesClient, GLS_DISPUTE_REASONS } from '../../services/google-local-services-client';
import {
  resolveGlsCredentials,
  hasAnyTenantCredentials,
  TENANT_CRED_KEYS,
} from '../../services/google-local-services-credentials';
import { syncGoogleLocalServicesLeads, GLS_SERVICE, GLS_SOURCE } from '../../sync/google-local-services-leads';
import { parseBody } from '../../utils/validate-body';
import { z } from 'zod';
import {
  glsAutoDisputeRulesSchema,
  type GlsAutoDisputeRule,
} from '@shared/google-local-services-rules';
import {
  GLS_AUTO_DISPUTE_RULES_KEY,
  loadAutoDisputeRules,
} from '../../services/google-local-services-auto-dispute';
import { db } from '../../db';
import { leads as leadsTable, contacts as contactsTable } from '@shared/schema';
import { and, eq, like, desc } from 'drizzle-orm';

const log = logger('GoogleLocalServicesIntegration');

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const SCOPE = 'https://www.googleapis.com/auth/adwords';

const requireGlsAccess: RequestHandler = (req: Request, res: Response, next) => {
  const user = (req as AuthedRequest).user;
  if (!user) { res.status(401).json({ message: 'Authentication required' }); return; }
  if (['manager', 'admin', 'super_admin'].includes(user.role) || user.canManageIntegrations) {
    next();
    return;
  }
  res.status(403).json({ message: 'You do not have permission to manage the Google Local Services integration' });
};

function getBaseUrl(req: Request): string {
  const proto = (req.get('x-forwarded-proto') || req.protocol) as string;
  const host = (req.get('x-forwarded-host') || req.get('host')) as string;
  return `${proto}://${host}`;
}

function signState(payload: object, secret: string): string {
  const json = JSON.stringify(payload);
  const sig = crypto.createHmac('sha256', secret).update(json).digest('hex');
  return Buffer.from(JSON.stringify({ ...payload, sig })).toString('base64url');
}

function verifyState(stateB64: string, secret: string): { contractorId: string; userId?: string } | null {
  try {
    const decoded = JSON.parse(Buffer.from(stateB64, 'base64url').toString());
    const { sig, ...payload } = decoded;
    const expected = crypto.createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex');
    if (!sig || !crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))) return null;
    return { contractorId: payload.contractorId, userId: payload.userId };
  } catch { return null; }
}

export function registerGoogleLocalServicesIntegrationRoutes(app: Express): void {
  app.get('/api/integrations/google-local-services/connect',
    requireGlsAccess,
    asyncHandler(async (req: AuthedRequest, res: Response) => {
      const creds = await resolveGlsCredentials(req.user.contractorId);
      if (!creds.clientId || !creds.clientSecret) {
        res.status(400).json({ message: 'Google Local Services OAuth client is not configured. Add per-tenant credentials or set GOOGLE_LOCAL_SERVICES_CLIENT_ID/SECRET.' });
        return;
      }
      const jwtSecret = process.env.JWT_SECRET;
      if (!jwtSecret) {
        res.status(500).json({ message: 'Server configuration error: JWT_SECRET is not set' });
        return;
      }
      const state = signState({ contractorId: req.user.contractorId, userId: req.user.userId }, jwtSecret);
      const callbackUrl = `${getBaseUrl(req)}/api/integrations/google-local-services/callback`;

      const params = new URLSearchParams({
        client_id: creds.clientId,
        redirect_uri: callbackUrl,
        response_type: 'code',
        scope: SCOPE,
        access_type: 'offline',
        prompt: 'consent',
        include_granted_scopes: 'true',
        state,
      });
      res.json({ authUrl: `${GOOGLE_AUTH_URL}?${params.toString()}` });
    }));

  app.get('/api/integrations/google-local-services/callback',
    asyncHandler<Request>(async (req: Request, res: Response) => {
      const { code, state, error: googleError } = req.query;
      const jwtSecret = process.env.JWT_SECRET;
      if (!jwtSecret) {
        log.error('OAuth callback: JWT_SECRET not set');
        res.redirect('/settings?tab=integrations&google_local_services=error');
        return;
      }

      const verified = verifyState(String(state || ''), jwtSecret);
      if (!verified) {
        log.error('OAuth state signature mismatch — possible CSRF');
        res.redirect('/settings?tab=integrations&google_local_services=error');
        return;
      }
      if (googleError || !code) {
        log.error('Google OAuth error:', googleError);
        res.redirect('/settings?tab=integrations&google_local_services=error');
        return;
      }

      try {
        const callbackUrl = `${getBaseUrl(req)}/api/integrations/google-local-services/callback`;
        const creds = await resolveGlsCredentials(verified.contractorId);
        const tokens = await googleLocalServicesClient.exchangeCodeForTokens(creds, String(code), callbackUrl);

        // Persist refresh token + the client_id it was issued against, so we
        // can detect later if the tenant changes their OAuth client and we
        // need to invalidate this refresh token (refresh tokens are bound to
        // the client that minted them).
        await CredentialService.setCredential(verified.contractorId, GLS_SERVICE, 'refresh_token', tokens.refreshToken);
        if (creds.clientId) {
          await CredentialService.setCredential(
            verified.contractorId, GLS_SERVICE, TENANT_CRED_KEYS.refreshTokenClientId, creds.clientId,
          );
        }
        log.info(`[callback] Stored Google refresh token for contractor ${verified.contractorId}`);

        res.redirect('/settings?tab=integrations&google_local_services=pick_account');
      } catch (err: any) {
        log.error('[callback] Token exchange failed:', err?.response?.data?.error || err?.message || err);
        res.redirect('/settings?tab=integrations&google_local_services=error&reason=token_exchange');
      }
    }));

  app.get('/api/integrations/google-local-services/accounts',
    requireGlsAccess,
    asyncHandler(async (req: AuthedRequest, res: Response) => {
      const refreshToken = await CredentialService.getCredential(req.user.contractorId, GLS_SERVICE, 'refresh_token');
      if (!refreshToken) {
        res.status(400).json({ message: 'Not connected to Google. Connect first.' });
        return;
      }
      const creds = await resolveGlsCredentials(req.user.contractorId);
      try {
        const accounts = await googleLocalServicesClient.listAccounts(creds, refreshToken);
        res.json({ accounts });
      } catch (err: any) {
        const status = err?.response?.status;
        const msg = err?.response?.data?.error?.message || err?.message || String(err);
        log.error(`[accounts] Failed to list GLS accounts (status=${status ?? 'n/a'}): ${msg}`);
        res.status(502).json({ message: `Could not list Google Local Services accounts: ${msg}` });
      }
    }));

  app.post('/api/integrations/google-local-services/select-account',
    requireGlsAccess,
    asyncHandler(async (req: AuthedRequest, res: Response) => {
      const body = parseBody(z.object({
        accountId: z.string().min(1),
        accountName: z.string().optional(),
      }), req, res);
      if (!body) return;

      const refreshToken = await CredentialService.getCredential(req.user.contractorId, GLS_SERVICE, 'refresh_token');
      if (!refreshToken) {
        res.status(400).json({ message: 'Not connected to Google. Connect first.' });
        return;
      }

      await Promise.all([
        CredentialService.setCredential(req.user.contractorId, GLS_SERVICE, 'account_id', body.accountId),
        CredentialService.setCredential(req.user.contractorId, GLS_SERVICE, 'account_name', body.accountName ?? ''),
      ]);
      await storage.enableTenantIntegration(req.user.contractorId, GLS_SERVICE, req.user.userId);

      try {
        await syncScheduler.onIntegrationEnabled(req.user.contractorId, GLS_SERVICE);
      } catch (schedErr: any) {
        log.warn(`[select-account] Failed to register sync schedule (non-fatal): ${schedErr?.message || schedErr}`);
      }

      res.json({ success: true });
    }));

  app.post('/api/integrations/google-local-services/disconnect',
    requireGlsAccess,
    asyncHandler(async (req: AuthedRequest, res: Response) => {
      const refreshToken = await CredentialService.getCredential(req.user.contractorId, GLS_SERVICE, 'refresh_token');
      if (refreshToken) {
        const issuingClientId = await CredentialService.getCredential(
          req.user.contractorId, GLS_SERVICE, TENANT_CRED_KEYS.refreshTokenClientId,
        );
        await googleLocalServicesClient.revokeRefreshToken(refreshToken, issuingClientId ?? undefined);
      }
      // Clear OAuth-state credentials but keep the per-tenant credential
      // overrides (developer token, OAuth client) — disconnecting Google does
      // NOT mean the contractor wants to wipe their MCC configuration.
      await Promise.all([
        CredentialService.disableCredential(req.user.contractorId, GLS_SERVICE, 'refresh_token'),
        CredentialService.disableCredential(req.user.contractorId, GLS_SERVICE, 'account_id'),
        CredentialService.disableCredential(req.user.contractorId, GLS_SERVICE, 'account_name'),
        CredentialService.disableCredential(req.user.contractorId, GLS_SERVICE, TENANT_CRED_KEYS.refreshTokenClientId),
      ]);
      try {
        await syncScheduler.onIntegrationDisabled(req.user.contractorId, GLS_SERVICE);
      } catch (schedErr: any) {
        log.warn(`[disconnect] Failed to remove sync schedule (non-fatal): ${schedErr?.message || schedErr}`);
      }
      // Mark integration as disabled so the UI reflects the change.
      try { await storage.disableTenantIntegration(req.user.contractorId, GLS_SERVICE); } catch { /* optional */ }
      res.json({ success: true });
    }));

  app.post('/api/integrations/google-local-services/sync-now',
    requireGlsAccess,
    asyncHandler(async (req: AuthedRequest, res: Response) => {
      try {
        await syncGoogleLocalServicesLeads(req.user.contractorId);
        res.json({ success: true });
      } catch (err: any) {
        log.error('[sync-now] Manual sync failed:', err?.message || err);
        res.status(500).json({ message: err?.message || 'Sync failed' });
      }
    }));

  app.get('/api/integrations/google-local-services/status',
    requireGlsAccess,
    asyncHandler(async (req: AuthedRequest, res: Response) => {
      const tenantId = req.user.contractorId;
      const [refreshToken, accountId, accountName, lastPollAt, lastSuccessAt, lastError, lastErrorAt, creds] = await Promise.all([
        CredentialService.getCredential(tenantId, GLS_SERVICE, 'refresh_token'),
        CredentialService.getCredential(tenantId, GLS_SERVICE, 'account_id'),
        CredentialService.getCredential(tenantId, GLS_SERVICE, 'account_name'),
        CredentialService.getCredential(tenantId, GLS_SERVICE, 'last_poll_at'),
        CredentialService.getCredential(tenantId, GLS_SERVICE, 'last_success_at'),
        CredentialService.getCredential(tenantId, GLS_SERVICE, 'last_error'),
        CredentialService.getCredential(tenantId, GLS_SERVICE, 'last_error_at'),
        resolveGlsCredentials(tenantId),
      ]);
      const enabled = await storage.isIntegrationEnabled(tenantId, GLS_SERVICE);

      res.json({
        configured: !!(creds.clientId && creds.clientSecret),
        developerTokenSet: !!creds.developerToken,
        credentialsSource: creds.source,
        oauthSource: creds.oauthSource,
        connected: !!refreshToken,
        accountSelected: !!accountId,
        enabled,
        accountId: accountId ?? null,
        accountName: accountName ?? null,
        lastPollAt: lastPollAt ?? null,
        lastSuccessAt: lastSuccessAt ?? null,
        lastError: lastError || null,
        lastErrorAt: lastErrorAt ?? null,
      });
    }));

  app.get('/api/integrations/google-local-services/credentials',
    requireGlsAccess,
    asyncHandler(async (req: AuthedRequest, res: Response) => {
      const tenantId = req.user.contractorId;
      const [tenantClientId, tenantClientSecret, tenantDevToken] = await Promise.all([
        CredentialService.getCredential(tenantId, GLS_SERVICE, TENANT_CRED_KEYS.clientId),
        CredentialService.getCredential(tenantId, GLS_SERVICE, TENANT_CRED_KEYS.clientSecret),
        CredentialService.getCredential(tenantId, GLS_SERVICE, TENANT_CRED_KEYS.developerToken),
      ]);
      const platformClientConfigured = !!(process.env.GOOGLE_LOCAL_SERVICES_CLIENT_ID && process.env.GOOGLE_LOCAL_SERVICES_CLIENT_SECRET);
      const platformDeveloperTokenSet = !!process.env.GOOGLE_LOCAL_SERVICES_DEVELOPER_TOKEN;
      res.json({
        // Never return the actual values — just whether they're set.
        tenantClientIdSet: !!tenantClientId,
        tenantClientSecretSet: !!tenantClientSecret,
        tenantDeveloperTokenSet: !!tenantDevToken,
        platformClientConfigured,
        platformDeveloperTokenSet,
      });
    }));

  /**
   * Dispute a single GLS lead with Google. Reads `_gls_lead_id` from the CRM
   * lead's rawPayload and POSTs to Google's dispute endpoint via the GLS
   * client. Persists the dispute outcome back into rawPayload so the UI can
   * show "Dispute submitted" without waiting for Google's nightly status
   * update to flow back through the poller.
   */
  app.post('/api/integrations/google-local-services/leads/:id/dispute',
    requireGlsAccess,
    asyncHandler(async (req: AuthedRequest, res: Response) => {
      const body = parseBody(z.object({
        reason: z.enum(GLS_DISPUTE_REASONS),
        notes: z.string().max(2000).optional(),
      }), req, res);
      if (!body) return;
      // GLS requires notes for OTHER so contractors explain unusual cases.
      if (body.reason === 'OTHER' && !body.notes?.trim()) {
        res.status(400).json({ message: 'Dispute notes are required when the reason is "Other".' });
        return;
      }

      const tenantId = req.user.contractorId;
      const lead = await storage.getLead(req.params.id, tenantId);
      if (!lead) {
        res.status(404).json({ message: 'Lead not found.' });
        return;
      }
      if (lead.source !== GLS_SOURCE) {
        res.status(400).json({ message: 'This lead did not come from Google Local Services and cannot be disputed.' });
        return;
      }

      let glsLeadId: string | undefined;
      let glsAccountId: string | undefined;
      let parsedPayload: Record<string, unknown> = {};
      try {
        parsedPayload = JSON.parse(lead.rawPayload ?? '{}');
        glsLeadId = parsedPayload._gls_lead_id ? String(parsedPayload._gls_lead_id) : undefined;
        glsAccountId = (parsedPayload.accountId ?? parsedPayload.account_id) as string | undefined;
      } catch {
        // fall through — handled below
      }
      if (!glsLeadId) {
        res.status(400).json({ message: 'This lead is missing its Google lead identifier and cannot be disputed.' });
        return;
      }

      const [refreshToken, accountIdCred] = await Promise.all([
        CredentialService.getCredential(tenantId, GLS_SERVICE, 'refresh_token'),
        CredentialService.getCredential(tenantId, GLS_SERVICE, 'account_id'),
      ]);
      const accountId = glsAccountId || accountIdCred;
      if (!refreshToken || !accountId) {
        res.status(400).json({ message: 'Google Local Services is not connected. Connect and select an account first.' });
        return;
      }

      const creds = await resolveGlsCredentials(tenantId);
      if (!creds.configured) {
        res.status(400).json({ message: 'Google Local Services credentials are not configured (missing OAuth client or developer token).' });
        return;
      }

      let outcome: { status: 'submitted' | 'already_disputed'; response: Record<string, unknown> };
      try {
        outcome = await googleLocalServicesClient.disputeLead({
          creds,
          refreshToken,
          accountId,
          leadId: glsLeadId,
          reason: body.reason,
          notes: body.notes,
        });
      } catch (err: any) {
        const status = err?.response?.status;
        const apiMsg =
          err?.response?.data?.error?.message ||
          (typeof err?.response?.data === 'string' ? err.response.data : undefined) ||
          err?.message || 'Unknown error';
        log.warn(`[dispute] contractor=${tenantId} lead=${lead.id} gls=${glsLeadId} failed (status=${status ?? 'n/a'}): ${apiMsg}`);

        // Record the failure in rawPayload so the UI can surface it without
        // requiring server logs. Re-trying the same dispute is safe — Google
        // dedupes on its end (see `disputeLead`'s 409 handling).
        const failedPayload = JSON.stringify({
          ...parsedPayload,
          _gls_dispute_status: 'failed',
          _gls_dispute_reason: body.reason,
          _gls_dispute_notes: body.notes ?? null,
          _gls_dispute_attempted_at: new Date().toISOString(),
          _gls_dispute_error: apiMsg,
          _gls_dispute_error_status: status ?? null,
        });
        await storage.updateLead(lead.id, { rawPayload: failedPayload }, tenantId);

        // Pass through Google's 4xx (user-actionable, e.g. "lead too old to
        // dispute") so the UI can show it accurately. 5xx / network blips
        // surface as 502 so the contractor knows it's worth retrying.
        const outStatus = typeof status === 'number' && status >= 400 && status < 500 ? status : 502;
        res.status(outStatus).json({ message: `Google rejected the dispute: ${apiMsg}` });
        return;
      }

      const nowIso = new Date().toISOString();
      const updatedPayload = JSON.stringify({
        ...parsedPayload,
        _gls_dispute_status: outcome.status === 'already_disputed' ? 'submitted' : 'submitted',
        _gls_dispute_reason: body.reason,
        _gls_dispute_notes: body.notes ?? null,
        _gls_dispute_submitted_at: nowIso,
        _gls_dispute_response: outcome.response,
        // Clear any prior failure marker so the UI no longer shows the error.
        _gls_dispute_error: null,
        _gls_dispute_error_status: null,
        // Reflect Google's own dispute state too — the poller will overwrite
        // this with the authoritative value on the next sync.
        disputeStatus: 'DISPUTED',
      });
      await storage.updateLead(lead.id, { rawPayload: updatedPayload }, tenantId);

      log.info(`[dispute] contractor=${tenantId} lead=${lead.id} gls=${glsLeadId} reason=${body.reason} → ${outcome.status}`);
      res.json({
        success: true,
        status: outcome.status,
        glsLeadId,
        reason: body.reason,
        submittedAt: nowIso,
      });
    }));

  /**
   * List the per-tenant auto-dispute rules used by the poller.
   * Empty array means "no rules configured" (manual disputes only).
   */
  app.get('/api/integrations/google-local-services/auto-dispute-rules',
    requireGlsAccess,
    asyncHandler(async (req: AuthedRequest, res: Response) => {
      const rules = await loadAutoDisputeRules(req.user.contractorId, GLS_SERVICE);
      res.json({ rules });
    }));

  /**
   * Replace the per-tenant auto-dispute rule list. We persist the entire
   * array as a single JSON blob — the rule count is small and edits almost
   * always touch multiple rules at once (re-ordering, toggling), so a
   * full-replace API is simpler than per-rule CRUD.
   */
  app.put('/api/integrations/google-local-services/auto-dispute-rules',
    requireGlsAccess,
    asyncHandler(async (req: AuthedRequest, res: Response) => {
      const body = parseBody(z.object({
        rules: glsAutoDisputeRulesSchema,
      }), req, res);
      if (!body) return;

      // Reject duplicate rule ids — the UI uses them as React keys and as
      // the value stored in `_gls_auto_dispute_rule_id` on disputed leads.
      const ids = new Set<string>();
      for (const r of body.rules) {
        if (ids.has(r.id)) {
          res.status(400).json({ message: `Duplicate rule id: ${r.id}` });
          return;
        }
        ids.add(r.id);
      }

      const tenantId = req.user.contractorId;
      if (body.rules.length === 0) {
        // Clearing all rules → drop the credential entirely so future loads
        // skip the JSON parse path.
        await CredentialService.disableCredential(tenantId, GLS_SERVICE, GLS_AUTO_DISPUTE_RULES_KEY);
      } else {
        await CredentialService.setCredential(
          tenantId, GLS_SERVICE, GLS_AUTO_DISPUTE_RULES_KEY, JSON.stringify(body.rules),
        );
      }
      log.info(`[auto-dispute-rules] contractor=${tenantId} saved ${body.rules.length} rule(s)`);
      res.json({ rules: body.rules satisfies GlsAutoDisputeRule[] });
    }));

  /**
   * Summary of dispute outcomes for the contractor's Google Local Services
   * leads. Powers the "Disputes" section on the GLS settings card so admins
   * can monitor credit recovery and spot systematically rejected disputes.
   *
   * Source of truth is `leads.rawPayload._gls_dispute_status` (set both by
   * the dispute action and by the poller mirroring Google's authoritative
   * state — see `server/sync/google-local-services-leads.ts`).
   *
   * Bucketing windows (30/90 day):
   *   - submitted   → bucketed by `_gls_dispute_submitted_at`
   *   - approved    → bucketed by `_gls_dispute_resolved_at` (stamped by the
   *                    poller the first time it observed the resolution),
   *                    falling back to `lead.updatedAt` for legacy rows
   *                    resolved before that marker existed
   *   - rejected    → ditto for rejected
   *   - failed      → bucketed by `_gls_dispute_attempted_at`
   * Google's report has no resolution timestamp, so `_gls_dispute_resolved_at`
   * captures when we first observed the resolution — a tight upper bound that
   * is stable across unrelated lead updates that bump `updatedAt` later.
   */
  app.get('/api/integrations/google-local-services/disputes/summary',
    requireGlsAccess,
    asyncHandler(async (req: AuthedRequest, res: Response) => {
      const tenantId = req.user.contractorId;

      // Fetch all GLS leads for this tenant whose payload mentions a dispute
      // marker. The LIKE filter avoids parsing tens of thousands of lead
      // payloads for tenants with no dispute history.
      const rows = await db
        .select({
          id: leadsTable.id,
          contactId: leadsTable.contactId,
          rawPayload: leadsTable.rawPayload,
          updatedAt: leadsTable.updatedAt,
          createdAt: leadsTable.createdAt,
          name: contactsTable.name,
        })
        .from(leadsTable)
        .leftJoin(contactsTable, eq(contactsTable.id, leadsTable.contactId))
        .where(and(
          eq(leadsTable.contractorId, tenantId),
          eq(leadsTable.source, GLS_SOURCE),
          like(leadsTable.rawPayload, '%_gls_dispute_status%'),
        ))
        .orderBy(desc(leadsTable.updatedAt));

      const now = Date.now();
      const D30 = now - 30 * 24 * 60 * 60_000;
      const D90 = now - 90 * 24 * 60 * 60_000;
      const buckets = {
        last30: { submitted: 0, approved: 0, rejected: 0, failed: 0 },
        last90: { submitted: 0, approved: 0, rejected: 0, failed: 0 },
      };
      const totals = { submitted: 0, approved: 0, rejected: 0, failed: 0 };

      // Cap drill-down list — admins eyeball recent activity, not history.
      const DISPUTE_LIST_CAP = 50;
      const disputes: Array<{
        leadId: string;
        contactId: string;
        contactName: string | null;
        status: 'submitted' | 'approved' | 'rejected' | 'failed';
        reason: string | null;
        notes: string | null;
        submittedAt: string | null;
        attemptedAt: string | null;
        resolvedAt: string | null;
        error: string | null;
      }> = [];

      for (const row of rows) {
        let payload: Record<string, unknown>;
        try { payload = JSON.parse(row.rawPayload ?? '{}'); }
        catch { continue; }

        const rawStatus = payload._gls_dispute_status;
        if (rawStatus !== 'submitted' && rawStatus !== 'approved' && rawStatus !== 'rejected' && rawStatus !== 'failed') {
          continue;
        }
        const status = rawStatus as 'submitted' | 'approved' | 'rejected' | 'failed';

        // Pick the timestamp that defines when this dispute "happened" for
        // bucketing. `submitted_at` and `attempted_at` are explicit; for
        // approved/rejected we prefer `_gls_dispute_resolved_at` (stamped by
        // the poller on the submitted→approved/rejected transition) and fall
        // back to `updatedAt` only for legacy rows resolved before that
        // marker existed.
        const submittedAt = typeof payload._gls_dispute_submitted_at === 'string' ? payload._gls_dispute_submitted_at : null;
        const attemptedAt = typeof payload._gls_dispute_attempted_at === 'string' ? payload._gls_dispute_attempted_at : null;
        const resolvedAtMarker = typeof payload._gls_dispute_resolved_at === 'string' ? payload._gls_dispute_resolved_at : null;
        let bucketTs: number | null = null;
        if (status === 'submitted' && submittedAt) bucketTs = Date.parse(submittedAt);
        else if (status === 'failed' && attemptedAt) bucketTs = Date.parse(attemptedAt);
        else if ((status === 'approved' || status === 'rejected') && resolvedAtMarker) bucketTs = Date.parse(resolvedAtMarker);
        else bucketTs = row.updatedAt ? new Date(row.updatedAt).getTime() : null;

        totals[status]++;
        if (bucketTs !== null && !Number.isNaN(bucketTs)) {
          if (bucketTs >= D90) buckets.last90[status]++;
          if (bucketTs >= D30) buckets.last30[status]++;
        }

        if (disputes.length < DISPUTE_LIST_CAP) {
          disputes.push({
            leadId: row.id,
            contactId: row.contactId,
            contactName: row.name ?? null,
            status,
            reason: typeof payload._gls_dispute_reason === 'string' ? payload._gls_dispute_reason : null,
            notes: typeof payload._gls_dispute_notes === 'string' ? payload._gls_dispute_notes : null,
            submittedAt,
            attemptedAt,
            resolvedAt: status === 'approved' || status === 'rejected'
              ? (resolvedAtMarker ?? (row.updatedAt ? new Date(row.updatedAt).toISOString() : null))
              : null,
            error: typeof payload._gls_dispute_error === 'string' ? payload._gls_dispute_error : null,
          });
        }
      }

      res.json({
        windows: buckets,
        totals,
        disputes,
        listTruncated: rows.length > DISPUTE_LIST_CAP,
      });
    }));

  app.put('/api/integrations/google-local-services/credentials',
    requireGlsAccess,
    asyncHandler(async (req: AuthedRequest, res: Response) => {
      const body = parseBody(z.object({
        // Empty string => clear that credential. Omitted => leave as-is.
        developerToken: z.string().optional(),
        clientId: z.string().optional(),
        clientSecret: z.string().optional(),
      }), req, res);
      if (!body) return;

      const tenantId = req.user.contractorId;

      // -------- Format validation (cheap, no network) --------
      const formatErr = validateCredentialFormats(body);
      if (formatErr) {
        res.status(400).json({ message: formatErr.message, field: formatErr.field });
        return;
      }

      // -------- Live pre-save validation against Google --------
      // Compute what the *effective* credentials would be after this update,
      // without persisting yet. We run cheap probes against Google to catch
      // typos / bad MCC up front, instead of surfacing 5 minutes later in the
      // sync error banner. Transient (5xx / network) errors never block save.
      const validationErr = await validateAgainstGoogle(tenantId, body);
      if (validationErr) {
        res.status(400).json({ message: validationErr.message, field: validationErr.field });
        return;
      }

      // Capture the OAuth client_id that was in effect *before* this update so
      // we can detect a change and invalidate any stale refresh token.
      const writes: Promise<void>[] = [];
      if (body.developerToken !== undefined) {
        writes.push(body.developerToken
          ? CredentialService.setCredential(tenantId, GLS_SERVICE, TENANT_CRED_KEYS.developerToken, body.developerToken)
          : CredentialService.disableCredential(tenantId, GLS_SERVICE, TENANT_CRED_KEYS.developerToken));
      }
      if (body.clientId !== undefined) {
        writes.push(body.clientId
          ? CredentialService.setCredential(tenantId, GLS_SERVICE, TENANT_CRED_KEYS.clientId, body.clientId)
          : CredentialService.disableCredential(tenantId, GLS_SERVICE, TENANT_CRED_KEYS.clientId));
      }
      if (body.clientSecret !== undefined) {
        writes.push(body.clientSecret
          ? CredentialService.setCredential(tenantId, GLS_SERVICE, TENANT_CRED_KEYS.clientSecret, body.clientSecret)
          : CredentialService.disableCredential(tenantId, GLS_SERVICE, TENANT_CRED_KEYS.clientSecret));
      }
      await Promise.all(writes);

      const next = await resolveGlsCredentials(tenantId);
      const refreshTokenInvalidated = await maybeInvalidateRefreshTokenOnClientChange(
        tenantId, next.clientId,
      );

      const tenantHasOverrides = await hasAnyTenantCredentials(tenantId);
      res.json({
        success: true,
        credentialsSource: next.source,
        oauthSource: next.oauthSource,
        configured: !!(next.clientId && next.clientSecret),
        developerTokenSet: !!next.developerToken,
        tenantHasOverrides,
        refreshTokenInvalidated,
      });
    }));
}

/**
 * Format-only validation for credentials submitted to PUT /credentials.
 * Returns null when everything looks plausible. Empty strings are clears,
 * which are always allowed (no format check). Omitted fields are skipped.
 */
function validateCredentialFormats(
  body: { developerToken?: string; clientId?: string; clientSecret?: string },
): { message: string; field: 'developerToken' | 'clientId' | 'clientSecret' } | null {
  if (body.clientId && body.clientId.trim() !== '') {
    const v = body.clientId.trim();
    // Google OAuth client IDs always end with .apps.googleusercontent.com
    if (!/\.apps\.googleusercontent\.com$/i.test(v) || v.length < 20) {
      return {
        field: 'clientId',
        message: 'OAuth Client ID does not look like a Google OAuth 2.0 client ID. Expected format: 1234567890-abc.apps.googleusercontent.com',
      };
    }
  }
  if (body.clientSecret && body.clientSecret.trim() !== '') {
    const v = body.clientSecret.trim();
    // Google OAuth client secrets begin with GOCSPX- and are >= ~20 chars.
    if (v.length < 12) {
      return {
        field: 'clientSecret',
        message: 'OAuth Client Secret looks too short. Copy it again from your Google Cloud OAuth client.',
      };
    }
  }
  if (body.developerToken && body.developerToken.trim() !== '') {
    const v = body.developerToken.trim();
    // Google Ads developer tokens are 22 chars, typically alphanumeric with -/_.
    if (!/^[A-Za-z0-9_-]{15,40}$/.test(v)) {
      return {
        field: 'developerToken',
        message: 'Google Ads Developer Token format is unexpected (should be ~22 alphanumeric characters from your Google Ads MCC).',
      };
    }
  }
  return null;
}

/**
 * Live pre-save validation against Google. Returns a user-facing error message
 * when the credentials are clearly bad and the save should be rejected, or
 * null otherwise (including transient Google blips, which never block save).
 *
 * Strategy:
 *   1. Compute the *next* effective credentials (what would be active AFTER
 *      this update is applied). We do not persist yet.
 *   2. If the OAuth client_id/secret would change, probe the token endpoint
 *      to verify Google accepts the client_id/secret pair. (No GLS quota.)
 *   3. If the developer token would change AND we have a usable refresh token
 *      whose issuing client matches the next client_id, issue a tiny
 *      accountReports:search to verify the developer token works.
 */
type ValidationField = 'developerToken' | 'clientId' | 'clientSecret' | 'credentials';

async function validateAgainstGoogle(
  tenantId: string,
  body: { developerToken?: string; clientId?: string; clientSecret?: string },
): Promise<{ message: string; field: ValidationField } | null> {
  const current = await resolveGlsCredentials(tenantId);

  // Compute "next" effective credentials. Same precedence rules as
  // resolveGlsCredentials: tenant pair wins over platform pair when *both*
  // tenant client_id and secret are present; tenant developer token wins when
  // present.
  const platform = {
    clientId: process.env.GOOGLE_LOCAL_SERVICES_CLIENT_ID || null,
    clientSecret: process.env.GOOGLE_LOCAL_SERVICES_CLIENT_SECRET || null,
    developerToken: process.env.GOOGLE_LOCAL_SERVICES_DEVELOPER_TOKEN || null,
  };
  const [curTenantClientId, curTenantClientSecret, curTenantDevToken] = await Promise.all([
    CredentialService.getCredential(tenantId, GLS_SERVICE, TENANT_CRED_KEYS.clientId),
    CredentialService.getCredential(tenantId, GLS_SERVICE, TENANT_CRED_KEYS.clientSecret),
    CredentialService.getCredential(tenantId, GLS_SERVICE, TENANT_CRED_KEYS.developerToken),
  ]);
  const apply = (cur: string | null, incoming: string | undefined): string | null => {
    if (incoming === undefined) return cur;
    return incoming === '' ? null : incoming;
  };
  const nextTenantClientId = apply(curTenantClientId, body.clientId);
  const nextTenantClientSecret = apply(curTenantClientSecret, body.clientSecret);
  const nextTenantDevToken = apply(curTenantDevToken, body.developerToken);
  const useTenantOauth = !!nextTenantClientId && !!nextTenantClientSecret;
  const nextCreds = {
    clientId: useTenantOauth ? nextTenantClientId : platform.clientId,
    clientSecret: useTenantOauth ? nextTenantClientSecret : platform.clientSecret,
    developerToken: nextTenantDevToken || platform.developerToken,
    source: (nextTenantDevToken ? 'tenant' : 'platform') as 'tenant' | 'platform',
    oauthSource: (useTenantOauth ? 'tenant' : 'platform') as 'tenant' | 'platform',
    configured: false,
  };
  nextCreds.configured = !!(nextCreds.clientId && nextCreds.clientSecret && nextCreds.developerToken);

  const oauthChanged =
    nextCreds.clientId !== current.clientId ||
    nextCreds.clientSecret !== current.clientSecret;
  const devTokenChanged = nextCreds.developerToken !== current.developerToken;

  // 1) Verify OAuth client whenever it changes (and we have something to test).
  if (oauthChanged && nextCreds.clientId && nextCreds.clientSecret) {
    const r = await googleLocalServicesClient.verifyOauthClient(nextCreds);
    if (!r.ok) return { message: r.reason, field: r.field };
  }

  // 2) Verify developer token only when we can — needs a refresh token whose
  //    issuing client matches the next client_id. Otherwise we'd be testing
  //    against the wrong tenant's token, or have no token at all. In that
  //    case bad developer tokens will only be caught by the next sync poll —
  //    log it so the skipped check is visible to operators.
  if (devTokenChanged && nextCreds.developerToken && nextCreds.clientId) {
    const [refreshToken, issuingClientId] = await Promise.all([
      CredentialService.getCredential(tenantId, GLS_SERVICE, 'refresh_token'),
      CredentialService.getCredential(tenantId, GLS_SERVICE, TENANT_CRED_KEYS.refreshTokenClientId),
    ]);
    if (refreshToken && issuingClientId === nextCreds.clientId) {
      const r = await googleLocalServicesClient.verifyDeveloperToken(nextCreds, refreshToken);
      if (!r.ok) return { message: r.reason, field: r.field };
    } else {
      log.info(
        `[credentials] Skipping live developer-token check for contractor ${tenantId} ` +
        `(refreshToken=${!!refreshToken}, clientMatches=${issuingClientId === nextCreds.clientId}). ` +
        `Token will be exercised on the next sync poll.`,
      );
    }
  }

  return null;
}

/**
 * Refresh tokens are bound by Google to the OAuth client that minted them. If
 * the *effective* OAuth client_id for this tenant no longer matches the
 * client_id that issued the currently-stored refresh token, that refresh token
 * is dead — clear the stale auth state so the UI re-prompts the admin to
 * click "Connect Google Account".
 *
 * Trigger conditions (all relative to the issuing client_id we recorded at
 * callback time):
 *   - effective client_id changed to a different non-null value
 *     (e.g. tenant client A → tenant client B, or tenant → platform with
 *     different platform client_id)
 *   - effective client_id became null (no platform fallback configured and
 *     the tenant cleared their own OAuth client)
 *   - refresh token exists but no issuing client_id was ever recorded
 *     (legacy / unknown — fail safe by re-prompting connect)
 *
 * Returns true iff a refresh token was actually invalidated.
 */
async function maybeInvalidateRefreshTokenOnClientChange(
  tenantId: string,
  nextClientId: string | null,
): Promise<boolean> {
  const refreshToken = await CredentialService.getCredential(tenantId, GLS_SERVICE, 'refresh_token');
  if (!refreshToken) return false;

  const issuingClientId = await CredentialService.getCredential(
    tenantId, GLS_SERVICE, TENANT_CRED_KEYS.refreshTokenClientId,
  );

  // Same client that minted the token — nothing to do.
  if (issuingClientId && nextClientId && issuingClientId === nextClientId) return false;

  // Best-effort revoke at Google under the original client. Failures are
  // non-fatal; the refresh token is dead either way.
  await googleLocalServicesClient.revokeRefreshToken(refreshToken, issuingClientId ?? undefined);
  await Promise.all([
    CredentialService.disableCredential(tenantId, GLS_SERVICE, 'refresh_token'),
    CredentialService.disableCredential(tenantId, GLS_SERVICE, 'account_id'),
    CredentialService.disableCredential(tenantId, GLS_SERVICE, 'account_name'),
    CredentialService.disableCredential(tenantId, GLS_SERVICE, TENANT_CRED_KEYS.refreshTokenClientId),
  ]);
  try { await storage.disableTenantIntegration(tenantId, GLS_SERVICE); } catch { /* optional */ }
  try { await syncScheduler.onIntegrationDisabled(tenantId, GLS_SERVICE); } catch { /* optional */ }
  log.info(`[credentials] Invalidated stale Google refresh token for contractor ${tenantId} (issuingClientId=${issuingClientId ?? 'unknown'} → nextClientId=${nextClientId ?? 'none'})`);
  return true;
}
