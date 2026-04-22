/**
 * Report response cache.
 *
 * Reports re-aggregate from large source tables on every request. We wrap each
 * builder with a per-tenant, per-filter in-memory cache that has a short TTL
 * (60s by default; longer for slow-changing filter options) plus a hard cap
 * on entries so it can't grow unbounded.
 *
 * The cache is invalidated for a tenant whenever an estimate or lead is
 * created/updated/deleted (see invalidateReportsCache calls in storage),
 * keeping numbers fresh after a user edits something even within the TTL.
 *
 * Also exposes a small timing helper that logs slow report builds (>=1s).
 */

interface Entry<T> {
  value: T;
  expiresAt: number;
}

const SLOW_REPORT_THRESHOLD_MS = 1000;
const MAX_ENTRIES = 500;

const store = new Map<string, Entry<unknown>>();

function evictIfFull(): void {
  if (store.size < MAX_ENTRIES) return;
  // Drop ~10% of the oldest entries (Map insertion order = oldest first).
  const toDrop = Math.ceil(MAX_ENTRIES / 10);
  let i = 0;
  for (const key of store.keys()) {
    if (i++ >= toDrop) break;
    store.delete(key);
  }
}

function tenantPrefix(contractorId: string): string {
  return `t:${contractorId}|`;
}

export interface CachedFn<T> {
  (contractorId: string, ...args: unknown[]): Promise<T>;
}

/**
 * Wraps a report builder so that successive calls within `ttlMs` for the same
 * tenant + serialized args return a memoized result. The `name` is used both
 * as the cache namespace and the slow-log label.
 */
export function withReportCache<TArgs extends unknown[], TResult>(
  name: string,
  fn: (contractorId: string, ...args: TArgs) => Promise<TResult>,
  opts: { ttlMs?: number; serialize?: (args: TArgs) => string } = {},
): (contractorId: string, ...args: TArgs) => Promise<TResult> {
  const ttl = opts.ttlMs ?? 60_000;
  const serialize = opts.serialize ?? ((args: TArgs) => JSON.stringify(args));
  return async (contractorId: string, ...args: TArgs): Promise<TResult> => {
    const key = `${tenantPrefix(contractorId)}${name}|${serialize(args)}`;
    const now = Date.now();
    const hit = store.get(key) as Entry<TResult> | undefined;
    if (hit && hit.expiresAt > now) {
      // Refresh LRU position so hot entries don't get evicted first.
      store.delete(key);
      store.set(key, hit);
      return hit.value;
    }
    const start = now;
    const value = await fn(contractorId, ...args);
    const took = Date.now() - start;
    if (took >= SLOW_REPORT_THRESHOLD_MS) {
      console.log(`[reports] slow ${name} contractor=${contractorId} took=${took}ms`);
    }
    evictIfFull();
    store.set(key, { value, expiresAt: Date.now() + ttl });
    return value;
  };
}

/**
 * Drop every cached report entry for a single tenant. Called from estimate
 * and lead storage mutations so users see fresh numbers immediately after
 * editing, even if the entry hasn't expired yet.
 */
export function invalidateReportsCache(contractorId: string): void {
  const prefix = tenantPrefix(contractorId);
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key);
  }
}

/** Test/diagnostic helper. */
export function _reportCacheSize(): number {
  return store.size;
}
