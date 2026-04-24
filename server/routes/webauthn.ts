import type { Express, Request, Response } from "express";
import { z } from "zod";
import crypto from "crypto";
import { eq, and, lt } from "drizzle-orm";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
} from "@simplewebauthn/server";
import { isoBase64URL, isoUint8Array } from "@simplewebauthn/server/helpers";

import { db } from "../db";
import {
  webauthnCredentials,
  webauthnChallenges,
} from "@shared/schema";
import { storage } from "../storage";
import {
  AuthService,
  requireAuth,
  type AuthedRequest,
} from "../auth-service";
import { asyncHandler } from "../utils/async-handler";
import { auditLog } from "../utils/audit-log";
import { logger } from "../utils/logger";
import { authLoginRateLimiter } from "../middleware/rate-limiter";

const log = logger("WebAuthnRoutes");

const RP_NAME = "HCP CRM";
const CHALLENGE_TTL_MS = 60 * 1000; // 60 seconds — generous for slow biometric prompts

/**
 * Resolve the Relying Party ID and origin from the incoming request.
 *
 * RP ID is a registrable domain that the credential is scoped to. We use the
 * request hostname so a passkey registered against the deployed domain only
 * works against that same domain. Localhost is permitted for development.
 */
function resolveRpInfo(req: Request): { rpID: string; origin: string } {
  const host = (req.headers["x-forwarded-host"] as string | undefined)?.split(",")[0]?.trim()
    || req.get("host")
    || "localhost";
  const proto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim()
    || req.protocol
    || "https";
  const rpID = host.split(":")[0]; // strip port — rpID is a hostname only
  const origin = `${proto}://${host}`;
  return { rpID, origin };
}

function deriveDeviceLabel(req: Request): string {
  const ua = req.headers["user-agent"] || "";
  let device = "Unknown device";
  let browser = "browser";
  if (/iPhone/i.test(ua)) device = "iPhone";
  else if (/iPad/i.test(ua)) device = "iPad";
  else if (/Android/i.test(ua)) device = "Android";
  else if (/Macintosh/i.test(ua)) device = "Mac";
  else if (/Windows/i.test(ua)) device = "Windows";
  else if (/Linux/i.test(ua)) device = "Linux";

  if (/CriOS|Chrome/i.test(ua)) browser = "Chrome";
  else if (/FxiOS|Firefox/i.test(ua)) browser = "Firefox";
  else if (/Edg/i.test(ua)) browser = "Edge";
  else if (/Safari/i.test(ua)) browser = "Safari";
  return `${device} (${browser})`;
}

async function purgeExpiredChallenges(): Promise<void> {
  try {
    await db.delete(webauthnChallenges).where(lt(webauthnChallenges.expiresAt, new Date()));
  } catch (err) {
    log.warn("Failed to purge expired webauthn challenges", err);
  }
}

export function registerWebAuthnRoutes(app: Express): void {
  // ──────────────────────────────────────────────────────────────────────────
  // Registration: requires an authenticated user. Creates a challenge bound to
  // the user, returns options for navigator.credentials.create().
  // ──────────────────────────────────────────────────────────────────────────
  app.post("/api/auth/webauthn/register/begin", requireAuth, asyncHandler(async (req: AuthedRequest, res: Response) => {
    const { rpID } = resolveRpInfo(req);
    const userId = req.user.userId;

    const existing = await db
      .select({ credentialId: webauthnCredentials.credentialId, transports: webauthnCredentials.transports })
      .from(webauthnCredentials)
      .where(eq(webauthnCredentials.userId, userId));

    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID,
      userName: req.user.email,
      userDisplayName: req.user.name,
      // Stable per-user identifier — required by spec, must be ≤ 64 bytes.
      userID: isoUint8Array.fromUTF8String(userId),
      attestationType: "none",
      authenticatorSelection: {
        residentKey: "required",
        requireResidentKey: true,
        userVerification: "required",
        authenticatorAttachment: "platform",
      },
      excludeCredentials: existing.map((c) => ({
        id: c.credentialId,
        transports: (c.transports ?? undefined) as AuthenticatorTransportFuture[] | undefined,
      })),
    });

    await purgeExpiredChallenges();
    // Replace any prior in-flight registration challenge for this user.
    await db.delete(webauthnChallenges).where(
      and(eq(webauthnChallenges.userId, userId), eq(webauthnChallenges.purpose, "register")),
    );
    await db.insert(webauthnChallenges).values({
      userId,
      challenge: options.challenge,
      purpose: "register",
      expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
    });

    res.json(options);
  }));

  app.post("/api/auth/webauthn/register/finish", requireAuth, asyncHandler(async (req: AuthedRequest, res: Response) => {
    const { rpID, origin } = resolveRpInfo(req);
    const userId = req.user.userId;

    const body = z.object({
      response: z.any(),
      deviceLabel: z.string().min(1).max(120).optional(),
    }).safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ message: "Invalid registration payload" });
      return;
    }

    const challengeRow = await db
      .select()
      .from(webauthnChallenges)
      .where(and(eq(webauthnChallenges.userId, userId), eq(webauthnChallenges.purpose, "register")))
      .limit(1);

    if (challengeRow.length === 0 || challengeRow[0].expiresAt < new Date()) {
      res.status(400).json({ message: "Challenge expired. Please try again." });
      return;
    }
    const expectedChallenge = challengeRow[0].challenge;

    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: body.data.response as RegistrationResponseJSON,
        expectedChallenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        requireUserVerification: true,
      });
    } catch (err) {
      log.warn("WebAuthn registration verification threw", err);
      res.status(400).json({ message: "Registration verification failed" });
      return;
    }

    if (!verification.verified || !verification.registrationInfo) {
      res.status(400).json({ message: "Registration could not be verified" });
      return;
    }

    const { credential } = verification.registrationInfo;
    const credentialIdB64 = credential.id; // already base64url
    const publicKeyB64 = isoBase64URL.fromBuffer(credential.publicKey);

    // Reject duplicate credential id (race or replay).
    const dup = await db
      .select({ id: webauthnCredentials.id })
      .from(webauthnCredentials)
      .where(eq(webauthnCredentials.credentialId, credentialIdB64))
      .limit(1);
    if (dup.length > 0) {
      res.status(409).json({ message: "This passkey is already registered." });
      return;
    }

    const label = body.data.deviceLabel?.trim() || deriveDeviceLabel(req);
    const inserted = await db.insert(webauthnCredentials).values({
      userId,
      credentialId: credentialIdB64,
      publicKey: publicKeyB64,
      counter: credential.counter ?? 0,
      transports: (credential.transports ?? []) as string[],
      deviceLabel: label,
    }).returning();

    // One-shot: consume the challenge.
    await db.delete(webauthnChallenges).where(eq(webauthnChallenges.id, challengeRow[0].id));

    await auditLog({
      contractorId: req.user.contractorId,
      userId,
      action: "webauthn_register",
      entityType: "webauthn_credential",
      entityId: inserted[0].id,
      ipAddress: req.ip ?? req.socket?.remoteAddress ?? undefined,
      userAgent: req.headers["user-agent"] ?? undefined,
    });

    res.json({
      id: inserted[0].id,
      deviceLabel: inserted[0].deviceLabel,
      createdAt: inserted[0].createdAt,
    });
  }));

  // ──────────────────────────────────────────────────────────────────────────
  // Authentication: no auth required. We don't know the user yet — the
  // credentialId in the assertion identifies them. We use a sessionId cookie
  // (returned in the response body) to correlate begin → finish.
  // ──────────────────────────────────────────────────────────────────────────
  app.post("/api/auth/webauthn/login/begin", authLoginRateLimiter, asyncHandler(async (req: Request, res: Response) => {
    const { rpID } = resolveRpInfo(req);

    const options = await generateAuthenticationOptions({
      rpID,
      userVerification: "required",
      // Empty allowCredentials → discoverable credential (resident key) flow,
      // which is what platform authenticators (Face ID / Touch ID) use.
      allowCredentials: [],
    });

    const sessionId = crypto.randomUUID();
    await purgeExpiredChallenges();
    await db.insert(webauthnChallenges).values({
      sessionId,
      challenge: options.challenge,
      purpose: "login",
      expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
    });

    res.json({ sessionId, options });
  }));

  app.post("/api/auth/webauthn/login/finish", authLoginRateLimiter, asyncHandler(async (req: Request, res: Response) => {
    const { rpID, origin } = resolveRpInfo(req);

    const body = z.object({
      sessionId: z.string().min(1),
      response: z.any(),
    }).safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ message: "Invalid login payload" });
      return;
    }
    const { sessionId, response } = body.data;
    const assertion = response as AuthenticationResponseJSON;

    const challengeRow = await db
      .select()
      .from(webauthnChallenges)
      .where(and(eq(webauthnChallenges.sessionId, sessionId), eq(webauthnChallenges.purpose, "login")))
      .limit(1);

    if (challengeRow.length === 0 || challengeRow[0].expiresAt < new Date()) {
      res.status(400).json({ message: "Sign-in challenge expired. Please try again." });
      return;
    }

    // Always consume the challenge, even on failure — single use.
    await db.delete(webauthnChallenges).where(eq(webauthnChallenges.id, challengeRow[0].id));
    const expectedChallenge = challengeRow[0].challenge;

    const credentialId = assertion.id;
    const credRow = await db
      .select()
      .from(webauthnCredentials)
      .where(eq(webauthnCredentials.credentialId, credentialId))
      .limit(1);

    if (credRow.length === 0) {
      res.status(401).json({ message: "Passkey not recognised. It may have been removed." });
      return;
    }
    const stored = credRow[0];

    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response: assertion,
        expectedChallenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        credential: {
          id: stored.credentialId,
          publicKey: isoBase64URL.toBuffer(stored.publicKey),
          counter: Number(stored.counter ?? 0),
          transports: (stored.transports ?? undefined) as AuthenticatorTransportFuture[] | undefined,
        },
        requireUserVerification: true,
      });
    } catch (err) {
      log.warn("WebAuthn authentication verification threw", err);
      res.status(401).json({ message: "Sign-in failed" });
      return;
    }

    if (!verification.verified) {
      res.status(401).json({ message: "Sign-in failed" });
      return;
    }

    const { newCounter } = verification.authenticationInfo;
    // Detect cloned authenticator: counter must move forward (or both be 0
    // for authenticators that don't implement counters, like most platform ones).
    const oldCounter = Number(stored.counter ?? 0);
    if (oldCounter > 0 && newCounter <= oldCounter) {
      log.error("WebAuthn counter regression detected — possible cloned credential", {
        credentialId, oldCounter, newCounter,
      });
      res.status(401).json({ message: "Sign-in failed" });
      return;
    }

    // Resolve user, then issue cookies exactly the same way password login does.
    const user = await storage.getUser(stored.userId);
    if (!user || !user.contractorId) {
      res.status(401).json({ message: "Account not found" });
      return;
    }

    const userContractorEntry = await storage.ensureUserContractorEntry(
      user.id,
      user.contractorId,
      user.role,
      user.canManageIntegrations || false,
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

    await db.update(webauthnCredentials)
      .set({ counter: newCounter, lastUsedAt: new Date() })
      .where(eq(webauthnCredentials.id, stored.id));

    await auditLog({
      contractorId: user.contractorId,
      userId: user.id,
      action: "login_webauthn",
      entityType: "user",
      entityId: user.id,
      ipAddress: req.ip ?? req.socket?.remoteAddress ?? undefined,
      userAgent: req.headers["user-agent"] ?? undefined,
    });

    res.json({
      user: {
        id: user.id,
        username: user.username,
        name: user.name,
        email: user.email,
        role: userContractorEntry.role,
        contractorId: user.contractorId,
      },
      message: "Login successful",
    });
  }));

  // ──────────────────────────────────────────────────────────────────────────
  // Management: list + delete credentials for the current user.
  // ──────────────────────────────────────────────────────────────────────────
  app.get("/api/auth/webauthn/credentials", requireAuth, asyncHandler(async (req: AuthedRequest, res: Response) => {
    const rows = await db
      .select({
        id: webauthnCredentials.id,
        deviceLabel: webauthnCredentials.deviceLabel,
        createdAt: webauthnCredentials.createdAt,
        lastUsedAt: webauthnCredentials.lastUsedAt,
      })
      .from(webauthnCredentials)
      .where(eq(webauthnCredentials.userId, req.user.userId));
    res.json({ credentials: rows });
  }));

  app.delete("/api/auth/webauthn/credentials/:id", requireAuth, asyncHandler(async (req: AuthedRequest, res: Response) => {
    const id = req.params.id;
    const deleted = await db
      .delete(webauthnCredentials)
      .where(and(eq(webauthnCredentials.id, id), eq(webauthnCredentials.userId, req.user.userId)))
      .returning({ id: webauthnCredentials.id });

    if (deleted.length === 0) {
      res.status(404).json({ message: "Passkey not found" });
      return;
    }

    await auditLog({
      contractorId: req.user.contractorId,
      userId: req.user.userId,
      action: "webauthn_remove",
      entityType: "webauthn_credential",
      entityId: id,
      ipAddress: req.ip ?? req.socket?.remoteAddress ?? undefined,
      userAgent: req.headers["user-agent"] ?? undefined,
    });

    res.json({ message: "Passkey removed" });
  }));
}
