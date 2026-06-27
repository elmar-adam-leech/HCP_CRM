import type { Express, Request, Response } from "express";
import { storage } from "../storage";
import { insertUserSchema, users, userContractors, passwordResetTokens, type User } from "@shared/schema";
import { db } from "../db";
import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { AuthService, requireAuth, requireAdmin, type AuthenticatedRequest } from "../auth-service";
import bcrypt from "bcrypt";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { sendGridService } from "../emails/index";
import { authLoginRateLimiter, authRegisterRateLimiter, authForgotPasswordRateLimiter, createRateLimiter } from "../middleware/rate-limiter";
import { asyncHandler } from "../utils/async-handler";
import { logger } from "../utils/logger";
import { auditLog } from "../utils/audit-log";
import { maskEmail } from "../utils/pii-redactor";
import {
  REFRESH_COOKIE_NAME,
  clearRefreshCookie,
  handleRefreshRequest,
  hashRefreshToken,
  issueRefreshToken,
  refreshTokenRateLimiter,
} from "../auth-refresh";
import { terminateUserConnections } from "../websocket";

// Per-IP/per-token brute-force defence for the refresh endpoint. The endpoint
// itself only does one indexed DB lookup, so the limit is generous, but capping
// it at 10/min materially limits credential-stuffing of stolen refresh cookies.
const authRefreshRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 10,
  keyPrefix: 'auth-refresh',
});

async function generateUniqueUsername(email: string): Promise<string> {
  const base = email.split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '_');
  let candidate = base;
  let existing = await storage.getUserByUsername(candidate);
  while (existing) {
    candidate = `${base}_${crypto.randomBytes(3).toString('hex')}`;
    existing = await storage.getUserByUsername(candidate);
  }
  return candidate;
}

const log = logger('AuthRoutes');

export function registerAuthRoutes(app: Express): void {
  // Authentication uses an httpOnly cookie (auth_token) as the sole delivery
  // mechanism for the browser SPA. The cookie is immune to XSS (JS cannot read
  // httpOnly cookies) and is sent automatically with every same-origin request.
  // API/programmatic clients should authenticate via the Authorization: Bearer
  // header — they receive a 401 and must re-authenticate to get a fresh cookie.
  app.post("/api/auth/login", authLoginRateLimiter, asyncHandler(async (req: Request, res: Response) => {
    const { email, password } = req.body;
    if (!email || !password) {
      res.status(400).json({ message: "Email and password are required" });
      return;
    }

    const user = await storage.verifyPasswordByEmail(email, password);
    if (!user) {
      const failedUser = await storage.getUserByEmail(email);
      await auditLog({
        contractorId: failedUser?.contractorId ?? '',
        userId: failedUser?.id ?? null,
        action: 'login_failed',
        entityType: 'user',
        ipAddress: req.ip ?? req.socket?.remoteAddress ?? undefined,
        userAgent: req.headers['user-agent'] ?? undefined,
      });
      res.status(401).json({ message: "Invalid credentials" });
      return;
    }

    if (!user.contractorId) {
      res.status(500).json({ message: "User account has no contractor association" });
      return;
    }

    // Fetch fresh user record to check MFA status (verifyPasswordByEmail may not include mfaEnabled)
    const [freshUser] = await db.select({
      mfaEnabled: users.mfaEnabled,
    }).from(users).where(eq(users.id, user.id)).limit(1);

    if (freshUser?.mfaEnabled) {
      // Issue a short-lived pending token for MFA step 2
      const pendingToken = jwt.sign(
        {
          purpose: 'mfa_pending',
          userId: user.id,
          contractorId: user.contractorId,
        },
        process.env.JWT_SECRET!,
        { expiresIn: '5m' }
      );
      res.json({ status: 'mfa_required', pendingToken });
      return;
    }

    const userContractorEntry = await storage.ensureUserContractorEntry(
      user.id,
      user.contractorId,
      user.role,
      user.canManageIntegrations || false
    );

    const token = AuthService.generateToken({
      id: user.id,
      username: user.username,
      name: user.name,
      email: user.email,
      role: userContractorEntry.role,
      contractorId: user.contractorId,
      canManageIntegrations: userContractorEntry.canManageIntegrations ?? user.canManageIntegrations ?? false,
      allowedIntegrations: userContractorEntry.allowedIntegrations ?? null,
      tokenVersion: user.tokenVersion ?? 1,
    });

    AuthService.setLoginCookie(res, token);

    // Issue a long-lived refresh token alongside the short-lived auth cookie.
    // PWA users on iOS routinely lose the auth cookie via Safari's tracking
    // protection / memory eviction; the refresh cookie survives those drops
    // and lets the client silently re-mint a session via /api/auth/refresh.
    // The raw token is also returned in the response body so the client can
    // mirror it into IndexedDB as a durable fallback for when iOS evicts the
    // refresh cookie itself (task #720).
    const rawRefresh = await issueRefreshToken(req, res, {
      userId: user.id,
      contractorId: user.contractorId,
    });

    await auditLog({
      contractorId: user.contractorId!,
      userId: user.id,
      action: 'login',
      entityType: 'user',
      entityId: user.id,
      ipAddress: req.ip ?? req.socket?.remoteAddress ?? undefined,
      userAgent: req.headers['user-agent'] ?? undefined,
    });

    res.json({
      user: {
        id: user.id,
        username: user.username,
        name: user.name,
        email: user.email,
        role: userContractorEntry.role,
        // SAFE: verifyPassword returns only users that have an active contractorId
        // via the login flow; a null contractorId would have failed the DB query above.
        contractorId: user.contractorId!
      },
      refreshToken: rawRefresh,
      // task #737: mirror the raw JWT in the response body so the SPA can
      // persist it to localStorage + IndexedDB for the cookieless bearer-token
      // fallback path. Cookies remain the default; this is a backstop for
      // installed PWAs (iOS Safari) where the auth_token cookie is evicted.
      authToken: token,
      message: "Login successful"
    });
  }));

  app.post("/api/auth/register", authRegisterRateLimiter, asyncHandler(async (req: Request, res: Response) => {
    const { contractorName, ...userData } = req.body;

    delete userData.role;

    if (userData.contractorId) {
      res.status(400).json({
        message: "Direct contractor assignment not allowed. Please request an invitation from your administrator."
      });
      return;
    }

    if (!contractorName) {
      res.status(400).json({ message: "Company name is required" });
      return;
    }

    const domain = contractorName.toLowerCase().replace(/[^a-z0-9]/g, '-');

    const existingContractor = await storage.getContractorByDomain(domain);
    if (existingContractor) {
      res.status(400).json({
        message: "Company already exists. Please contact your administrator for an invitation."
      });
      return;
    }

    const userByEmail = userData.email ? await storage.getUserByEmail(userData.email) : undefined;

    const existingUser = userByEmail || null;
    const userRole: 'user' = 'user';

    if (existingUser) {
      if (!userData.password) {
        res.status(400).json({
          message: "Password is required to add a new company to your existing account."
        });
        return;
      }

      const verifiedUser = await storage.verifyPassword(existingUser.id, userData.password);
      if (!verifiedUser) {
        res.status(401).json({
          message: "Incorrect password for the account associated with this email. Please enter your existing account password."
        });
        return;
      }
    } else {
      // ZodError from .parse() bubbles up to the global error middleware → 400 response
      insertUserSchema.parse({
        ...userData,
        username: 'validation-only',
        contractorId: 'validation-only',
        role: userRole,
      });
    }

    const newContractor = await storage.createContractor({ name: contractorName, domain });
    const contractorId = newContractor.id;

    let user: User;

    if (existingUser) {
      user = existingUser;

      const existingMembership = await storage.getUserContractor(user.id, contractorId);
      if (existingMembership) {
        res.status(400).json({ message: "You are already a member of this company." });
        return;
      }

      await storage.addUserToContractor({
        userId: user.id,
        contractorId,
        role: userRole,
        canManageIntegrations: (userRole as string) === 'admin' || (userRole as string) === 'super_admin',
      });

      log.info(`Existing user ${maskEmail(user.email)} added to new contractor ${contractorName}`);
    } else {
      const generatedUsername = await generateUniqueUsername(userData.email);
      const parsedUserData = insertUserSchema.parse({
        ...userData,
        username: generatedUsername,
        contractorId,
        role: userRole,
      });

      user = await storage.createUser(parsedUserData);

      if (!user.contractorId) {
        res.status(500).json({ message: "User registration failed - no contractor assigned" });
        return;
      }

      await storage.addUserToContractor({
        userId: user.id,
        contractorId: user.contractorId,
        role: userRole,
        canManageIntegrations: (userRole as string) === 'admin' || (userRole as string) === 'super_admin',
      });

      try {
        await sendGridService.sendWelcomeEmail(user.email, user.name);
      } catch (emailError) {
        log.error('Failed to send welcome email', emailError);
      }

      log.info(`New user ${maskEmail(user.email)} created and added to contractor ${contractorName}`);
    }

    const token = AuthService.generateToken({
      id: user.id,
      username: user.username,
      name: user.name,
      email: user.email,
      role: userRole,
      contractorId,
      tokenVersion: user.tokenVersion ?? 1,
    });

    AuthService.setLoginCookie(res, token);

    res.status(201).json({
      user: {
        id: user.id,
        username: user.username,
        name: user.name,
        email: user.email,
        role: userRole,
        contractorId
      },
      message: existingUser ? "Successfully joined new company" : "User registered successfully"
    });

  }));

  app.post("/api/auth/forgot-password", authForgotPasswordRateLimiter, asyncHandler(async (req: Request, res: Response) => {
    const { email } = req.body;

    if (!email) {
      res.status(400).json({ message: "Email is required" });
      return;
    }

    const genericResponse = { message: "If that email is registered, you will receive a reset link shortly" };

    const user = await storage.getUserByEmail(email);
    if (!user) {
      res.json(genericResponse);
      return;
    }

    try {
      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

      // Delete any existing unused reset tokens for this user before issuing
      // a fresh one. This ensures only the most recently issued link is valid,
      // preventing parallel reset links from accumulating independently usable tokens.
      await db.delete(passwordResetTokens)
        .where(and(
          eq(passwordResetTokens.userId, user.id),
          isNull(passwordResetTokens.usedAt),
        ));

      await db.insert(passwordResetTokens).values({
        userId: user.id,
        token,
        expiresAt,
      });

      const baseUrl = `${req.protocol}://${req.get('host')}`;
      await sendGridService.sendPasswordResetEmail(user.email, user.name, token, baseUrl);
    } catch (err) {
      log.error('Failed to send password reset email', err);
    }

    res.json(genericResponse);
  }));

  app.post("/api/auth/reset-password", authForgotPasswordRateLimiter, asyncHandler(async (req: Request, res: Response) => {
    const { token, newPassword } = req.body;

    if (!token || !newPassword) {
      res.status(400).json({ message: "Token and new password are required" });
      return;
    }

    if (newPassword.length < 8) {
      res.status(400).json({ message: "Password must be at least 8 characters long" });
      return;
    }

    const tokenResult = await db
      .select()
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.token, token))
      .limit(1);

    if (tokenResult.length === 0) {
      res.status(400).json({ message: "Invalid or expired reset token" });
      return;
    }

    const resetTokenRecord = tokenResult[0];

    if (new Date() > resetTokenRecord.expiresAt) {
      res.status(400).json({ message: "Reset token has expired" });
      return;
    }

    if (resetTokenRecord.usedAt) {
      res.status(400).json({ message: "Reset token has already been used" });
      return;
    }

    const hashedPassword = await bcrypt.hash(newPassword, 12);

    // Update password, increment tokenVersion, and invalidate ALL unused reset
    // tokens for this user atomically.
    // - tokenVersion increment immediately invalidates all existing JWT sessions
    //   so an attacker holding a stolen cookie can no longer use it after reset.
    // - Marking every unused reset token (not just the current one) as used
    //   ensures that parallel reset links issued before this redemption cannot
    //   be replayed to retake the account after the password has been changed.
    await Promise.all([
      db.update(users)
        .set({ password: hashedPassword, tokenVersion: sql`token_version + 1` })
        .where(eq(users.id, resetTokenRecord.userId)),
      db.update(passwordResetTokens)
        .set({ usedAt: new Date() })
        .where(and(
          eq(passwordResetTokens.userId, resetTokenRecord.userId),
          isNull(passwordResetTokens.usedAt),
        )),
    ]);

    const userResult = await db.select().from(users).where(eq(users.id, resetTokenRecord.userId)).limit(1);
    if (userResult.length > 0) {
      await sendGridService.sendPasswordChangedEmail(userResult[0].email, userResult[0].name);
    }

    res.json({ message: "Password reset successful" });
  }));

  app.post("/api/auth/logout", requireAuth, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    // SAFE: `requireAuth` middleware rejects the request before reaching here if
    // `req.user` is undefined; the `!` assertion is redundant but kept for explicitness.
    const user = req.user!;
    await AuthService.revokeToken(user);
    // Best-effort: revoke the refresh token row backing this device's session.
    // Prefer the cookie, but accept a body-supplied token as a fallback for
    // PWA installs whose refresh cookie has been evicted by iOS Safari but
    // who still have a copy in IndexedDB (task #720). Both paths revoke by
    // hash so neither receives a weaker security treatment.
    const cookieRefresh = req.cookies?.[REFRESH_COOKIE_NAME] as string | undefined;
    const bodyRefresh =
      typeof (req.body as { refreshToken?: unknown } | undefined)?.refreshToken === "string"
        ? ((req.body as { refreshToken: string }).refreshToken)
        : undefined;
    const rawRefresh = cookieRefresh || bodyRefresh;
    if (rawRefresh) {
      await storage.revokeRefreshTokenByHash(hashRefreshToken(rawRefresh));
    }
    await auditLog(req, 'logout', 'user', user.userId);
    // Immediately close any open WebSocket connections for this user so that
    // a stolen token cannot keep a real-time data channel alive after logout.
    terminateUserConnections(user.userId);
    res.clearCookie('auth_token', { path: '/' });
    clearRefreshCookie(res);
    res.json({ message: "Logged out successfully" });
  }));

  app.post("/api/auth/logout-all", asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    // SAFE: global `/api` auth middleware guarantees `req.user` is set before reaching here.
    const user = req.user!;
    await AuthService.revokeToken(user);
    await db.update(users)
      .set({ tokenVersion: (user.tokenVersion ?? 1) + 1 })
      .where(eq(users.id, user.userId));
    // Revoke every refresh token for this user across every device.
    await storage.revokeRefreshTokensForUser(user.userId);
    // Immediately close any open WebSocket connections for this user so that
    // stolen tokens cannot keep real-time data channels alive after a
    // sign-out-all-devices action.
    terminateUserConnections(user.userId);
    res.clearCookie('auth_token', { path: '/' });
    clearRefreshCookie(res);
    res.json({ message: "All sessions signed out" });
  }));

  app.post("/api/auth/logout-company", requireAdmin, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    // SAFE: global `/api` auth middleware guarantees `req.user` is set before reaching here.
    const { contractorId } = req.user!;
    const companyMembers = await db
      .select({ userId: userContractors.userId })
      .from(userContractors)
      .where(eq(userContractors.contractorId, contractorId));

    if (companyMembers.length === 0) {
      res.clearCookie('auth_token', { path: '/' });
      clearRefreshCookie(res);
      res.json({ message: "No users found", count: 0 });
      return;
    }

    const userIds = companyMembers.map((m) => m.userId);
    await db.update(users)
      .set({ tokenVersion: sql`token_version + 1` })
      .where(inArray(users.id, userIds));
    // Revoke every refresh token tied to this contractor — covers PWA cookies
    // belonging to all members of the company.
    await storage.revokeRefreshTokensForContractor(contractorId);

    res.clearCookie('auth_token', { path: '/' });
    clearRefreshCookie(res);
    res.json({ message: `All sessions signed out for ${userIds.length} user(s)`, count: userIds.length });
  }));

  // POST /api/auth/refresh — silent re-issue of the auth_token cookie using a
  // long-lived refresh_token cookie. Designed to be called by the client when
  // any /api/* request returns 401 (typically because iOS Safari evicted the
  // auth cookie from a PWA's storage partition).
  //
  // Logic lives in `handleRefreshRequest` so it can be unit-tested directly
  // with mocked storage. See server/auth-refresh.ts for the full state-machine
  // documentation (handles missing cookie, revoked, expired, rotated-within-
  // grace, rotated-past-grace, and active cases).
  //
  // Two rate limiters are stacked: per-IP (10/min) caps brute force from a
  // single source, and per-refresh-token (5/min) caps brute force against any
  // single token even if the attacker rotates IPs.
  app.post(
    "/api/auth/refresh",
    authRefreshRateLimiter,
    refreshTokenRateLimiter,
    asyncHandler(handleRefreshRequest),
  );

  // Tiny telemetry sink for IDB-write failures from the SPA. The client posts
  // `{ stage, errorName }` here whenever `persistRefreshTokenFromResponse` can
  // not write the freshly-issued refresh token into IndexedDB — the silent
  // failure mode that task #734 exists to detect. Strictly NO token, NO PII.
  // Rate-limited to 5/min/IP so a noisy device can't flood the logs.
  const persistFailedRateLimiter = createRateLimiter({
    windowMs: 60 * 1000,
    maxRequests: 5,
    keyPrefix: 'auth-persist-failed',
  });
  const persistFailedLog = logger('AuthPersist');
  app.post(
    "/api/auth/persist-failed",
    persistFailedRateLimiter,
    asyncHandler(async (req: Request, res: Response) => {
      const body = (req.body ?? {}) as { stage?: unknown; errorName?: unknown };
      const stage = typeof body.stage === "string" ? body.stage.slice(0, 32) : "unknown";
      const errorName = typeof body.errorName === "string" ? body.errorName.slice(0, 64) : "unknown";
      persistFailedLog.warn("idb_persist_failed", {
        stage,
        errorName,
        ip: req.ip ?? req.socket?.remoteAddress ?? null,
        userAgent: req.headers["user-agent"] ?? null,
      });
      res.status(204).end();
    }),
  );

  // task #737: tiny capability probe used by the SPA on first boot if both
  // the auth_token cookie AND IndexedDB / localStorage are empty. Returning
  // `{ supportsBearer: true }` lets the client log a one-off `bearer_probe`
  // outcome so we can see how often the bearer path is the only thing keeping
  // an installed PWA's session alive. Rate-limited to 10/min/IP — this
  // endpoint never reads or writes any user state, so the cap is purely to
  // bound the log volume from a misbehaving client.
  const storageProbeRateLimiter = createRateLimiter({
    windowMs: 60 * 1000,
    maxRequests: 10,
    keyPrefix: 'auth-storage-probe',
  });
  const storageProbeLog = logger('AuthStorageProbe');
  app.post(
    "/api/auth/storage-probe",
    storageProbeRateLimiter,
    asyncHandler(async (req: Request, res: Response) => {
      // task #738: the boot-auth helper reports which resolution branch it
      // ended up on (cookie / bearer / passkey-conditional / passkey-explicit /
      // password / login-redirect). The field is optional and tolerated as
      // any short string so the production log can pivot fallback usage by
      // boot outcome rather than just "had nothing locally".
      const bootResolution = typeof req.body?.bootResolution === 'string'
        && req.body.bootResolution.length > 0
        && req.body.bootResolution.length <= 40
        ? req.body.bootResolution
        : null;
      storageProbeLog.info('bearer_probe', {
        ip: req.ip ?? req.socket?.remoteAddress ?? null,
        userAgent: req.headers['user-agent'] ?? null,
        bootResolution,
      });
      res.json({ supportsBearer: true });
    }),
  );

  app.get("/api/auth/me", asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    if (!req.user) {
      res.status(401).json({ message: "Not authenticated" });
      return;
    }

    // Intentional dynamic import: avoids the cache module pulling in the full
    // storage layer at startup, which can create a circular dep at boot time.
    const {
      getContractorCached,
      getUserSupplementalCached,
      getEnabledIntegrationsCached,
      getUserContractorCached,
    } = await import('../services/cache');

    const [supplemental, enabledIntegrations, userContractor, contractor] = await Promise.all([
      getUserSupplementalCached(req.user.userId),
      getEnabledIntegrationsCached(req.user.contractorId),
      getUserContractorCached(req.user.userId, req.user.contractorId),
      getContractorCached(req.user.contractorId),
    ]);

    const { sendJsonWithEtag } = await import('../utils/etag');
    sendJsonWithEtag(req, res, {
      user: {
        id: req.user.userId,
        username: req.user.username,
        name: req.user.name,
        email: req.user.email,
        role: req.user.role,
        contractorId: req.user.contractorId,
        contractorName: contractor?.name || '',
        canManageIntegrations: req.user.canManageIntegrations,
        allowedIntegrations: req.user.allowedIntegrations ?? null,
        dialpadDefaultNumber: supplemental?.dialpadDefaultNumber || undefined,
        gmailConnected: supplemental?.gmailConnected || false,
        gmailEmail: supplemental?.gmailEmail || undefined,
        hasActiveCompanyIntegrations: enabledIntegrations.length > 0,
        callPreference: userContractor?.callPreference || 'integration',
        // task #832: per-user "phone to ring" for the Twilio bridge call,
        // sourced from the active user_contractors membership so switching
        // companies reflects that company's value.
        twilioPhoneToRing: userContractor?.twilioPhoneToRing ?? null,
        // task #738: surface passkey-enrollment-prompt state so the SPA can
        // show the post-first-login dialog at most once per user (per the
        // dismiss timestamp), and gate it on the user actually having zero
        // passkeys today.
        passkeyPromptDismissedAt: supplemental?.passkeyPromptDismissedAt ?? null,
        passkeyCount: supplemental?.passkeyCount ?? 0,
      }
    });
  }));
}
