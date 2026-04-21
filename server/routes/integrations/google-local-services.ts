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
 *
 * Required env vars:
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
import { googleLocalServicesClient } from '../../services/google-local-services-client';
import { syncGoogleLocalServicesLeads, GLS_SERVICE } from '../../sync/google-local-services-leads';
import { parseBody } from '../../utils/validate-body';
import { z } from 'zod';

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
      if (!googleLocalServicesClient.isConfigured()) {
        res.status(500).json({ message: 'Google Local Services integration is not configured. Set GOOGLE_LOCAL_SERVICES_CLIENT_ID and GOOGLE_LOCAL_SERVICES_CLIENT_SECRET.' });
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
        client_id: process.env.GOOGLE_LOCAL_SERVICES_CLIENT_ID!,
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
        const tokens = await googleLocalServicesClient.exchangeCodeForTokens(String(code), callbackUrl);

        // Persist refresh token immediately so the user can pick an account next.
        await CredentialService.setCredential(verified.contractorId, GLS_SERVICE, 'refresh_token', tokens.refreshToken);
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
      try {
        const accounts = await googleLocalServicesClient.listAccounts(refreshToken);
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
        await googleLocalServicesClient.revokeRefreshToken(refreshToken);
      }
      await CredentialService.deleteIntegrationCredentials(req.user.contractorId, GLS_SERVICE);
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
      const [refreshToken, accountId, accountName, lastPollAt, lastSuccessAt, lastError, lastErrorAt] = await Promise.all([
        CredentialService.getCredential(req.user.contractorId, GLS_SERVICE, 'refresh_token'),
        CredentialService.getCredential(req.user.contractorId, GLS_SERVICE, 'account_id'),
        CredentialService.getCredential(req.user.contractorId, GLS_SERVICE, 'account_name'),
        CredentialService.getCredential(req.user.contractorId, GLS_SERVICE, 'last_poll_at'),
        CredentialService.getCredential(req.user.contractorId, GLS_SERVICE, 'last_success_at'),
        CredentialService.getCredential(req.user.contractorId, GLS_SERVICE, 'last_error'),
        CredentialService.getCredential(req.user.contractorId, GLS_SERVICE, 'last_error_at'),
      ]);

      const configured = googleLocalServicesClient.isConfigured();
      const developerTokenSet = !!process.env.GOOGLE_LOCAL_SERVICES_DEVELOPER_TOKEN;
      const enabled = await storage.isIntegrationEnabled(req.user.contractorId, GLS_SERVICE);

      res.json({
        configured,
        developerTokenSet,
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
}
