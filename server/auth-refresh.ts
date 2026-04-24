import crypto from "crypto";
import type { Request, Response, NextFunction } from "express";
import { storage } from "./storage";
import { AuthService } from "./auth-service";

// 90 days. Long enough to outlast iOS PWA cookie eviction (which we've observed
// at ~24h on aggressive devices) without being so long that a stolen device
// cookie is useful forever.
export const REFRESH_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;

// Grace window after a refresh token is rotated during which a re-arrival of
// the SAME old token is treated as an in-flight retry (succeeds without
// re-rotating) rather than a replay attack. Tuned for: HTTP request retries
// after transient network failures, and concurrent fetches that were both
// already in flight when /api/auth/refresh first responded.
//
// Past this window, re-use of a rotated token is treated as evidence of
// compromise: the row is hard-revoked and the request is rejected.
export const REFRESH_ROTATION_GRACE_MS = 30 * 1000;

export const REFRESH_COOKIE_NAME = "refresh_token";

// In-process per-token rate limiter for /api/auth/refresh. The route already
// has a per-IP limiter (10/min); this adds a second axis keyed on the token
// hash so that a leaked refresh cookie cannot be used to brute-force-rotate
// an account from many IPs (e.g. a botnet) without tripping a global cap.
// Legitimate clients only refresh when their auth_token expires (~weekly), so
// 5/minute per token is two orders of magnitude above any plausible legit
// load and still meaningfully throttles abuse.
const PER_TOKEN_LIMIT = 5;
const PER_TOKEN_WINDOW_MS = 60 * 1000;
const MAX_PER_TOKEN_ENTRIES = 10_000;
const perTokenBuckets = new Map<string, { count: number; resetAt: number }>();

function recordTokenHit(tokenHash: string): { allowed: boolean; retryAfterSec: number } {
  const now = Date.now();
  const existing = perTokenBuckets.get(tokenHash);
  if (!existing || existing.resetAt < now) {
    if (perTokenBuckets.size >= MAX_PER_TOKEN_ENTRIES) {
      // LRU-ish eviction: drop the oldest entry. Map iterates in insertion
      // order so .keys().next() yields the oldest.
      const oldest = perTokenBuckets.keys().next().value;
      if (oldest !== undefined) perTokenBuckets.delete(oldest);
    }
    perTokenBuckets.set(tokenHash, { count: 1, resetAt: now + PER_TOKEN_WINDOW_MS });
    return { allowed: true, retryAfterSec: 0 };
  }
  existing.count += 1;
  if (existing.count > PER_TOKEN_LIMIT) {
    return { allowed: false, retryAfterSec: Math.ceil((existing.resetAt - now) / 1000) };
  }
  return { allowed: true, retryAfterSec: 0 };
}

/**
 * Per-refresh-token rate limiter middleware. Apply AFTER the per-IP limiter
 * on POST /api/auth/refresh. Skips when no refresh cookie is present (the
 * route handler will 401 on its own in that case).
 */
export function refreshTokenRateLimiter(req: Request, res: Response, next: NextFunction): void {
  const raw = req.cookies?.[REFRESH_COOKIE_NAME] as string | undefined;
  if (!raw) return next();
  const { allowed, retryAfterSec } = recordTokenHit(hashRefreshToken(raw));
  if (!allowed) {
    res.status(429).json({
      error: "Too many requests",
      message: "Refresh token used too frequently",
      retryAfter: retryAfterSec,
    });
    return;
  }
  next();
}

/** Test-only helper to reset the per-token bucket store. */
export function _resetPerTokenRateLimiterForTests(): void {
  perTokenBuckets.clear();
}

function refreshCookieOptions(): {
  httpOnly: true;
  secure: boolean;
  sameSite: "lax";
  path: string;
  maxAge?: number;
} {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
  };
}

export function hashRefreshToken(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

export function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE_NAME, refreshCookieOptions());
}

/**
 * Generate a new opaque refresh token, persist its SHA-256 hash, and set the
 * `refresh_token` httpOnly cookie on the response.
 *
 * This is called from the login handler and from MFA verify (when the final
 * session is being issued), and from the rotation step inside /api/auth/refresh.
 */
export async function issueRefreshToken(
  req: Request,
  res: Response,
  args: { userId: string; contractorId: string; deviceId?: string | null },
): Promise<void> {
  const raw = crypto.randomBytes(32).toString("hex"); // 256 bits of entropy
  const tokenHash = hashRefreshToken(raw);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);

  await storage.createRefreshToken({
    userId: args.userId,
    contractorId: args.contractorId,
    tokenHash,
    deviceId: args.deviceId ?? null,
    expiresAt,
    ip: req.ip ?? req.socket?.remoteAddress ?? null,
    userAgent: req.headers["user-agent"] ?? null,
  });

  res.cookie(REFRESH_COOKIE_NAME, raw, {
    ...refreshCookieOptions(),
    maxAge: REFRESH_TOKEN_TTL_MS,
  });
}

/**
 * Core handler for `POST /api/auth/refresh`. Exported so it can be exercised
 * directly in unit tests with mocked storage — the route file just wires this
 * function into Express alongside the per-IP and per-token rate limiters.
 *
 * State machine (priority order):
 *  - missing cookie               → 401
 *  - hash not found               → 401 + clear cookie
 *  - row.revokedAt set            → 401 + clear cookie  (logout / sign-out-all)
 *  - row.expiresAt <= now         → 401 + clear cookie
 *  - row.rotatedAt set, in grace  → 200, re-mint auth_token only (no rotation)
 *  - row.rotatedAt set, > grace   → 401 + hard-revoke   (replay attack)
 *  - active                       → 200, mint auth_token + rotated refresh cookie
 *
 * The grace branch returns `{ ok: true, grace: true }` and never spawns a new
 * refresh-token row, so concurrent in-flight retries can't fan out into a
 * runaway rotation chain.
 */
export async function handleRefreshRequest(req: Request, res: Response): Promise<void> {
  const rawRefresh = req.cookies?.[REFRESH_COOKIE_NAME] as string | undefined;
  if (!rawRefresh) {
    res.status(401).json({ message: "No refresh token" });
    return;
  }

  const tokenHash = hashRefreshToken(rawRefresh);
  const existing = await storage.findRefreshTokenByHash(tokenHash);
  if (!existing) {
    clearRefreshCookie(res);
    res.status(401).json({ message: "Invalid refresh token" });
    return;
  }

  if (existing.revokedAt) {
    clearRefreshCookie(res);
    res.status(401).json({ message: "Invalid refresh token" });
    return;
  }

  if (existing.expiresAt.getTime() <= Date.now()) {
    clearRefreshCookie(res);
    res.status(401).json({ message: "Refresh token expired" });
    return;
  }

  const inGrace =
    !!existing.rotatedAt &&
    Date.now() - existing.rotatedAt.getTime() <= REFRESH_ROTATION_GRACE_MS;

  if (existing.rotatedAt && !inGrace) {
    // Past grace = stale replay. Hard-revoke so subsequent attempts hit the
    // revokedAt branch above and never enter grace again.
    await storage.revokeRefreshToken(existing.id);
    clearRefreshCookie(res);
    res.status(401).json({ message: "Refresh token reused after rotation" });
    return;
  }

  const user = await storage.getUser(existing.userId);
  if (!user) {
    clearRefreshCookie(res);
    res.status(401).json({ message: "User no longer exists" });
    return;
  }

  const userContractor = await storage.getUserContractor(existing.userId, existing.contractorId);
  if (!userContractor) {
    await storage.revokeRefreshToken(existing.id);
    clearRefreshCookie(res);
    res.status(401).json({ message: "Access denied to this company" });
    return;
  }

  const newAuthToken = AuthService.generateToken({
    id: user.id,
    username: user.username,
    name: user.name,
    email: user.email,
    role: userContractor.role,
    contractorId: existing.contractorId,
    canManageIntegrations: userContractor.canManageIntegrations,
    allowedIntegrations: userContractor.allowedIntegrations ?? null,
    tokenVersion: user.tokenVersion ?? 1,
  });

  res.cookie("auth_token", newAuthToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: "/",
  });

  if (inGrace) {
    // Stamp audit metadata on the grace-path hit too — without it, multiple
    // in-flight retries against the same rotated row would leave their IP / UA
    // / lastUsedAt unrecorded, making forensic review of a leaked-cookie
    // incident incomplete. We deliberately do NOT pass `rotate` here so the
    // row's existing `rotatedAt` is preserved as the original-rotation anchor
    // (which is what the grace-window math is keyed on).
    await storage.markRefreshTokenUsed(existing.id, {
      lastUsedAt: new Date(),
      ip: req.ip ?? req.socket?.remoteAddress ?? null,
      userAgent: req.headers["user-agent"] ?? null,
    });
    res.json({ ok: true, grace: true });
    return;
  }

  await storage.markRefreshTokenUsed(existing.id, {
    lastUsedAt: new Date(),
    ip: req.ip ?? req.socket?.remoteAddress ?? null,
    userAgent: req.headers["user-agent"] ?? null,
    rotate: true,
  });

  await issueRefreshToken(req, res, {
    userId: existing.userId,
    contractorId: existing.contractorId,
    deviceId: existing.deviceId,
  });

  res.json({ ok: true });
}
