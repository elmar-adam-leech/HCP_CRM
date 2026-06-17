/**
 * In-process JWT validation cache.
 *
 * The auth middleware in `server/auth-service.ts` runs on every authenticated
 * `/api/*` request. Without a cache, each request costs:
 *   1. A SELECT on `revoked_tokens` (jti lookup) — ~3-8 ms
 *   2. A SELECT on `users` (tokenVersion + identity) — ~3-8 ms
 * That's two DB round-trips on every API call. A dashboard that fires 8-12
 * requests can spend 50-200 ms in auth alone before any handler runs.
 *
 * Once a JWT has been verified (signature OK, jti not revoked, tokenVersion
 * matches), we trust that result for `AUTH_CACHE_TTL_MS` (default 30 s) and
 * skip both DB queries on subsequent requests. The trade-off is that
 * revocation actions take up to one TTL to propagate. Active revocation paths
 * (`AuthService.revokeToken` and the slow-path tokenVersion-mismatch branch)
 * call `evictAuthCache(jti)` to invalidate immediately, so the worst case
 * really only affects sign-out-all-devices on a token that has not yet hit
 * this process. Restarting the server flushes the cache instantly.
 *
 * Bounded to `MAX_ENTRIES` with FIFO eviction; a periodic sweeper drops
 * expired entries (registered in the timer registry in `server/index.ts`).
 */

export interface CachedAuthValidation {
  userId: string;
  tokenVersion: number;
  contractorId: string;
  validUntil: number; // Date.now() + ttl
}

interface JWTLikePayload {
  userId: string;
  tokenVersion: number;
  contractorId: string;
}

export const AUTH_CACHE_TTL_MS = (() => {
  const raw = process.env.AUTH_CACHE_TTL_MS;
  if (!raw) return 30_000;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 30_000;
})();

const MAX_ENTRIES = 50_000;

const cache = new Map<string, CachedAuthValidation>();

let hitCount = 0;
let missCount = 0;

/**
 * Look up a previously-validated jti. Returns the cached payload if present
 * and not expired, otherwise null. Also bumps the entry to most-recently-used
 * position so FIFO eviction approximates LRU under churn.
 */
export function getCachedValidation(jti: string): CachedAuthValidation | null {
  const entry = cache.get(jti);
  if (!entry) {
    missCount++;
    return null;
  }
  if (entry.validUntil <= Date.now()) {
    cache.delete(jti);
    missCount++;
    return null;
  }
  // LRU touch: re-insert so this jti moves to the tail of the Map iteration
  // order. FIFO eviction therefore drops the oldest UNTOUCHED entry first.
  cache.delete(jti);
  cache.set(jti, entry);
  hitCount++;
  return entry;
}

/**
 * Record a successful validation. Subsequent `getCachedValidation(jti)` calls
 * within `ttlMs` will hit the cache and the auth middleware will skip the
 * `revoked_tokens` and `users.tokenVersion` DB queries.
 */
export function cacheValidation(
  jti: string,
  payload: JWTLikePayload,
  ttlMs: number = AUTH_CACHE_TTL_MS,
): void {
  if (!cache.has(jti) && cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(jti, {
    userId: payload.userId,
    tokenVersion: payload.tokenVersion,
    contractorId: payload.contractorId,
    validUntil: Date.now() + ttlMs,
  });
}

/**
 * Remove a jti from the cache. Called by `AuthService.revokeToken` so an
 * explicit logout takes effect immediately, and on the slow-path tokenVersion
 * mismatch branch as a defensive race-eviction.
 */
export function evictAuthCache(jti: string): void {
  cache.delete(jti);
}

export function getAuthCacheStats(): {
  hits: number;
  misses: number;
  size: number;
  ttlMs: number;
  maxEntries: number;
} {
  return {
    hits: hitCount,
    misses: missCount,
    size: cache.size,
    ttlMs: AUTH_CACHE_TTL_MS,
    maxEntries: MAX_ENTRIES,
  };
}

/**
 * Drop every expired entry in one pass. The cache also self-expires on read
 * (see `getCachedValidation`) and is bounded to `MAX_ENTRIES` by FIFO eviction,
 * so this sweep is purely a memory-reclamation step for entries that expired
 * but were never read again. Safe to run infrequently (now folded into the
 * single daily maintenance pass in `server/services/maintenance-job.ts`).
 */
export function pruneExpiredAuthCacheEntries(): void {
  const now = Date.now();
  for (const [jti, entry] of cache) {
    if (entry.validUntil <= now) cache.delete(jti);
  }
}

/**
 * Periodic sweeper that drops expired entries. Returns the interval handle so
 * it can be tracked for graceful shutdown. Retained for tests and ad-hoc use;
 * production now reclaims expired entries via the daily maintenance pass.
 */
export function startAuthCacheSweeper(intervalMs: number = 60_000): NodeJS.Timeout {
  const handle = setInterval(pruneExpiredAuthCacheEntries, intervalMs);
  // Don't keep the event loop alive on this timer alone.
  if (typeof handle.unref === 'function') handle.unref();
  return handle;
}

/**
 * Test-only: drop every entry and reset counters.
 */
export function _resetAuthCacheForTests(): void {
  cache.clear();
  hitCount = 0;
  missCount = 0;
}
