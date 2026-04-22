import type { Express, Request, Response } from "express";
import { storage } from "../storage";
import { users } from "@shared/schema";
import { db } from "../db";
import { eq } from "drizzle-orm";
import { gmailService } from "../gmail-service";
import { AuthService, type AuthedRequest } from "../auth-service";
type AuthenticatedRequest = AuthedRequest;
import { asyncHandler } from "../utils/async-handler";
import { syncScheduler } from "../sync-scheduler";
import { logger } from "../utils/logger";
import { maskEmail } from "../utils/pii-redactor";

const log = logger('OAuthRoutes');

export function registerOAuthRoutes(app: Express): void {
  app.get("/api/settings/shared-email", asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) { res.status(401).json({ message: "Not authenticated" }); return; }
    const role = req.user.role;
    const isAdmin = role === 'admin' || role === 'super_admin' || role === 'manager';
    if (!isAdmin && !req.user.canManageIntegrations) {
      res.status(403).json({ message: "Only managers and admins can view the shared company email settings" });
      return;
    }
    const account = await storage.getSharedEmailAccount(req.user.contractorId);
    if (!account) { res.json({ connected: false }); return; }
    let connectedByName: string | undefined;
    if (account.connectedByUserId) {
      const connectedByUser = await storage.getUser(account.connectedByUserId);
      if (connectedByUser?.contractorId === req.user.contractorId) {
        connectedByName = connectedByUser.name;
      }
    }
    res.json({
      connected: true,
      email: account.email,
      displayName: account.displayName,
      connectedByUserId: account.connectedByUserId,
      connectedByName,
      createdAt: account.createdAt,
      lastSyncAt: account.lastSyncAt,
    });
  }));

  app.post("/api/settings/shared-email/sync", asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) { res.status(401).json({ message: "Not authenticated" }); return; }
    const role = req.user.role;
    const isAdmin = role === 'admin' || role === 'super_admin' || role === 'manager';
    if (!isAdmin && !req.user.canManageIntegrations) {
      res.status(403).json({ message: "Only managers and admins can trigger a shared email sync" });
      return;
    }
    const contractorId = req.user.contractorId;
    const account = await storage.getSharedEmailAccount(contractorId);
    if (!account) { res.status(404).json({ message: "Shared email is not connected" }); return; }
    // Self-heal: if a tenant connected the shared inbox before this feature
    // shipped, the gmail integration row / sync schedule may not exist. Without
    // these, performSync() would silently no-op. Ensure both are in place.
    const enabled = await storage.isIntegrationEnabled(contractorId, 'gmail');
    if (!enabled) {
      await storage.enableTenantIntegration(contractorId, 'gmail', account.connectedByUserId ?? undefined);
      const { invalidateContractorCache } = await import('../services/cache');
      invalidateContractorCache(contractorId);
    }
    const schedule = await storage.getSyncSchedule(contractorId, 'gmail');
    if (!schedule) {
      await syncScheduler.scheduleSync(contractorId, 'gmail', 'every-5-minutes');
    }
    // Trigger immediate gmail sync; the scheduler's in-memory activeSyncs lock
    // ensures concurrent clicks/scheduler ticks no-op safely.
    syncScheduler.triggerSync(contractorId, 'gmail').catch(err => {
      log.error('Manual shared-email sync failed', { message: err?.message });
    });
    res.json({ message: "Sync triggered" });
  }));

  app.get("/api/settings/shared-email/oauth/start", asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) { res.status(401).json({ message: "Not authenticated" }); return; }
    const role = req.user.role;
    const isAdmin = role === 'admin' || role === 'super_admin' || role === 'manager';
    if (!isAdmin && !req.user.canManageIntegrations) {
      res.status(403).json({ message: "Only managers and admins can connect the shared company email" });
      return;
    }
    if (!gmailService.isConfigured()) {
      res.status(500).json({ message: "Gmail integration not configured. Please set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET environment variables." });
      return;
    }
    try { gmailService.validateEncryptionKey(); } catch (error) {
      res.status(500).json({ message: error instanceof Error ? error.message : "Encryption key not configured" });
      return;
    }
    const host = req.get('host');
    if (!host) { res.status(400).json({ message: "Unable to determine request host" }); return; }
    if (!gmailService.validateHost(host)) {
      res.status(403).json({ message: "Invalid domain. OAuth is only allowed from approved domains." });
      return;
    }
    const stateUserId = `shared_email:${req.user.contractorId}:${req.user.userId}`;
    const authUrl = await gmailService.generateAuthUrl(stateUserId, host);
    if (!authUrl.startsWith('https://accounts.google.com/')) {
      res.status(500).json({ message: "OAuth provider returned an unexpected redirect URL" });
      return;
    }
    res.json({ authUrl });
  }));

  app.delete("/api/settings/shared-email", asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) { res.status(401).json({ message: "Not authenticated" }); return; }
    const role = req.user.role;
    const isAdmin = role === 'admin' || role === 'super_admin' || role === 'manager';
    if (!isAdmin && !req.user.canManageIntegrations) {
      res.status(403).json({ message: "Only managers and admins can disconnect the shared company email" });
      return;
    }
    await storage.deleteSharedEmailAccount(req.user.contractorId);
    res.json({ message: "Shared company email disconnected successfully" });
  }));

  app.get("/api/oauth/gmail/connect", asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) {
      res.status(401).json({ message: "Not authenticated" });
      return;
    }

    if (!gmailService.isConfigured()) {
      res.status(500).json({
        message: "Gmail integration not configured. Please set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET environment variables."
      });
      return;
    }

    try {
      gmailService.validateEncryptionKey();
    } catch (error) {
      res.status(500).json({
        message: error instanceof Error ? error.message : "Encryption key not configured"
      });
      return;
    }

    const host = req.get('host');
    if (!host) {
      res.status(400).json({ message: "Unable to determine request host" });
      return;
    }

    if (!gmailService.validateHost(host)) {
      log.error(`Invalid host: ${host}`);
      res.status(403).json({
        message: `Invalid domain. OAuth is only allowed from approved domains.`
      });
      return;
    }

    log.info(`Initiating OAuth for user ${req.user.userId} from host ${host}`);

    const authUrl = await gmailService.generateAuthUrl(req.user.userId, host);

    if (!authUrl.startsWith('https://accounts.google.com/')) {
      log.error(`Unexpected OAuth redirect URL generated: ${authUrl}`);
      res.status(500).json({ message: "OAuth provider returned an unexpected redirect URL" });
      return;
    }

    res.json({ authUrl });
  }));

  app.get("/api/oauth/gmail/callback", asyncHandler(async (req: Request, res: Response) => {
    const { code, state } = req.query;

    if (!code || !state) {
      res.status(400).send('Missing authorization code or state parameter');
      return;
    }

    const stateData = await gmailService.getStateData(state as string);
    if (!stateData) {
      log.error('Invalid or expired state token');
      res.status(403).send('Invalid or expired state parameter');
      return;
    }

    const { userId, redirectHost } = stateData;
    const protocol = redirectHost.startsWith('localhost') ? 'http' : 'https';

    if (userId.startsWith('shared_email:')) {
      const parts = userId.split(':');
      if (parts.length < 3 || !parts[1]) {
        log.error(`Malformed shared_email state token: ${userId}`);
        res.redirect(`${protocol}://${redirectHost}/settings?tab=integrations&shared_email=error&reason=invalid_state`);
        return;
      }
      const contractorId = parts[1];
      const initiatingUserId = parts[2] || null;
      log.info(`Processing shared email callback for contractor ${contractorId}`);

      try {
        const result = await gmailService.exchangeCodeForTokens(code as string, redirectHost);
        if (!result.refreshToken) {
          res.redirect(`${protocol}://${redirectHost}/settings?tab=integrations&shared_email=error&reason=no_refresh_token`);
          return;
        }
        const contractor = await storage.getContractor(contractorId);
        await storage.upsertSharedEmailAccount(contractorId, {
          email: result.email,
          displayName: contractor?.name || undefined,
          gmailRefreshToken: result.refreshToken,
          connectedByUserId: initiatingUserId || undefined,
        });
        // Ensure the gmail sync scheduler runs for tenants that have ONLY a
        // shared inbox (no per-user Gmail). Safe to call repeatedly — both
        // enable and scheduleSync upsert.
        await storage.enableTenantIntegration(contractorId, 'gmail', initiatingUserId ?? undefined);
        {
          const { invalidateContractorCache } = await import('../services/cache');
          invalidateContractorCache(contractorId);
        }
        await syncScheduler.onIntegrationEnabled(contractorId, 'gmail');
        log.info(`Shared company email connected for contractor ${contractorId}: ${maskEmail(result.email)}`);
        res.redirect(`${protocol}://${redirectHost}/settings?tab=integrations&shared_email=success`);
      } catch (error) {
        log.error('Shared email OAuth callback error:', error);
        res.redirect(`${protocol}://${redirectHost}/settings?tab=integrations&shared_email=error`);
      }
      return;
    }

    if (userId.startsWith('lead_capture:')) {
      const parts = userId.split(':');
      if (parts.length < 2 || !parts[1]) {
        log.error(`Malformed lead_capture state token: ${userId}`);
        res.redirect(`${protocol}://${redirectHost}/settings?tab=integrations&lead_capture=error&reason=invalid_state`);
        return;
      }
      const contractorId = parts[1];
      const initiatingUserId = parts.length >= 3 ? parts[2] : null;
      log.info(`Processing lead capture callback for contractor ${contractorId}`);

      try {
        const result = await gmailService.exchangeCodeForTokens(code as string, redirectHost);
        if (!result.refreshToken) {
          res.redirect(`${protocol}://${redirectHost}/settings?tab=integrations&lead_capture=error&reason=no_refresh_token`);
          return;
        }
        await storage.upsertLeadCaptureInbox({
          contractorId,
          emailAddress: result.email,
          gmailRefreshToken: result.refreshToken,
          isActive: true,
          spamFilterEnabled: false,
        });
        await storage.enableTenantIntegration(contractorId, 'lead-capture', initiatingUserId ?? undefined);
        {
          const { invalidateContractorCache } = await import('../services/cache');
          invalidateContractorCache(contractorId);
        }
        log.info(`[OAuthRoutes] INFO lead-capture integration enabled for contractor ${contractorId} by user ${initiatingUserId}`);
        await syncScheduler.onIntegrationEnabled(contractorId, 'lead-capture');
        log.info(`Lead capture inbox connected for contractor ${contractorId}: ${maskEmail(result.email)}`);
        res.redirect(`${protocol}://${redirectHost}/settings?tab=integrations&lead_capture=success`);
      } catch (error) {
        log.error('Lead capture OAuth callback error:', error);
        res.redirect(`${protocol}://${redirectHost}/settings?tab=integrations&lead_capture=error`);
      }
      return;
    }

    const user = await storage.getUser(userId);
    if (!user) {
      res.status(404).send('User not found');
      return;
    }

    log.info(`Processing callback for user ${userId}, will redirect to ${redirectHost}`);

    const result = await gmailService.exchangeCodeForTokens(code as string, redirectHost);

    if (!result.refreshToken) {
      log.error(`No refresh token received for user ${userId}`);
      res.redirect(`${protocol}://${redirectHost}/settings?gmail=error&reason=no_refresh_token`);
      return;
    }

    const userForContractor = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    const contractorId = userForContractor[0]?.contractorId;

    await db.update(users)
      .set({
        gmailConnected: true,
        gmailRefreshToken: result.refreshToken,
        gmailEmail: result.email,
      })
      .where(eq(users.id, userId));

    log.info(`User ${userId} successfully connected Gmail account`);

    if (contractorId) {
      await syncScheduler.onIntegrationEnabled(contractorId, 'gmail');
      log.info(`Enabled automatic email syncing for contractor ${contractorId}`);
      await storage.enableTenantIntegration(contractorId, 'gmail', userId);
      log.info(`Recorded gmail integration for contractor ${contractorId}`);
      const { invalidateContractorCache } = await import('../services/cache');
      invalidateContractorCache(contractorId);
    }

    const { invalidateUserCache } = await import('../services/cache');
    invalidateUserCache(userId);

    res.redirect(`${protocol}://${redirectHost}/settings?gmail=connected`);
  }));

  app.post("/api/oauth/gmail/disconnect", asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) {
      res.status(401).json({ message: "Not authenticated" });
      return;
    }

    await db.update(users)
      .set({
        gmailConnected: false,
        gmailRefreshToken: null,
        gmailEmail: null,
        gmailLastSyncAt: null,
        gmailSyncHistoryId: null,
      })
      .where(eq(users.id, req.user.userId));

    log.info(`User ${req.user.userId} disconnected Gmail`);

    const { invalidateUserCache } = await import('../services/cache');
    invalidateUserCache(req.user.userId);

    res.json({ message: "Gmail disconnected successfully" });
  }));

  app.get("/api/user/contractors", asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { getUserContractorsWithDetailsCached } = await import('../services/cache');
    const contractorsWithDetails = await getUserContractorsWithDetailsCached(req.user.userId);
    res.json(contractorsWithDetails);
  }));

  app.post("/api/user/switch-contractor", asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { contractorId } = req.body;

    if (!contractorId) {
      res.status(400).json({ message: "Contractor ID is required" });
      return;
    }

    const updatedUser = await storage.switchContractor(req.user.userId, contractorId);

    if (!updatedUser) {
      res.status(404).json({ message: "User or contractor not found" });
      return;
    }

    const userContractor = await storage.getUserContractor(req.user.userId, contractorId);
    if (!userContractor) {
      res.status(403).json({ message: "Access denied to this contractor" });
      return;
    }

    const newToken = AuthService.generateToken({
      id: updatedUser.id,
      username: updatedUser.username,
      name: updatedUser.name,
      email: updatedUser.email,
      role: userContractor.role,
      contractorId: contractorId,
      canManageIntegrations: userContractor.canManageIntegrations || false,
      allowedIntegrations: userContractor.allowedIntegrations ?? null,
      tokenVersion: updatedUser.tokenVersion ?? 1,
    });

    res.cookie('auth_token', newToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: '/',
    });

    const { invalidateUserCache } = await import('../services/cache');
    invalidateUserCache(req.user.userId);

    res.json({
      message: "Contractor switched successfully",
      contractorId: updatedUser.contractorId,
      token: newToken
    });
  }));
}
