import type { AvailableSlot } from '../types/scheduling';
import { logger } from '../utils/logger';

const log = logger('AvailabilityCache');

// ---------------------------------------------------------------------------
// Request coalescing
// ---------------------------------------------------------------------------
// When multiple concurrent requests arrive for the same tenant+date before
// the cache is populated (e.g. a burst of requests on a cold cache), only
// one DB computation is performed; the rest await the same in-flight promise.
//
// Key format: "<tenantId>::<dateStr>"
// Value: the in-flight Promise<AvailableSlot[]> from the first caller.
//
// The entry is deleted once the promise settles (success or failure) so that
// subsequent requests after the cache is warm see a cache hit and never touch
// this map.
const inFlightRequests = new Map<string, Promise<AvailableSlot[]>>();

/**
 * Coalesce concurrent availability computations for the same tenant+date.
 *
 * If a computation for this key is already in-flight, return the existing
 * promise so all callers share a single DB query.
 *
 * `computeFn` is called exactly once per key; subsequent callers block on
 * its result.  After the promise settles, the entry is removed so future
 * cold-cache misses start fresh.
 */
export function coalesceAvailabilityRequest(
  tenantId: string,
  dateStr: string,
  computeFn: () => Promise<AvailableSlot[]>,
): Promise<AvailableSlot[]> {
  const key = cacheKey(tenantId, dateStr);
  const existing = inFlightRequests.get(key);
  if (existing) {
    log.info(`[availability-cache] Coalescing in-flight request tenant=${tenantId} date=${dateStr}`);
    return existing;
  }

  const promise = computeFn().finally(() => {
    inFlightRequests.delete(key);
  });

  inFlightRequests.set(key, promise);
  return promise;
}

/**
 * TTL for cached availability entries in milliseconds.
 * Acts as a safety-net so stale entries never persist indefinitely even if a
 * webhook event is missed.  Default: 1 hour.
 */
const CACHE_TTL_MS = parseInt(process.env.AVAILABILITY_CACHE_TTL_MS || '', 10) || 60 * 60 * 1000;

interface CacheEntry {
  slots: AvailableSlot[];
  computedAt: number;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(tenantId: string, dateStr: string): string {
  return `${tenantId}::${dateStr}`;
}

function isExpired(entry: CacheEntry): boolean {
  return Date.now() - entry.computedAt > CACHE_TTL_MS;
}

/**
 * Convert a UTC Date (or ISO string) to a YYYY-MM-DD date string in the
 * given IANA timezone.  Uses Intl.DateTimeFormat which is available in all
 * modern Node.js versions and requires no third-party library.
 */
export function utcToLocalDateStr(ts: Date | string, timezone: string): string {
  const d = typeof ts === 'string' ? new Date(ts) : ts;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * Return cached availability for a given tenant + date string (YYYY-MM-DD in
 * the contractor's timezone).
 * Returns null when the cache is cold or the entry has exceeded its TTL.
 */
export function getCachedAvailability(tenantId: string, dateStr: string): AvailableSlot[] | null {
  const entry = cache.get(cacheKey(tenantId, dateStr));
  if (!entry) return null;
  if (isExpired(entry)) {
    cache.delete(cacheKey(tenantId, dateStr));
    return null;
  }
  return entry.slots;
}

/**
 * Store a freshly-computed availability result in the cache.
 */
export function setCachedAvailability(tenantId: string, dateStr: string, slots: AvailableSlot[]): void {
  cache.set(cacheKey(tenantId, dateStr), { slots, computedAt: Date.now() });
}

/**
 * Invalidate cache entries for a tenant.
 * If `dateStr` is provided, only that day is invalidated.
 * If omitted, **all** entries for the tenant are invalidated.
 */
export function invalidateAvailabilityCache(tenantId: string, dateStr?: string): void {
  if (dateStr) {
    const deleted = cache.delete(cacheKey(tenantId, dateStr));
    if (deleted) {
      log.info(`[availability-cache] Invalidated cache for tenant=${tenantId} date=${dateStr}`);
    }
    return;
  }
  const prefix = `${tenantId}::`;
  let count = 0;
  Array.from(cache.keys()).forEach((key) => {
    if (key.startsWith(prefix)) {
      cache.delete(key);
      count++;
    }
  });
  if (count > 0) {
    log.info(`[availability-cache] Invalidated ${count} entries for tenant=${tenantId}`);
  }
}

/**
 * Pre-warm the cache for the next N calendar days (default 7) starting from
 * today in the given timezone.
 *
 * `computeFn` receives `(tenantId, dateStr, timezone)` so it can recompute
 * slots correctly for the contractor's local calendar day.
 *
 * Errors for individual dates are caught and logged — one bad day does not
 * abort the rest of the warm-up.
 *
 * Dates are processed with a concurrency cap of 2 to avoid exhausting the
 * Neon serverless connection pool when re-warming all 14 days at once.
 */
export async function warmAvailabilityCache(
  tenantId: string,
  timezone: string,
  computeFn: (tenantId: string, dateStr: string, timezone: string) => Promise<AvailableSlot[]>,
  days: number = 7
): Promise<void> {
  const CONCURRENCY = 2;

  const todayStr = utcToLocalDateStr(new Date(), timezone);
  const [y, m, d] = todayStr.split('-').map(Number);
  const datesToWarm: string[] = [];

  for (let i = 0; i < days; i++) {
    // Advance by i days from today (in local calendar)
    const local = new Date(Date.UTC(y, m - 1, d + i, 12, 0, 0));
    const dateStr = utcToLocalDateStr(local, timezone);

    if (getCachedAvailability(tenantId, dateStr) !== null) {
      continue;
    }

    datesToWarm.push(dateStr);
  }

  // Process dates in batches of CONCURRENCY to keep peak DB connections low.
  for (let i = 0; i < datesToWarm.length; i += CONCURRENCY) {
    const batch = datesToWarm.slice(i, i + CONCURRENCY);
    await Promise.allSettled(
      batch.map(dateStr =>
        computeFn(tenantId, dateStr, timezone)
          .then(slots => {
            setCachedAvailability(tenantId, dateStr, slots);
            log.info(`[availability-cache] Warmed cache tenant=${tenantId} date=${dateStr} slots=${slots.length}`);
          })
          .catch(err => {
            log.warn(`[availability-cache] Failed to warm cache tenant=${tenantId} date=${dateStr}:`, err);
          })
      )
    );
  }
}

// ---------------------------------------------------------------------------
// Per-tenant debounce for invalidateAndRecompute
// ---------------------------------------------------------------------------
// A burst of webhook events (e.g. 5 estimate.updated in 10 s) would normally
// trigger five independent re-warm cycles, each fanning out up to 14
// concurrent DB queries. The debounce map collapses any burst within
// DEBOUNCE_MS into a single re-warm, drastically reducing peak connection
// pressure on the Neon serverless pool.
//
// Key: tenantId
// Value: the pending NodeJS.Timeout scheduled for the re-warm
const recomputeDebounceMap = new Map<string, NodeJS.Timeout>();

/** Debounce delay in ms — a burst within this window collapses to one re-warm. */
const DEBOUNCE_MS = 5_000;

/**
 * Invalidate one or more dates for a tenant, then immediately schedule a
 * background recompute so the cache is warm before the next request arrives.
 *
 * `computeFn` receives `(tenantId, dateStr, timezone)` and should recompute
 * slots for that contractor-local calendar date.
 *
 * `dates` may be null/undefined to invalidate ALL dates for the tenant and
 * recompute the next 14 days; otherwise provide YYYY-MM-DD strings that are
 * already in the contractor's local timezone.
 *
 * Rapid successive calls for the same tenant are debounced: only the last
 * call within DEBOUNCE_MS triggers a re-warm, preventing connection
 * exhaustion on the Neon serverless pool during HCP webhook bursts.
 */
export function invalidateAndRecompute(
  tenantId: string,
  timezone: string,
  computeFn: (tenantId: string, dateStr: string, timezone: string) => Promise<AvailableSlot[]>,
  dates?: string[] | null
): void {
  if (dates && dates.length > 0) {
    for (const d of dates) {
      invalidateAvailabilityCache(tenantId, d);
    }
  } else {
    invalidateAvailabilityCache(tenantId);
  }

  // Cancel any pending re-warm for this tenant so burst events collapse into one.
  const existing = recomputeDebounceMap.get(tenantId);
  if (existing) {
    clearTimeout(existing);
  }

  const timer = setTimeout(() => {
    recomputeDebounceMap.delete(tenantId);

    if (dates && dates.length > 0) {
      // Recompute only the specific invalidated dates, sequentially.
      (async () => {
        for (const d of dates) {
          try {
            const slots = await computeFn(tenantId, d, timezone);
            setCachedAvailability(tenantId, d, slots);
          } catch (err) {
            log.warn(`[availability-cache] Background recompute failed tenant=${tenantId} date=${d}:`, err);
          }
        }
      })();
    } else {
      // Full re-warm with the sequential concurrency cap inside warmAvailabilityCache.
      warmAvailabilityCache(tenantId, timezone, computeFn, 14).catch(err =>
        log.warn(`[availability-cache] Background warm failed tenant=${tenantId}:`, err)
      );
    }
  }, DEBOUNCE_MS);

  recomputeDebounceMap.set(tenantId, timer);
}
