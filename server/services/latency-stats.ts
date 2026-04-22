/**
 * In-process per-route latency aggregator.
 *
 * Records per-request durations into a fixed-size circular buffer per route key
 * (`${METHOD} ${routeKey}`) and computes p50/p95/p99/avg on demand. Memory is
 * bounded: at most BUFFER_SIZE samples per route. The window resets on every
 * server restart — that's fine; this exists to drive optimization decisions,
 * not for alerting.
 *
 * See task #593: "Measure backend latency per endpoint so we know what's slow".
 */

const BUFFER_SIZE = 2000;

interface RouteBuffer {
  samples: number[];      // fixed capacity = BUFFER_SIZE
  count: number;          // total writes (may exceed BUFFER_SIZE due to wrap)
  writeIdx: number;       // next write position
  sum: number;            // running sum of currently-stored samples for avg
  statuses: Map<number, number>;
}

const buffers = new Map<string, RouteBuffer>();
let windowStartedAt = new Date();

/** UUID — 8-4-4-4-12 hex form. */
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
/** All-digit segment (numeric IDs). */
const INT_RE = /^\d+$/;

/**
 * Normalize a raw URL path into a route key suitable for bucketing.
 *  - Strips query string.
 *  - Replaces UUID and integer segments with `:id`.
 * Used as a fallback when Express's matched route template isn't available
 * (e.g. paths that resolved entirely inside middleware).
 */
export function normalizePath(rawPath: string): string {
  const qIdx = rawPath.indexOf('?');
  const path = qIdx >= 0 ? rawPath.slice(0, qIdx) : rawPath;
  const parts = path.split('/');
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i];
    if (!seg) continue;
    if (UUID_RE.test(seg) || INT_RE.test(seg)) {
      parts[i] = ':id';
    }
  }
  return parts.join('/') || '/';
}

export function recordRequest(
  method: string,
  routeKey: string,
  statusCode: number,
  durationMs: number,
): void {
  const key = `${method} ${routeKey}`;
  let buf = buffers.get(key);
  if (!buf) {
    buf = {
      samples: [],
      count: 0,
      writeIdx: 0,
      sum: 0,
      statuses: new Map(),
    };
    buffers.set(key, buf);
  }

  if (buf.samples.length < BUFFER_SIZE) {
    buf.samples.push(durationMs);
    buf.sum += durationMs;
  } else {
    const evicted = buf.samples[buf.writeIdx];
    buf.samples[buf.writeIdx] = durationMs;
    buf.sum += durationMs - evicted;
    buf.writeIdx = (buf.writeIdx + 1) % BUFFER_SIZE;
  }
  buf.count++;
  buf.statuses.set(statusCode, (buf.statuses.get(statusCode) ?? 0) + 1);
}

interface RouteStats {
  key: string;
  count: number;
  p50: number;
  p95: number;
  p99: number;
  avg: number;
  statuses: Record<number, number>;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return Math.round(sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo));
}

export interface LatencySnapshot {
  windowSize: number;
  since: string;
  routes: RouteStats[];
}

export function getStats(): LatencySnapshot {
  const routes: RouteStats[] = [];
  for (const [key, buf] of buffers.entries()) {
    if (buf.samples.length === 0) continue;
    const sorted = [...buf.samples].sort((a, b) => a - b);
    const statuses: Record<number, number> = {};
    for (const [code, n] of buf.statuses.entries()) statuses[code] = n;
    routes.push({
      key,
      count: buf.count,
      p50: quantile(sorted, 0.5),
      p95: quantile(sorted, 0.95),
      p99: quantile(sorted, 0.99),
      avg: Math.round(buf.sum / buf.samples.length),
      statuses,
    });
  }
  routes.sort((a, b) => b.p95 - a.p95);
  return {
    windowSize: BUFFER_SIZE,
    since: windowStartedAt.toISOString(),
    routes,
  };
}

/** Test-only: reset all internal state. */
export function _resetForTests(): void {
  buffers.clear();
  windowStartedAt = new Date();
}
