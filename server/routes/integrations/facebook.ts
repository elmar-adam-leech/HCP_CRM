import type { Express, Request, Response, NextFunction, RequestHandler } from 'express';
import crypto from 'crypto';
import { type AuthedRequest } from '../../auth-service';
import { httpJson } from '../../utils/http';
import { CredentialService } from '../../credential-service';
import { asyncHandler } from '../../utils/async-handler';
import { logger } from '../../utils/logger';
import { z } from 'zod';
import { storage } from '../../storage';
import { parseBody } from '../../utils/validate-body';
import { syncScheduler } from '../../sync-scheduler';
import { processFacebookLead } from '../../sync/facebook-leads';

interface FbPage {
  id: string;
  name: string;
  access_token: string;
}

interface FbBusiness {
  id: string;
  name: string;
}

const log = logger('FacebookIntegration');

const FB_API_VERSION = 'v25.0';

/**
 * Middleware that allows access to managers/admins OR any user with canManageIntegrations=true.
 * Used for Facebook endpoints so that users explicitly granted integration management access
 * can manage the Facebook connection regardless of their role.
 */
const requireFacebookAccess: RequestHandler = (req: Request, res: Response, next: NextFunction): void => {
  const user = (req as AuthedRequest).user;
  if (!user) {
    res.status(401).json({ message: 'Authentication required' });
    return;
  }
  if (['manager', 'admin', 'super_admin'].includes(user.role) || user.canManageIntegrations) {
    next();
  } else {
    res.status(403).json({ message: 'You do not have permission to manage the Facebook integration' });
  }
};

function getBaseUrl(req: Request): string {
  const proto = (req.get('x-forwarded-proto') || req.protocol) as string;
  const host = (req.get('x-forwarded-host') || req.get('host')) as string;
  return `${proto}://${host}`;
}

async function registerAppWebhook(baseUrl: string): Promise<void> {
  const appId = process.env.FACEBOOK_APP_ID;
  const appSecret = process.env.FACEBOOK_APP_SECRET;
  const verifyToken = process.env.FACEBOOK_VERIFY_TOKEN;

  if (!appId || !appSecret || !verifyToken) {
    log.warn('[registerAppWebhook] Skipping: FACEBOOK_APP_ID, FACEBOOK_APP_SECRET, or FACEBOOK_VERIFY_TOKEN not set');
    return;
  }

  const appAccessToken = `${appId}|${appSecret}`;
  const callbackUrl = `${baseUrl}/api/webhooks/facebook`;

  await httpJson(
    `https://graph.facebook.com/${FB_API_VERSION}/${appId}/subscriptions`,
    {
      method: 'POST',
      body: {},
      params: {
        object: 'page',
        callback_url: callbackUrl,
        verify_token: verifyToken,
        fields: 'leadgen',
        access_token: appAccessToken,
      },
      timeout: 15000,
    }
  );
}

export function registerFacebookIntegrationRoutes(app: Express): void {
  app.get('/api/integrations/facebook/connect', requireFacebookAccess, asyncHandler(async (req: AuthedRequest, res: Response) => {
    if (!process.env.FACEBOOK_APP_ID) {
      res.status(500).json({ message: 'Facebook integration is not configured. Please set FACEBOOK_APP_ID.' });
      return;
    }

    const baseUrl = getBaseUrl(req);
    const callbackUrl = `${baseUrl}/api/integrations/facebook/callback`;
    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) {
      res.status(500).json({ message: 'Server configuration error: JWT_SECRET is not set' });
      return;
    }
    const statePayload = { contractorId: req.user.contractorId, userId: req.user.userId };
    const stateJson = JSON.stringify(statePayload);
    const sig = crypto.createHmac('sha256', jwtSecret).update(stateJson).digest('hex');
    const state = Buffer.from(JSON.stringify({ ...statePayload, sig })).toString('base64');

    const authUrl = [
      `https://www.facebook.com/${FB_API_VERSION}/dialog/oauth`,
      `?client_id=${process.env.FACEBOOK_APP_ID}`,
      `&redirect_uri=${encodeURIComponent(callbackUrl)}`,
      `&scope=pages_show_list,leads_retrieval,ads_management,pages_manage_ads,business_management,pages_manage_metadata`,
      `&state=${state}`,
    ].join('');

    if (!authUrl.startsWith('https://www.facebook.com/')) {
      log.error(`Unexpected OAuth redirect URL generated: ${authUrl}`);
      res.status(500).json({ message: "OAuth provider returned an unexpected redirect URL" });
      return;
    }

    res.json({ authUrl });
  }));

  app.get('/api/integrations/facebook/callback', asyncHandler<Request>(async (req: Request, res: Response) => {
    const { code, state, error: fbError } = req.query;

    const callbackJwtSecret = process.env.JWT_SECRET;
    if (!callbackJwtSecret) {
      log.error('Facebook OAuth callback: JWT_SECRET is not set — cannot verify state signature');
      res.redirect('/settings?tab=integrations&facebook=error');
      return;
    }

    let contractorId: string;

    let userId: string | undefined;
    try {
      const decoded = JSON.parse(Buffer.from(state as string, 'base64').toString());
      const { sig, ...payload } = decoded;
      const expectedSig = crypto.createHmac('sha256', callbackJwtSecret).update(JSON.stringify(payload)).digest('hex');
      if (!sig || !crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expectedSig, 'hex'))) {
        log.error('Facebook OAuth state signature mismatch — possible CSRF');
        res.redirect('/settings?tab=integrations&facebook=error');
        return;
      }
      contractorId = payload.contractorId;
      userId = payload.userId ?? undefined;
    } catch {
      res.redirect('/settings?tab=integrations&facebook=error');
      return;
    }

    if (fbError || !code) {
      log.error('Facebook OAuth error:', fbError);
      res.redirect('/settings?tab=integrations&facebook=error');
      return;
    }

    try {
      const baseUrl = getBaseUrl(req);
      const callbackUrl = `${baseUrl}/api/integrations/facebook/callback`;

      // Step 1: Exchange code for short-lived user access token
      let shortToken: string;
      try {
        const shortTokenRes = await httpJson(`https://graph.facebook.com/${FB_API_VERSION}/oauth/access_token`, {
          params: {
            client_id: process.env.FACEBOOK_APP_ID,
            client_secret: process.env.FACEBOOK_APP_SECRET,
            redirect_uri: callbackUrl,
            code: String(code),
          },
          timeout: 10000,
        });
        shortToken = shortTokenRes.data.access_token;
        log.info(`[callback] Step 1 OK: obtained short-lived token for contractor ${contractorId}`);
      } catch (err: any) {
        const fbMsg = err?.response?.data?.error?.message || err?.message || String(err);
        log.error(`[callback] Step 1 FAILED (short token exchange): ${fbMsg}`);
        res.redirect(`/settings?tab=integrations&facebook=error&reason=token_exchange`);
        return;
      }

      // Step 2: Exchange short-lived for long-lived user access token (60 days)
      let longToken: string;
      let userTokenExpiresAt: string | null = null;
      try {
        const longTokenRes = await httpJson(`https://graph.facebook.com/${FB_API_VERSION}/oauth/access_token`, {
          params: {
            grant_type: 'fb_exchange_token',
            client_id: process.env.FACEBOOK_APP_ID,
            client_secret: process.env.FACEBOOK_APP_SECRET,
            fb_exchange_token: shortToken,
          },
          timeout: 10000,
        });
        longToken = longTokenRes.data.access_token;
        const expiresIn: number | undefined = longTokenRes.data.expires_in;
        if (expiresIn && expiresIn > 0) {
          userTokenExpiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
        }
        log.info(`[callback] Step 2 OK: obtained long-lived token for contractor ${contractorId}, expires in ${expiresIn ?? 'unknown'} seconds`);
      } catch (err: any) {
        const fbMsg = err?.response?.data?.error?.message || err?.message || String(err);
        log.error(`[callback] Step 2 FAILED (long token exchange): ${fbMsg}`);
        res.redirect(`/settings?tab=integrations&facebook=error&reason=token_exchange`);
        return;
      }

      // Step 3: Fetch user's managed Pages
      // Use short-lived token for /me/accounts — more reliable for page permissions than long-lived token
      let pages: FbPage[];
      try {
        const pagesRes = await httpJson(`https://graph.facebook.com/${FB_API_VERSION}/me/accounts`, {
          params: { access_token: shortToken, fields: 'id,name,access_token' },
          timeout: 10000,
        });
        pages = pagesRes.data.data || [];
        log.info(`[callback] Step 3 /me/accounts: found ${pages.length} page(s), raw keys: ${Object.keys(pagesRes.data).join(',')}`);
      } catch (err: any) {
        const fbMsg = err?.response?.data?.error?.message || err?.message || String(err);
        log.error(`[callback] Step 3 FAILED (fetch pages via /me/accounts): ${fbMsg}`);
        res.redirect(`/settings?tab=integrations&facebook=error&reason=fetch_pages_failed`);
        return;
      }

      // Step 3b: Business Manager fallback — pages owned by a Business Manager don't appear in
      // /me/accounts. Try /me/businesses → /owned_pages for each business.
      if (pages.length === 0) {
        log.info(`[callback] Step 3b: /me/accounts returned 0 pages — trying Business Manager API for contractor ${contractorId}`);
        try {
          const bizRes = await httpJson(`https://graph.facebook.com/${FB_API_VERSION}/me/businesses`, {
            params: { access_token: longToken, fields: 'id,name' },
            timeout: 10000,
          });
          const businesses: FbBusiness[] = bizRes.data.data || [];
          log.info(`[callback] Step 3b: found ${businesses.length} business(es) for contractor ${contractorId}`);

          for (const biz of businesses) {
            try {
              const bizPagesRes = await httpJson(`https://graph.facebook.com/${FB_API_VERSION}/${biz.id}/owned_pages`, {
                params: { access_token: longToken, fields: 'id,name,access_token' },
                timeout: 10000,
              });
              const bizPages: FbPage[] = bizPagesRes.data.data || [];
              log.info(`[callback] Step 3b: business "${biz.name}" (${biz.id}) has ${bizPages.length} owned page(s)`);
              pages.push(...bizPages);
            } catch (bizPageErr: any) {
              log.warn(`[callback] Step 3b: could not fetch pages for business ${biz.id}: ${bizPageErr?.response?.data?.error?.message || bizPageErr?.message}`);
            }
          }
        } catch (bizErr: any) {
          log.warn(`[callback] Step 3b: Business Manager API failed (non-fatal): ${bizErr?.response?.data?.error?.message || bizErr?.message}`);
        }
      }

      if (pages.length === 0) {
        log.error(`[callback] Step 3: No Facebook Pages found via /me/accounts or Business Manager for contractor ${contractorId}. The user must manage at least one Page.`);
        res.redirect('/settings?tab=integrations&facebook=error&reason=no_pages');
        return;
      }

      const page = pages[0];

      // Step 3c: Derive a proper page access token from the long-lived user token.
      // Tokens from /me/accounts or Business Manager's /owned_pages may be limited and
      // lack leads_retrieval permission. Fetching the page directly with the user token
      // produces a token that inherits all OAuth-granted permissions.
      let pageToken: string = page.access_token || '';
      try {
        const pageTokenRes = await httpJson(`https://graph.facebook.com/${FB_API_VERSION}/${page.id}`, {
          params: { fields: 'id,name,access_token', access_token: longToken },
          timeout: 10000,
        });
        if (pageTokenRes.data.access_token) {
          pageToken = pageTokenRes.data.access_token;
          log.info(`[callback] Step 3c OK: derived proper page access token for page ${page.id}`);
        } else {
          log.warn(`[callback] Step 3c: no access_token in page response, falling back to token from page list`);
        }
      } catch (ptErr: any) {
        log.warn(`[callback] Step 3c: could not derive page token (non-fatal, using token from page list): ${ptErr?.response?.data?.error?.message || ptErr?.message}`);
      }

      // Step 4: Persist credentials to DB and enable contractor integration
      try {
        const credentialWrites = [
          CredentialService.setCredential(contractorId, 'facebook-leads', 'page_id', page.id),
          CredentialService.setCredential(contractorId, 'facebook-leads', 'page_name', page.name || ''),
          CredentialService.setCredential(contractorId, 'facebook-leads', 'page_access_token', pageToken),
          CredentialService.setCredential(contractorId, 'facebook-leads', 'user_access_token', longToken),
        ];
        if (userTokenExpiresAt) {
          credentialWrites.push(
            CredentialService.setCredential(contractorId, 'facebook-leads', 'user_token_expires_at', userTokenExpiresAt)
          );
        }
        await Promise.all(credentialWrites);
        // Create/update contractor_integrations row so the integration appears in the admin view
        await storage.enableTenantIntegration(contractorId, 'facebook-leads', userId);
        {
          const { invalidateContractorCache } = await import('../../services/cache');
          invalidateContractorCache(contractorId);
        }
        log.info(`[callback] Step 4 OK: saved credentials and enabled integration for contractor ${contractorId}, page "${page.name}" (${page.id})`);

        // Schedule automatic 5-minute polling as a fallback for missed webhook deliveries.
        try {
          await syncScheduler.onIntegrationEnabled(contractorId, 'facebook-leads');
        } catch (schedErr: any) {
          log.warn(`[callback] Failed to register facebook-leads sync schedule (non-fatal): ${schedErr?.message || schedErr}`);
        }
      } catch (err: any) {
        log.error(`[callback] Step 4 FAILED (save credentials): ${err?.message || String(err)}`);
        res.redirect(`/settings?tab=integrations&facebook=error&reason=save_failed`);
        return;
      }

      // Step 5: Subscribe page to leadgen webhook (non-fatal)
      let webhookOutcome: 'ok' | 'missing_verify_token' | 'subscribe_failed' = 'ok';
      try {
        if (process.env.FACEBOOK_VERIFY_TOKEN) {
          await httpJson(
            `https://graph.facebook.com/${FB_API_VERSION}/${page.id}/subscribed_apps`,
            {
              method: 'POST',
              body: {},
              params: { subscribed_fields: 'leadgen', access_token: pageToken },
              timeout: 10000,
            }
          );
          log.info(`[callback] Step 5 OK: subscribed page ${page.id} to leadgen webhook`);
        } else {
          webhookOutcome = 'missing_verify_token';
          const webhookUrl = `${process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : process.env.BASE_URL || 'https://your-domain.com'}/api/webhooks/facebook`;
          log.warn(`[callback] Step 5 SKIPPED: FACEBOOK_VERIFY_TOKEN is not set. Real-time webhook delivery will NOT work. Configure it in your environment and set your Meta app webhook URL to: ${webhookUrl}`);
        }
      } catch (webhookErr: any) {
        webhookOutcome = 'subscribe_failed';
        const fbMsg = webhookErr?.response?.data?.error?.message || webhookErr?.message || String(webhookErr);
        log.warn(`[callback] Step 5 WARN: failed to subscribe to leadgen webhook (non-fatal — leads can still be imported manually): ${fbMsg}`);
      }

      // Step 6: Register app-level webhook subscription (non-fatal)
      const hasAppCredentials = !!(process.env.FACEBOOK_APP_ID && process.env.FACEBOOK_APP_SECRET && process.env.FACEBOOK_VERIFY_TOKEN);
      if (hasAppCredentials) {
        try {
          const baseUrl = getBaseUrl(req);
          await registerAppWebhook(baseUrl);
          log.info(`[callback] Step 6 OK: app-level webhook subscription registered`);
        } catch (appWebhookErr: any) {
          const fbMsg = appWebhookErr?.response?.data?.error?.message || appWebhookErr?.message || String(appWebhookErr);
          log.warn(`[callback] Step 6 WARN: failed to register app-level webhook subscription (non-fatal): ${fbMsg}`);
        }
      } else {
        log.warn(`[callback] Step 6 SKIPPED: FACEBOOK_APP_ID, FACEBOOK_APP_SECRET, or FACEBOOK_VERIFY_TOKEN not set — app-level webhook not registered`);
      }

      log.info(`[callback] Facebook Lead Ads successfully connected for contractor ${contractorId}, page "${page.name}" (${page.id})`);
      let redirectUrl = '/settings?tab=integrations&facebook=connected';
      if (webhookOutcome === 'missing_verify_token') {
        redirectUrl += '&webhook_issue=missing_verify_token';
      } else if (webhookOutcome === 'subscribe_failed') {
        redirectUrl += '&webhook_issue=subscribe_failed';
      }
      res.redirect(redirectUrl);
    } catch (err) {
      log.error('[callback] Unexpected Facebook OAuth error:', err instanceof Error ? err.message : err);
      res.redirect('/settings?tab=integrations&facebook=error&reason=unexpected');
    }
  }));

  app.post('/api/integrations/facebook/disconnect', requireFacebookAccess, asyncHandler(async (req: AuthedRequest, res: Response) => {
    try {
      const pageAccessToken = await CredentialService.getCredential(req.user.contractorId, 'facebook-leads', 'page_access_token');
      const pageId = await CredentialService.getCredential(req.user.contractorId, 'facebook-leads', 'page_id');

      if (pageId && pageAccessToken) {
        try {
          await httpJson(`https://graph.facebook.com/${FB_API_VERSION}/${pageId}/subscribed_apps`, {
            method: 'DELETE',
            params: { access_token: pageAccessToken },
            timeout: 10000,
          });
        } catch (unsubErr) {
          log.error('Failed to unsubscribe from leadgen webhook (non-fatal):', unsubErr instanceof Error ? unsubErr.message : unsubErr);
        }
      }

      await CredentialService.deleteIntegrationCredentials(req.user.contractorId, 'facebook-leads');

      // Stop automatic polling now that Facebook is disconnected.
      try {
        await syncScheduler.onIntegrationDisabled(req.user.contractorId, 'facebook-leads');
      } catch (schedErr: any) {
        log.warn(`[disconnect] Failed to remove facebook-leads sync schedule (non-fatal): ${schedErr?.message || schedErr}`);
      }

      res.json({ success: true });
    } catch (err) {
      log.error('Failed to disconnect Facebook:', err);
      res.status(500).json({ message: 'Failed to disconnect Facebook integration' });
    }
  }));

  app.post('/api/integrations/facebook/resubscribe-webhook', requireFacebookAccess, asyncHandler(async (req: AuthedRequest, res: Response) => {
    const contractorId = req.user.contractorId;
    const pageId = await CredentialService.getCredential(contractorId, 'facebook-leads', 'page_id');
    const pageAccessToken = await CredentialService.getCredential(contractorId, 'facebook-leads', 'page_access_token');

    if (!pageId || !pageAccessToken) {
      res.status(400).json({ message: 'Facebook Lead Ads not connected. Please connect first.' });
      return;
    }

    if (!process.env.FACEBOOK_VERIFY_TOKEN) {
      res.status(400).json({ message: 'FACEBOOK_VERIFY_TOKEN is not configured. Set it in your environment before subscribing to webhooks.' });
      return;
    }

    try {
      await httpJson(
        `https://graph.facebook.com/${FB_API_VERSION}/${pageId}/subscribed_apps`,
        {
          method: 'POST',
          body: {},
          params: { subscribed_fields: 'leadgen', access_token: pageAccessToken },
          timeout: 10000,
        }
      );
      log.info(`[resubscribe] Successfully subscribed page ${pageId} to leadgen webhook`);
      res.json({ success: true });
    } catch (err: any) {
      const fbErr = err?.response?.data?.error;
      const fbMsg = fbErr?.message || err?.message || String(err);
      const fbCode = fbErr?.code;
      log.error(`[resubscribe] Failed to subscribe page ${pageId} to leadgen webhook: ${fbMsg}`);
      const hint = fbCode === 200
        ? ' This error typically means the pages_manage_metadata permission is missing. Reconnect Facebook to grant it.'
        : '';
      res.status(500).json({ message: `Failed to subscribe page to webhook: ${fbMsg}${hint}` });
    }
  }));

  app.post('/api/integrations/facebook/register-app-webhook', requireFacebookAccess, asyncHandler(async (req: AuthedRequest, res: Response) => {
    if (!process.env.FACEBOOK_APP_ID || !process.env.FACEBOOK_APP_SECRET) {
      res.status(400).json({ message: 'FACEBOOK_APP_ID and FACEBOOK_APP_SECRET must be configured to register the app-level webhook.' });
      return;
    }
    if (!process.env.FACEBOOK_VERIFY_TOKEN) {
      res.status(400).json({ message: 'FACEBOOK_VERIFY_TOKEN must be configured to register the app-level webhook.' });
      return;
    }
    try {
      const baseUrl = getBaseUrl(req);
      await registerAppWebhook(baseUrl);
      log.info('[register-app-webhook] App-level webhook subscription registered successfully');
      res.json({ success: true });
    } catch (err: any) {
      const fbMsg = err?.response?.data?.error?.message || err?.message || String(err);
      log.error(`[register-app-webhook] Failed to register app-level webhook: ${fbMsg}`);
      res.status(500).json({ message: `Failed to register app-level webhook: ${fbMsg}` });
    }
  }));

  app.get('/api/integrations/facebook/status', requireFacebookAccess, asyncHandler(async (req: AuthedRequest, res: Response) => {
    const [pageId, pageName, userTokenExpiresAt, lastWebhookLeadAt, pageAccessToken] = await Promise.all([
      CredentialService.getCredential(req.user.contractorId, 'facebook-leads', 'page_id'),
      CredentialService.getCredential(req.user.contractorId, 'facebook-leads', 'page_name'),
      CredentialService.getCredential(req.user.contractorId, 'facebook-leads', 'user_token_expires_at'),
      CredentialService.getCredential(req.user.contractorId, 'facebook-leads', 'last_webhook_lead_at'),
      CredentialService.getCredential(req.user.contractorId, 'facebook-leads', 'page_access_token'),
    ]);

    let tokenHealth: 'ok' | 'expiring_soon' | 'expired' | 'unknown' = 'unknown';
    let tokenExpiresInDays: number | undefined;
    if (userTokenExpiresAt) {
      const expiresDate = new Date(userTokenExpiresAt);
      const daysUntilExpiry = (expiresDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
      tokenExpiresInDays = Math.round(daysUntilExpiry);
      if (daysUntilExpiry < 0) tokenHealth = 'expired';
      else if (daysUntilExpiry < 7) tokenHealth = 'expiring_soon';
      else tokenHealth = 'ok';
    }

    const webhookVerifyTokenSet = !!process.env.FACEBOOK_VERIFY_TOKEN;

    let webhookSubscribed: boolean | null = null;
    if (pageId && pageAccessToken && webhookVerifyTokenSet) {
      try {
        const subRes = await httpJson(`https://graph.facebook.com/${FB_API_VERSION}/${pageId}/subscribed_apps`, {
          params: { access_token: pageAccessToken },
          timeout: 10000,
        });
        const apps = subRes.data?.data ?? [];
        webhookSubscribed = apps.some((app: any) =>
          Array.isArray(app.subscribed_fields) && app.subscribed_fields.includes('leadgen')
        );
      } catch (e: any) {
        log.warn(`[status] Failed to check webhook subscription for page ${pageId}: ${e?.response?.data?.error?.message ?? e?.message}`);
        webhookSubscribed = false;
      }
    }

    let appWebhookActive: boolean | null = null;
    const fbAppId = process.env.FACEBOOK_APP_ID;
    const fbAppSecret = process.env.FACEBOOK_APP_SECRET;
    if (fbAppId && fbAppSecret) {
      try {
        const appAccessToken = `${fbAppId}|${fbAppSecret}`;
        const appSubRes = await httpJson(`https://graph.facebook.com/${FB_API_VERSION}/${fbAppId}/subscriptions`, {
          params: { access_token: appAccessToken },
          timeout: 10000,
        });
        const subscriptions = appSubRes.data?.data ?? [];
        appWebhookActive = subscriptions.some((sub: any) =>
          sub.object === 'page' &&
          Array.isArray(sub.fields) &&
          sub.fields.some((f: any) => (typeof f === 'string' ? f : f?.name) === 'leadgen') &&
          sub.active === true
        );
      } catch (e: any) {
        log.warn(`[status] Failed to check app-level webhook subscription: ${e?.response?.data?.error?.message ?? e?.message}`);
        appWebhookActive = null;
      }
    }

    res.json({
      connected: !!pageId,
      pageId: pageId ?? undefined,
      pageName: pageName ?? undefined,
      tokenHealth,
      tokenExpiresAt: userTokenExpiresAt ?? undefined,
      tokenExpiresInDays,
      lastWebhookLeadAt: lastWebhookLeadAt ?? undefined,
      webhookVerifyTokenSet,
      webhookSubscribed,
      appWebhookActive,
    });
  }));

  app.get('/api/integrations/facebook/field-mappings', requireFacebookAccess, asyncHandler(async (req: AuthedRequest, res: Response) => {
    const mappingsStr = await CredentialService.getCredential(req.user.contractorId, 'facebook-leads', 'field_mappings');
    let mappings = {};
    if (mappingsStr) {
      try {
        mappings = JSON.parse(mappingsStr);
      } catch (err) {
        log.error('Failed to parse field mappings:', err);
      }
    }
    res.json({ mappings });
  }));

  app.post('/api/integrations/facebook/field-mappings', requireFacebookAccess, asyncHandler(async (req: AuthedRequest, res: Response) => {
    const mappings = req.body.mappings ?? req.body;
    if (typeof mappings !== 'object' || mappings === null || Array.isArray(mappings)) {
      res.status(400).json({ message: 'Mappings must be an object' });
      return;
    }

    await CredentialService.setCredential(
      req.user.contractorId,
      'facebook-leads',
      'field_mappings',
      JSON.stringify(mappings)
    );

    res.json({ success: true });
  }));

  const conversionsConfigSchema = z.object({
    datasetId: z.string().min(1, 'Dataset ID is required'),
    accessToken: z.string().min(1, 'Access Token is required'),
  });

  app.post('/api/integrations/facebook/conversions-config', requireFacebookAccess, asyncHandler(async (req: AuthedRequest, res: Response) => {
    const parsed = parseBody(conversionsConfigSchema, req, res);
    if (!parsed) return;

    const { datasetId, accessToken } = parsed;

    await Promise.all([
      CredentialService.setCredential(req.user.contractorId, 'facebook-conversions', 'dataset_id', datasetId),
      CredentialService.setCredential(req.user.contractorId, 'facebook-conversions', 'capi_access_token', accessToken),
    ]);

    res.json({ success: true });
  }));

  app.get('/api/integrations/facebook/conversions-config', requireFacebookAccess, asyncHandler(async (req: AuthedRequest, res: Response) => {
    const datasetId = await CredentialService.getCredential(req.user.contractorId, 'facebook-conversions', 'dataset_id');
    res.json({
      configured: !!datasetId,
      datasetId: datasetId ? `${datasetId.substring(0, 4)}${'•'.repeat(Math.max(0, datasetId.length - 8))}${datasetId.substring(datasetId.length - 4)}` : undefined,
    });
  }));

  app.delete('/api/integrations/facebook/conversions-config', requireFacebookAccess, asyncHandler(async (req: AuthedRequest, res: Response) => {
    await CredentialService.deleteIntegrationCredentials(req.user.contractorId, 'facebook-conversions');
    res.json({ success: true });
  }));

  app.get('/api/integrations/facebook/form-fields', requireFacebookAccess, asyncHandler(async (req: AuthedRequest, res: Response) => {
    const contractorId = req.user.contractorId;
    const pageId = await CredentialService.getCredential(contractorId, 'facebook-leads', 'page_id');
    const pageAccessToken = await CredentialService.getCredential(contractorId, 'facebook-leads', 'page_access_token');
    const userAccessToken = await CredentialService.getCredential(contractorId, 'facebook-leads', 'user_access_token');

    if (!pageId || !pageAccessToken) {
      res.status(400).json({ message: 'Facebook Lead Ads not connected' });
      return;
    }

    const fetchForms = async (token: string) =>
      httpJson(`https://graph.facebook.com/${FB_API_VERSION}/${pageId}/leadgen_forms`, {
        params: { fields: 'id,name,questions', access_token: token },
        timeout: 10000,
      });

    try {
      let formsRes: any;
      try {
        formsRes = await fetchForms(pageAccessToken);
        log.info(`[form-fields] fetched forms using page token for contractor ${contractorId}`);
      } catch (pageErr: any) {
        if (pageErr?.response?.status === 403 && userAccessToken) {
          log.warn(`[form-fields] page token returned 403, retrying with user token for contractor ${contractorId}`);
          formsRes = await fetchForms(userAccessToken);
          log.info(`[form-fields] fetched forms using user token for contractor ${contractorId}`);
        } else {
          throw pageErr;
        }
      }

      const forms = (formsRes.data.data || []).map((form: any) => ({
        id: form.id,
        name: form.name,
        fields: (form.questions || []).map((q: any) => q.key || q.label).filter(Boolean),
      }));

      res.json({ forms });
    } catch (err: any) {
      const fbErr = err?.response?.data?.error;
      log.error('Failed to fetch Facebook form fields:', fbErr ?? err?.message ?? err);
      res.status(500).json({
        message: 'Failed to fetch form fields from Facebook',
        detail: fbErr?.message,
        code: fbErr?.code,
      });
    }
  }));

  // GET /api/integrations/facebook/forms — returns available lead ad forms (id + name)
  app.get('/api/integrations/facebook/forms', requireFacebookAccess, asyncHandler(async (req: AuthedRequest, res: Response) => {
    const contractorId = req.user.contractorId;
    const pageId = await CredentialService.getCredential(contractorId, 'facebook-leads', 'page_id');
    const pageAccessToken = await CredentialService.getCredential(contractorId, 'facebook-leads', 'page_access_token');
    const userAccessToken = await CredentialService.getCredential(contractorId, 'facebook-leads', 'user_access_token');

    if (!pageId || !pageAccessToken) {
      res.status(400).json({ message: 'Facebook Lead Ads not connected' });
      return;
    }

    const fetchForms = async (token: string) =>
      httpJson(`https://graph.facebook.com/${FB_API_VERSION}/${pageId}/leadgen_forms`, {
        params: { fields: 'id,name', access_token: token },
        timeout: 10000,
      });

    try {
      let formsRes: any;
      try {
        formsRes = await fetchForms(pageAccessToken);
      } catch (pageErr: any) {
        if (pageErr?.response?.status === 403 && userAccessToken) {
          formsRes = await fetchForms(userAccessToken);
        } else {
          throw pageErr;
        }
      }

      const forms = (formsRes.data.data || []).map((form: any) => ({
        id: form.id,
        name: form.name,
      }));

      res.json({ forms });
    } catch (err: any) {
      const fbErr = err?.response?.data?.error;
      log.error('Failed to fetch Facebook forms:', fbErr ?? err?.message ?? err);
      res.status(500).json({
        message: 'Failed to fetch forms from Facebook',
        detail: fbErr?.message,
        code: fbErr?.code,
      });
    }
  }));

  // GET /api/integrations/facebook/form-tags — read form tag rules
  app.get('/api/integrations/facebook/form-tags', requireFacebookAccess, asyncHandler(async (req: AuthedRequest, res: Response) => {
    const rulesStr = await CredentialService.getCredential(req.user.contractorId, 'facebook-leads', 'form_tag_rules');
    let rules: Record<string, string[]> = {};
    if (rulesStr) {
      try {
        rules = JSON.parse(rulesStr);
      } catch (err) {
        log.error('Failed to parse form_tag_rules:', err);
      }
    }
    res.json({ rules });
  }));

  // POST /api/integrations/facebook/form-tags — write form tag rules
  app.post('/api/integrations/facebook/form-tags', requireFacebookAccess, asyncHandler(async (req: AuthedRequest, res: Response) => {
    const rules = req.body.rules ?? req.body;
    if (typeof rules !== 'object' || rules === null || Array.isArray(rules)) {
      res.status(400).json({ message: 'rules must be an object mapping form_id to tag[]' });
      return;
    }

    await CredentialService.setCredential(
      req.user.contractorId,
      'facebook-leads',
      'form_tag_rules',
      JSON.stringify(rules)
    );

    res.json({ success: true });
  }));

  const syncLeadsSchema = z.object({
    sinceDate: z.string().datetime().optional(),
  });

  app.post('/api/integrations/facebook/sync-leads', requireFacebookAccess, asyncHandler(async (req: AuthedRequest, res: Response) => {
    const parsed = parseBody(syncLeadsSchema, req, res);
    if (!parsed) return;

    const { sinceDate } = parsed;
    const contractorId = req.user.contractorId;

    const pageId = await CredentialService.getCredential(contractorId, 'facebook-leads', 'page_id');
    const pageAccessToken = await CredentialService.getCredential(contractorId, 'facebook-leads', 'page_access_token');
    const userAccessToken = await CredentialService.getCredential(contractorId, 'facebook-leads', 'user_access_token');

    if (!pageId || !pageAccessToken) {
      res.status(400).json({ message: 'Facebook Lead Ads not connected' });
      return;
    }

    const fetchLeadgenForms = async (token: string) =>
      httpJson(`https://graph.facebook.com/${FB_API_VERSION}/${pageId}/leadgen_forms`, {
        params: { fields: 'id,name', access_token: token },
        timeout: 10000,
      });

    try {
      // Load field mappings
      const mappingsStr = await CredentialService.getCredential(contractorId, 'facebook-leads', 'field_mappings');
      let mappings: Record<string, string> = {};
      if (mappingsStr) {
        try {
          mappings = JSON.parse(mappingsStr);
        } catch (err) {
          log.error('Failed to parse field mappings:', err);
        }
      }

      // Load form tag rules
      const formTagRulesStr = await CredentialService.getCredential(contractorId, 'facebook-leads', 'form_tag_rules');
      let formTagRules: Record<string, string[]> = {};
      if (formTagRulesStr) {
        try {
          formTagRules = JSON.parse(formTagRulesStr);
        } catch (err) {
          log.error('Failed to parse form_tag_rules:', err);
        }
      }

      let formsRes: any;
      let effectiveToken = pageAccessToken;
      try {
        formsRes = await fetchLeadgenForms(pageAccessToken);
        log.info(`[sync-leads] fetched forms using page token for contractor ${contractorId}`);
      } catch (pageErr: any) {
        if (pageErr?.response?.status === 403 && userAccessToken) {
          log.warn(`[sync-leads] page token returned 403, retrying with user token for contractor ${contractorId}`);
          formsRes = await fetchLeadgenForms(userAccessToken);
          effectiveToken = userAccessToken;
          log.info(`[sync-leads] fetched forms using user token for contractor ${contractorId}`);
        } else {
          throw pageErr;
        }
      }

      const forms = formsRes.data.data || [];
      let imported = 0;
      let skipped = 0;
      let total = 0;

      for (const form of forms) {
        let after = '';
        let hasMore = true;

        while (hasMore) {
          const leadsRes: any = await httpJson(`https://graph.facebook.com/${FB_API_VERSION}/${form.id}/leads`, {
            params: {
              fields: 'field_data,ad_id,ad_name,form_id,created_time',
              access_token: effectiveToken,
              limit: 100,
              after: after || undefined,
            },
            timeout: 10000,
          });

          const leads = leadsRes.data.data || [];
          total += leads.length;

          for (const leadData of leads) {
            const createdTime = new Date(leadData.created_time);
            if (sinceDate && createdTime < new Date(sinceDate)) {
              continue;
            }

            const leadgenId = leadData.id;
            const existingLeads = await storage.getLeads(contractorId);
            const isDuplicate = existingLeads.some(l => {
              try {
                const raw = JSON.parse(l.rawPayload || '{}');
                return raw.id === leadgenId;
              } catch {
                return false;
              }
            });

            if (isDuplicate) {
              skipped++;
              continue;
            }

            const { result } = await processFacebookLead({
              contractorId,
              leadResource: leadData,
              source: 'manual-sync',
              formName: form.name,
              fieldMappings: mappings,
              formTagRules,
              skipDuplicateLeadWithinHours: 0,
              ipAddress: req.ip,
            });

            if (result.skippedDuplicateLead) {
              skipped++;
            } else {
              imported++;
            }
          }

          if (leadsRes.data.paging?.next) {
            after = leadsRes.data.paging.cursors.after;
          } else {
            hasMore = false;
          }
        }
      }

      res.json({ imported, skipped, total });
    } catch (err: any) {
      const fbErr = err?.response?.data?.error;
      log.error('Failed to sync Facebook leads:', fbErr ?? err?.message ?? err);
      res.status(500).json({
        message: 'Failed to sync leads from Facebook',
        detail: fbErr?.message,
        code: fbErr?.code,
        subcode: fbErr?.error_subcode,
      });
    }
  }));

  app.get('/api/integrations/facebook/diagnose', requireFacebookAccess, asyncHandler(async (req: AuthedRequest, res: Response) => {
    const contractorId = req.user.contractorId;
    const pageId = await CredentialService.getCredential(contractorId, 'facebook-leads', 'page_id');
    const pageAccessToken = await CredentialService.getCredential(contractorId, 'facebook-leads', 'page_access_token');
    const userAccessToken = await CredentialService.getCredential(contractorId, 'facebook-leads', 'user_access_token');

    if (!pageId || !pageAccessToken) {
      res.json({ connected: false, message: 'No Facebook credentials stored. Please reconnect.' });
      return;
    }

    const result: Record<string, any> = {
      pageId,
      hasPageToken: !!pageAccessToken,
      hasUserToken: !!userAccessToken,
    };

    // Debug token info
    const appId = process.env.FACEBOOK_APP_ID;
    const appSecret = process.env.FACEBOOK_APP_SECRET;
    if (appId && appSecret) {
      try {
        const debugRes = await httpJson(`https://graph.facebook.com/${FB_API_VERSION}/debug_token`, {
          params: {
            input_token: pageAccessToken,
            access_token: `${appId}|${appSecret}`,
          },
          timeout: 10000,
        });
        const d = debugRes.data?.data ?? {};
        result.tokenValid = d.is_valid;
        result.tokenType = d.type;
        result.grantedPermissions = (d.scopes || []);
        result.hasLeadsRetrieval = (d.scopes || []).includes('leads_retrieval');
        result.hasPagesManageMetadata = (d.scopes || []).includes('pages_manage_metadata');
        result.tokenExpiresAt = d.expires_at ? new Date(d.expires_at * 1000).toISOString() : 'never';
      } catch (e: any) {
        result.tokenDebugError = e?.response?.data?.error?.message ?? e?.message;
      }
    }

    // Test page token against leadgen_forms
    try {
      const r = await httpJson(`https://graph.facebook.com/${FB_API_VERSION}/${pageId}/leadgen_forms`, {
        params: { fields: 'id,name', limit: 1, access_token: pageAccessToken },
        timeout: 10000,
      });
      result.pageTokenWorks = true;
      result.formCount = r.data?.data?.length ?? 0;
    } catch (e: any) {
      result.pageTokenWorks = false;
      result.pageTokenError = e?.response?.data?.error ?? { message: e?.message };
    }

    // Validate user token is still alive (if stored)
    if (userAccessToken) {
      try {
        await httpJson(`https://graph.facebook.com/${FB_API_VERSION}/me`, {
          params: { fields: 'id', access_token: userAccessToken },
          timeout: 10000,
        });
        result.userTokenValid = true;
      } catch (e: any) {
        result.userTokenValid = false;
        result.userTokenError = e?.response?.data?.error?.message ?? e?.message;
      }
    } else {
      result.userTokenValid = null;
    }

    // Check webhook subscription status
    result.webhookVerifyTokenSet = !!process.env.FACEBOOK_VERIFY_TOKEN;
    try {
      const subRes = await httpJson(`https://graph.facebook.com/${FB_API_VERSION}/${pageId}/subscribed_apps`, {
        params: { access_token: pageAccessToken },
        timeout: 10000,
      });
      const apps = subRes.data?.data ?? [];
      result.webhookSubscribed = apps.some((app: any) =>
        Array.isArray(app.subscribed_fields) && app.subscribed_fields.includes('leadgen')
      );
    } catch (e: any) {
      result.webhookSubscribed = false;
      result.webhookSubscriptionError = e?.response?.data?.error?.message ?? e?.message;
    }

    // Guidance
    const guidance: string[] = [];
    if (!result.tokenValid) guidance.push('Your page access token is invalid or expired. Please reconnect Facebook.');
    if (!result.hasLeadsRetrieval) guidance.push('Missing leads_retrieval permission. Reconnect and approve all requested permissions.');
    if (!result.hasPagesManageMetadata) guidance.push('Missing pages_manage_metadata permission. Reconnect Facebook to grant this permission — it is required for webhook subscription.');
    if (!result.pageTokenWorks) {
      const code = result.pageTokenError?.code;
      if (code === 100) guidance.push('Go to Meta Business Manager → Business Settings → Lead Access, and assign your app as a CRM for this page.');
      else if (code === 200) guidance.push('Requires pages_manage_metadata permission. Reconnect Facebook to grant it, or check that your Meta account has admin access to this page.');
      else if (code === 190) guidance.push('Access token expired. Please reconnect Facebook.');
      else guidance.push('Page token cannot access leads. Check that your Facebook app is in Live mode (not Development mode) and has CRM access in Business Manager.');
    } else {
      guidance.push('Token can access lead forms. If sync still fails, try clicking Sync Now again after reconnecting Facebook.');
    }
    if (!result.hasUserToken) guidance.push('Reconnect Facebook to store a user access token (enables fallback if page token fails).');
    if (!result.webhookVerifyTokenSet) guidance.push('FACEBOOK_VERIFY_TOKEN is not set. Real-time lead delivery via webhook will not work until this is configured.');
    if (result.webhookVerifyTokenSet && result.webhookSubscribed === false) guidance.push('Page is not subscribed to leadgen webhooks. Click "Re-subscribe Webhook" to enable real-time lead delivery.');
    result.guidance = guidance;

    res.json(result);
  }));
}
