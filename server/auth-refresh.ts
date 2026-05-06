import crypto from "crypto";
import type { Request, Response, NextFunction } from "express";
import { storage } from "./storage";
import { AuthService } from "./auth-service";
import { logger } from "./utils/logger";

const log = logger("AuthRefresh");

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
 * Pull the raw refresh token from either the httpOnly cookie OR the request
 * body. The body path exists for PWA installs where iOS Safari has evicted
 * the refresh cookie but the SPA still has a copy of the token in IndexedDB
 * (which iOS retains far longer for installed PWAs than cookies do — see
 * task #720). Both paths are subject to the SAME rotation, grace, replay,
 * and rate-limit rules: there is no weaker security path for body tokens.
 */
function extractRawRefreshToken(req: Request): string | null {
  const cookieToken = req.cookies?.[REFRESH_COOKIE_NAME] as string | undefined;
  if (cookieToken) return cookieToken;
  const body = req.body as { token?: unknown } | undefined;
  if (body && typeof body.token === "string" && body.token.length > 0) {
    return body.token;
  }
  return null;
}

/**
 * Per-refresh-token rate limiter middleware. Apply AFTER the per-IP limiter
 * on POST /api/auth/refresh. Skips when no refresh token is present at all
 * (the route handler will 401 on its own in that case). Looks at both the
 * cookie and the JSON body so PWA fallbacks are throttled too.
 */
export function refreshTokenRateLimiter(req: Request, res: Response, next: NextFunction): void {
  const raw = extractRawRefreshToken(req);
  if (!raw) return next();
  const { allowed, retryAfterSec } = recordTokenHit(hashRefreshToken(raw));
  if (!allowed) {
    // Mirror the same structured outcome shape used by handleRefreshRequest
    // so production log search can correlate "rate-limited" hits with the
    // other refresh failure reasons. The response also includes
    // `reason: "rate-limited"` so the SPA can distinguish a throttle from a
    // dead-token reason and avoid wiping its IndexedDB copy on a 429.
    log.info("refresh_attempt", {
      reason: "rate-limited" as const,
      source: req.cookies?.[REFRESH_COOKIE_NAME] ? "cookie" : "body",
      cookiePresent: !!req.cookies?.[REFRESH_COOKIE_NAME],
      authCookiePresent: !!req.cookies?.auth_token,
      bodyTokenPresent: !!(req.body as { token?: unknown } | undefined)?.token,
      retryAfterSec,
      ip: req.ip ?? req.socket?.remoteAddress ?? null,
      userAgent: req.headers["user-agent"] ?? null,
    });
    res.status(429).json({
      error: "Too many requests",
      message: "Refresh token used too frequently",
      reason: "rate-limited",
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

// Cookie attributes for the long-lived refresh_token cookie.
//
//   httpOnly:   yes — the SPA never needs to read this from JS; an XSS leak
//               would let an attacker silently re-mint sessions for 90 days.
//   secure:     prod only — browsers refuse Secure cookies on http://localhost
//               during dev, so we only set it in production.
//   sameSite:   "lax" — required so OAuth (Google / Facebook / Dialpad) and
//               SendGrid callback redirects, which arrive as top-level GETs
//               from a third-party origin, still carry the cookie. Switching
//               to "strict" would break those flows; switching to "none"
//               would require the `Partitioned` (CHIPS) attribute to keep
//               working in iOS Safari, which in turn would isolate the
//               cookie per-top-level-site and break OAuth callbacks again.
//               Our IndexedDB fallback (task #720) is the durability layer
//               for cases where the cookie is evicted in spite of `lax`.
//   path:       "/" — same value used to clear the cookie on logout; any
//               mismatch would leave a stale cookie behind.
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
 * Returns the RAW token string so callers can also include it in the JSON
 * response body — the client mirrors it into IndexedDB as a durable fallback
 * for when iOS evicts the cookie (task #720). The cookie is still the primary
 * delivery path; IndexedDB is only consulted when the cookie is missing.
 *
 * This is called from the login handler, MFA verify, WebAuthn (passkey)
 * login, and from the rotation step inside /api/auth/refresh.
 */
export async function issueRefreshToken(
  req: Request,
  res: Response,
  args: { userId: string; contractorId: string; deviceId?: string | null },
): Promise<string> {
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

  return raw;
}

// Possible outcomes of a refresh attempt — emitted as a structured field so
// that production log search can answer the question "why is this user being
// bounced to /login?" without guessing. See task #720 step 1.
type RefreshOutcomeReason =
  | "missing"
  | "not-found"
  | "revoked"
  | "expired"
  | "replayed-past-grace"
  | "user-missing"
  | "membership-missing"
  | "ok-grace"
  | "ok-rotated";

function logRefreshOutcome(
  req: Request,
  reason: RefreshOutcomeReason,
  extra: { userId?: string | null; contractorId?: string | null; source?: "cookie" | "body" } = {},
): void {
  log.info("refresh_attempt", {
    reason,
    source: extra.source ?? null,
    cookiePresent: !!req.cookies?.[REFRESH_COOKIE_NAME],
    authCookiePresent: !!req.cookies?.auth_token,
    bodyTokenPresent: !!(req.body as { token?: unknown } | undefined)?.token,
    userId: extra.userId ?? null,
    contractorId: extra.contractorId ?? null,
    ip: req.ip ?? req.socket?.remoteAddress ?? null,
    userAgent: req.headers["user-agent"] ?? null,
  });
}

/**
 * Core handler for `POST /api/auth/refresh`. Exported so it can be exercised
 * directly in unit tests with mocked storage — the route file just wires this
 * function into Express alongside the per-IP and per-token rate limiters.
 *
 * Token source: prefers the httpOnly `refresh_token` cookie. Falls back to a
 * `{ token }` value in the JSON body, used by the PWA when iOS Safari has
 * evicted the cookie but the SPA still has a copy in IndexedDB (task #720).
 *
 * State machine (priority order):
 *  - missing token                → 401
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
 *
 * On the rotated path, the response body also includes `refreshToken: raw` so
 * the client can update its IndexedDB fallback copy.
 */
export async function handleRefreshRequest(req: Request, res: Response): Promise<void> {
  const cookieToken = req.cookies?.[REFRESH_COOKIE_NAME] as string | undefined;
  const bodyToken =
    typeof (req.body as { token?: unknown } | undefined)?.token === "string"
      ? ((req.body as { token: string }).token)
      : undefined;
  const rawRefresh = cookieToken || bodyToken;
  const source: "cookie" | "body" | undefined = cookieToken ? "cookie" : bodyToken ? "body" : undefined;

  if (!rawRefresh) {
    logRefreshOutcome(req, "missing");
    res.status(401).json({ message: "No refresh token", reason: "missing" });
    return;
  }

  const tokenHash = hashRefreshToken(rawRefresh);
  const existing = await storage.findRefreshTokenByHash(tokenHash);
  if (!existing) {
    clearRefreshCookie(res);
    logRefreshOutcome(req, "not-found", { source });
    res.status(401).json({ message: "Invalid refresh token", reason: "not-found" });
    return;
  }

  if (existing.revokedAt) {
    clearRefreshCookie(res);
    logRefreshOutcome(req, "revoked", { source, userId: existing.userId, contractorId: existing.contractorId });
    res.status(401).json({ message: "Invalid refresh token", reason: "revoked" });
    return;
  }

  if (existing.expiresAt.getTime() <= Date.now()) {
    clearRefreshCookie(res);
    logRefreshOutcome(req, "expired", { source, userId: existing.userId, contractorId: existing.contractorId });
    res.status(401).json({ message: "Refresh token expired", reason: "expired" });
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
    logRefreshOutcome(req, "replayed-past-grace", {
      source,
      userId: existing.userId,
      contractorId: existing.contractorId,
    });
    res.status(401).json({ message: "Refresh token reused after rotation", reason: "replayed-past-grace" });
    return;
  }

  const user = await storage.getUser(existing.userId);
  if (!user) {
    clearRefreshCookie(res);
    logRefreshOutcome(req, "user-missing", { source, userId: existing.userId });
    res.status(401).json({ message: "User no longer exists", reason: "user-missing" });
    return;
  }

  const userContractor = await storage.getUserContractor(existing.userId, existing.contractorId);
  if (!userContractor) {
    await storage.revokeRefreshToken(existing.id);
    clearRefreshCookie(res);
    logRefreshOutcome(req, "membership-missing", {
      source,
      userId: existing.userId,
      contractorId: existing.contractorId,
    });
    res.status(401).json({ message: "Access denied to this company", reason: "membership-missing" });
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
    logRefreshOutcome(req, "ok-grace", {
      source,
      userId: existing.userId,
      contractorId: existing.contractorId,
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

  const newRaw = await issueRefreshToken(req, res, {
    userId: existing.userId,
    contractorId: existing.contractorId,
    deviceId: existing.deviceId,
  });

  logRefreshOutcome(req, "ok-rotated", {
    source,
    userId: existing.userId,
    contractorId: existing.contractorId,
  });

  // Mirror the rotated raw token in the JSON body so the SPA can update its
  // IndexedDB fallback. The cookie is still the primary path; IDB is only a
  // backstop for iOS PWA cookie eviction.
  res.json({ ok: true, refreshToken: newRaw });
}
