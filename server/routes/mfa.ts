import type { Express, Response } from "express";
import { db } from "../db";
import { users } from "@shared/schema";
import { eq } from "drizzle-orm";
import { requireAuth, type AuthedRequest } from "../auth-service";
import { encryptSecret, decryptSecret } from "../utils/crypto";
import { auditLog } from "../utils/audit-log";
import { asyncHandler } from "../utils/async-handler";
import { createRateLimiter } from "../middleware/rate-limiter";
import bcrypt from "bcrypt";
import crypto from "crypto";
import * as OTPAuth from "otpauth";
import QRCode from "qrcode";

const mfaVerifyRateLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000, // 15 minutes
  maxRequests: 5,
  keyPrefix: 'mfa-verify',
});

function generateRecoveryCodes(count = 8): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    codes.push(crypto.randomBytes(6).toString('base64url').slice(0, 10).toUpperCase());
  }
  return codes;
}

export function registerMFARoutes(app: Express): void {

  // GET /api/mfa/status — check if MFA is enabled for current user
  app.get("/api/mfa/status", requireAuth, asyncHandler(async (req: AuthedRequest, res: Response) => {
    const [user] = await db.select({
      mfaEnabled: users.mfaEnabled,
    }).from(users).where(eq(users.id, req.user.userId)).limit(1);

    if (!user) {
      res.status(404).json({ message: "User not found" });
      return;
    }

    res.json({ mfaEnabled: user.mfaEnabled });
  }));

  // POST /api/mfa/setup — generate TOTP secret + QR code (does NOT enable MFA yet)
  app.post("/api/mfa/setup", requireAuth, asyncHandler(async (req: AuthedRequest, res: Response) => {
    const [user] = await db.select().from(users).where(eq(users.id, req.user.userId)).limit(1);
    if (!user) {
      res.status(404).json({ message: "User not found" });
      return;
    }

    if (user.mfaEnabled) {
      res.status(400).json({ message: "MFA is already enabled. Disable it first." });
      return;
    }

    // Generate a new TOTP secret
    const secret = new OTPAuth.Secret({ size: 20 });
    const totp = new OTPAuth.TOTP({
      issuer: "CRM",
      label: user.email,
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      secret,
    });

    // Encrypt and store the secret (pending — MFA not yet enabled)
    const encryptedSecret = encryptSecret(secret.base32);
    await db.update(users)
      .set({ mfaSecretEncrypted: encryptedSecret })
      .where(eq(users.id, user.id));

    // Generate QR code
    const otpUri = totp.toString();
    const qrDataUrl = await QRCode.toDataURL(otpUri, { width: 256, margin: 2 });

    res.json({
      qrDataUrl,
      manualEntrySecret: secret.base32,
    });
  }));

  // POST /api/mfa/confirm — verify the first TOTP code and activate MFA
  app.post("/api/mfa/confirm", requireAuth, mfaVerifyRateLimiter, asyncHandler(async (req: AuthedRequest, res: Response) => {
    const { code } = req.body as { code?: string };
    if (!code) {
      res.status(400).json({ message: "TOTP code is required" });
      return;
    }

    const [user] = await db.select().from(users).where(eq(users.id, req.user.userId)).limit(1);
    if (!user) {
      res.status(404).json({ message: "User not found" });
      return;
    }

    if (user.mfaEnabled) {
      res.status(400).json({ message: "MFA is already enabled" });
      return;
    }

    if (!user.mfaSecretEncrypted) {
      res.status(400).json({ message: "MFA setup not initiated. Call /api/mfa/setup first." });
      return;
    }

    // Decrypt and verify
    let base32Secret: string;
    try {
      base32Secret = decryptSecret(user.mfaSecretEncrypted as { encrypted: string; iv: string; authTag: string });
    } catch {
      res.status(500).json({ message: "Failed to decrypt MFA secret" });
      return;
    }

    const secret = OTPAuth.Secret.fromBase32(base32Secret);
    const totp = new OTPAuth.TOTP({
      issuer: "CRM",
      label: user.email,
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      secret,
    });

    const delta = totp.validate({ token: code.replace(/\s/g, ''), window: 1 });
    if (delta === null) {
      await auditLog(req, 'mfa.confirm_failed', 'user', user.id);
      res.status(400).json({ message: "Invalid TOTP code" });
      return;
    }

    // Generate recovery codes
    const plainCodes = generateRecoveryCodes(8);
    const hashedCodes = await Promise.all(plainCodes.map(c => bcrypt.hash(c, 12)));

    // Activate MFA
    await db.update(users)
      .set({
        mfaEnabled: true,
        mfaRecoveryCodes: hashedCodes,
      })
      .where(eq(users.id, user.id));

    await auditLog(req, 'mfa.enable', 'user', user.id);

    // Return plaintext codes once — never again
    res.json({
      message: "MFA enabled successfully",
      recoveryCodes: plainCodes,
    });
  }));

  // POST /api/mfa/disable — disable MFA (requires current TOTP code)
  app.post("/api/mfa/disable", requireAuth, mfaVerifyRateLimiter, asyncHandler(async (req: AuthedRequest, res: Response) => {
    const { code } = req.body as { code?: string };
    if (!code) {
      res.status(400).json({ message: "Current TOTP code is required to disable MFA" });
      return;
    }

    const [user] = await db.select().from(users).where(eq(users.id, req.user.userId)).limit(1);
    if (!user) {
      res.status(404).json({ message: "User not found" });
      return;
    }

    if (!user.mfaEnabled || !user.mfaSecretEncrypted) {
      res.status(400).json({ message: "MFA is not enabled" });
      return;
    }

    let base32Secret: string;
    try {
      base32Secret = decryptSecret(user.mfaSecretEncrypted as { encrypted: string; iv: string; authTag: string });
    } catch {
      res.status(500).json({ message: "Failed to decrypt MFA secret" });
      return;
    }

    const secret = OTPAuth.Secret.fromBase32(base32Secret);
    const totp = new OTPAuth.TOTP({
      issuer: "CRM",
      label: user.email,
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      secret,
    });

    const delta = totp.validate({ token: code.replace(/\s/g, ''), window: 1 });
    if (delta === null) {
      await auditLog(req, 'mfa.disable_failed', 'user', user.id);
      res.status(400).json({ message: "Invalid TOTP code" });
      return;
    }

    await db.update(users)
      .set({
        mfaEnabled: false,
        mfaSecretEncrypted: null,
        mfaRecoveryCodes: [],
      })
      .where(eq(users.id, user.id));

    await auditLog(req, 'mfa.disable', 'user', user.id);
    res.json({ message: "MFA disabled successfully" });
  }));

  // POST /api/mfa/verify — verify a TOTP code (used in the login flow)
  // Accepts a pendingToken (short-lived JWT) + TOTP or recovery code
  app.post("/api/mfa/verify", mfaVerifyRateLimiter, asyncHandler(async (req: AuthedRequest, res: Response) => {
    const { pendingToken, code } = req.body as { pendingToken?: string; code?: string };
    if (!pendingToken || !code) {
      res.status(400).json({ message: "pendingToken and code are required" });
      return;
    }

    // Import AuthService inline to avoid circular dep at module init time
    const { AuthService } = await import('../auth-service');
    const decoded = AuthService.verifyToken(pendingToken);
    if (!decoded || (decoded as any).purpose !== 'mfa_pending') {
      res.status(401).json({ message: "Invalid or expired pending token" });
      return;
    }

    const [user] = await db.select().from(users).where(eq(users.id, decoded.userId)).limit(1);
    if (!user || !user.mfaEnabled || !user.mfaSecretEncrypted) {
      res.status(401).json({ message: "MFA not configured for this user" });
      return;
    }

    const cleanCode = code.replace(/\s/g, '');

    // Try TOTP first
    let base32Secret: string;
    try {
      base32Secret = decryptSecret(user.mfaSecretEncrypted as { encrypted: string; iv: string; authTag: string });
    } catch {
      res.status(500).json({ message: "Failed to decrypt MFA secret" });
      return;
    }

    const secret = OTPAuth.Secret.fromBase32(base32Secret);
    const totp = new OTPAuth.TOTP({
      issuer: "CRM",
      label: user.email,
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      secret,
    });

    const delta = totp.validate({ token: cleanCode, window: 1 });
    if (delta !== null) {
      // Valid TOTP — issue full session token
      return await issueFinalToken(req, res, user, decoded);
    }

    // Try recovery codes
    const recoveryCodes = (user.mfaRecoveryCodes ?? []) as string[];
    let matchedIndex = -1;
    for (let i = 0; i < recoveryCodes.length; i++) {
      const match = await bcrypt.compare(cleanCode, recoveryCodes[i]);
      if (match) { matchedIndex = i; break; }
    }

    if (matchedIndex >= 0) {
      // Burn the used recovery code
      const updatedCodes = recoveryCodes.filter((_, i) => i !== matchedIndex);
      await db.update(users).set({ mfaRecoveryCodes: updatedCodes }).where(eq(users.id, user.id));
      await auditLog(req, 'mfa.recovery_code_used', 'user', user.id);
      return await issueFinalToken(req, res, user, decoded);
    }

    await auditLog(req, 'mfa.verify_failed', 'user', user.id);
    res.status(401).json({ message: "Invalid TOTP code or recovery code" });
  }));
}

async function issueFinalToken(
  req: AuthedRequest,
  res: Response,
  user: { id: string; username: string; name: string; email: string; role: string; contractorId: string | null; canManageIntegrations: boolean; tokenVersion: number },
  decoded: any,
) {
  const { AuthService } = await import('../auth-service');
  const { storage } = await import('../storage');

  const contractorId = decoded.contractorId ?? user.contractorId ?? '';
  const userContractorEntry = await storage.ensureUserContractorEntry(
    user.id,
    contractorId,
    user.role as any,
    user.canManageIntegrations,
  );

  const token = AuthService.generateToken({
    id: user.id,
    username: user.username,
    name: user.name,
    email: user.email,
    role: user.role,
    contractorId,
    canManageIntegrations: userContractorEntry.canManageIntegrations ?? user.canManageIntegrations,
    allowedIntegrations: userContractorEntry.allowedIntegrations ?? null,
    tokenVersion: user.tokenVersion ?? 1,
  });

  res.cookie('auth_token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/',
  });

  await auditLog(req, 'login', 'user', user.id);

  res.json({
    user: {
      id: user.id,
      username: user.username,
      name: user.name,
      email: user.email,
      role: user.role,
      contractorId,
    },
    message: "Login successful",
  });
}
