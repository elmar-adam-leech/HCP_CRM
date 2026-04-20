import type { Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../auth-service";
import { logger } from "../utils/logger";

const log = logger('RateLimiter');

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

// SCALING NOTE: Single-instance rate limiter — NOT safe for horizontal scaling
// ──────────────────────────────────────────────────────────────────────────────
// This rate limiter stores request counts in an in-process Map (`rateLimitStore`).
// This means:
//   1. Rate-limit state is NOT shared across multiple Node.js processes or pods.
//   2. When the app is horizontally scaled (multiple instances), each instance
//      enforces limits independently, so the effective limit per IP becomes:
//        (maxRequests × number_of_instances)
//      A client that rotates between instances can exceed the intended limit.
//
// HOW TO FIX AT SCALE:
//   Replace `rateLimitStore` with a Redis-backed adapter. The `createRateLimiter`
//   API can remain identical — only the store implementation changes. Options:
//     • `rate-limit-redis` npm package (drop-in store for express-rate-limit)
//     • `ioredis` with a custom INCRBY + EXPIRE Lua script for atomic counting
//   Install the chosen package, connect it to your Redis cluster, pass the store
//   into `createRateLimiter`, and remove the `rateLimitStore` Map entirely.
// ──────────────────────────────────────────────────────────────────────────────

// LRU-evicting in-memory store for rate-limit buckets.
//
// JS Map iterates in insertion order, which makes it a natural LRU container:
//   - On every read-or-write we delete the key then re-insert it so it moves
//     to the "most recently used" tail of the iteration order.
//   - When the store exceeds MAX_SIZE we delete the very first (oldest) key.
//
// This bounds memory to O(MAX_SIZE) entries regardless of attacker IP churn.
// The periodic cleanup below further shrinks the store by pruning expired entries.
//
// TODO: Replace with a Redis-backed store for multi-instance deployments.
const MAX_RATE_LIMIT_STORE_SIZE = 10_000;
const rateLimitStore = new Map<string, RateLimitEntry>();

function lruGet(key: string): RateLimitEntry | undefined {
  const entry = rateLimitStore.get(key);
  if (entry === undefined) return undefined;
  // Move to most-recently-used tail
  rateLimitStore.delete(key);
  rateLimitStore.set(key, entry);
  return entry;
}

function lruSet(key: string, entry: RateLimitEntry): void {
  if (rateLimitStore.has(key)) {
    rateLimitStore.delete(key);
  } else if (rateLimitStore.size >= MAX_RATE_LIMIT_STORE_SIZE) {
    // Evict the least-recently-used (first) entry to keep size bounded
    const lruKey = rateLimitStore.keys().next().value;
    if (lruKey !== undefined) {
      rateLimitStore.delete(lruKey);
      log.warn(`Rate-limit store LRU eviction triggered (size=${MAX_RATE_LIMIT_STORE_SIZE}). Consider switching to a Redis-backed store.`);
    }
  }
  rateLimitStore.set(key, entry);
}

/**
 * Prune all entries whose window has already expired.
 * Called by RateLimitCleanupJob on a 1-minute interval so the store stays
 * compact even when LRU eviction alone isn't enough to clear expired keys.
 */
export function pruneExpiredRateLimitEntries(): void {
  const now = Date.now();
  Array.from(rateLimitStore.entries()).forEach(([key, entry]) => {
    if (entry.resetAt < now) {
      rateLimitStore.delete(key);
    }
  });
}

interface RateLimitOptions {
  windowMs: number;
  maxRequests: number;
  keyPrefix?: string;
  useSessionId?: boolean;
}

function getClientKey(req: AuthenticatedRequest, useSessionId: boolean, keyPrefix: string): string {
  if (useSessionId) {
    const userId = req.user?.userId;
    if (userId) {
      return `${keyPrefix}:user:${userId}`;
    }
  }
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  return `${keyPrefix}:${ip}`;
}

export function createRateLimiter(options: RateLimitOptions) {
  const { windowMs, maxRequests, keyPrefix = 'rl', useSessionId = false } = options;

  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const key = getClientKey(req, useSessionId, keyPrefix);
    const now = Date.now();

    let entry = lruGet(key);

    if (!entry || entry.resetAt < now) {
      entry = {
        count: 1,
        resetAt: now + windowMs,
      };
      lruSet(key, entry);
    } else {
      entry.count++;
      // Re-insert to update LRU position (lruGet already moved it to tail, but
      // we mutated the object in place, so just update the map directly).
      rateLimitStore.set(key, entry);
    }

    const remaining = Math.max(0, maxRequests - entry.count);
    const resetInSeconds = Math.ceil((entry.resetAt - now) / 1000);

    res.setHeader('X-RateLimit-Limit', maxRequests.toString());
    res.setHeader('X-RateLimit-Remaining', remaining.toString());
    res.setHeader('X-RateLimit-Reset', resetInSeconds.toString());

    if (entry.count > maxRequests) {
      res.status(429).json({
        error: 'Too many requests',
        message: 'Please try again later',
        retryAfter: resetInSeconds,
      });
      return;
    }

    next();
  };
}

// Tightened to 10/min (down from 30/min): this endpoint performs heavy
// scheduling math and external HCP API calls, making it a potential DoS vector
// for an unauthenticated route. 10 requests/min is still generous for real
// booking traffic but meaningfully limits automated abuse.
export const publicBookingRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 10,
  keyPrefix: 'public-booking',
});

export const publicBookingSubmitRateLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000,
  maxRequests: 30,
  keyPrefix: 'public-booking-submit',
});

export const webhookRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 120,
  keyPrefix: 'webhook',
});

export const authLoginRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 5,
  keyPrefix: 'auth-login',
});

export const authRegisterRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 3,
  keyPrefix: 'auth-register',
});

export const authForgotPasswordRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 3,
  keyPrefix: 'auth-forgot-password',
});

export const aiRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 10,
  keyPrefix: 'ai-endpoint',
});

// General safety-net limiter applied to all authenticated API routes.
// Generous enough to never affect normal usage but blocks runaway scripts
// operating on a stolen/leaked session token.
// Keys by session user ID so that mobile users sharing a public IP via CGNAT
// each get their own independent 300/min bucket. Falls back to IP for any
// unauthenticated requests that slip through.
export const apiRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 300,
  keyPrefix: 'api',
  useSessionId: true,
});

// Stricter limiter for the Google Places API proxy routes (/api/places/*).
// These routes are authenticated but each request consumes a paid Google API
// quota slot. Without a tighter limit, a single user with a leaked session
// token could exhaust the server's Google API quota for everyone.
// 30 requests/min is generous for real autocomplete-as-you-type usage.
export const placesRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 30,
  keyPrefix: 'places',
});
