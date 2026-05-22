import { Pool as NeonPool, neonConfig } from '@neondatabase/serverless';
import { drizzle as neonDrizzle } from 'drizzle-orm/neon-serverless';
import pg from 'pg';
import { drizzle as pgDrizzle } from 'drizzle-orm/node-postgres';
import ws from "ws";
import * as schema from "@shared/schema";
import { applyColumnMigrations, runSchemaDriftCheck } from "./schema-drift";

const isProduction = process.env.NODE_ENV === 'production';

// Task #757 — pool tuning constants. Centralised here so the values are
// discoverable in one place and so the structured acquire-timeout log can
// report the same numbers it's enforcing.
//
// connectionTimeoutMillis: bumped from 5s → 10s. Neon serverless WebSocket
//   compute resume can spend several seconds establishing a fresh socket;
//   5s was below the documented worst case and was the proximate cause of
//   the "timeout exceeded when trying to connect" floods in production.
// idleTimeoutMillis: lowered from 30s → 10s so Neon can scale the compute
//   down between bursts without us holding empty sockets across the
//   serverless cold-start boundary.
// statement_timeout: applied per-client via the pool's `connect` event so
//   no single runaway query can hold a client for the full pool-acquire
//   window and starve the rest of the request load.
const DB_CONNECT_TIMEOUT_MS = Number(process.env.DB_CONNECT_TIMEOUT_MS ?? 10_000);
const DB_IDLE_TIMEOUT_MS = Number(process.env.DB_IDLE_TIMEOUT_MS ?? 10_000);
const DB_STATEMENT_TIMEOUT_MS = Number(process.env.DB_STATEMENT_TIMEOUT_MS ?? 30_000);
const DB_POOL_MAX = Number(process.env.DB_POOL_MAX ?? 20);

// Acquire-retry: a single bounded retry on the documented Neon transient
// WebSocket failure mode. Collapses transient compute-resume failures into
// a successful query without papering over a real outage (cap at 1 retry,
// log every retry so abuse is visible).
const DB_ACQUIRE_RETRY_DELAY_MS = 250;
const DB_ACQUIRE_RETRY_JITTER_MS = 250;

// Minimal interface for the subset of pool capabilities used by this codebase:
// - `query()` for raw SQL (pg_trgm extension check in initDb)
// - `options?.max` for logging pool config at startup
// - `end()` for graceful shutdown
interface AppPool {
  query(sql: string): Promise<unknown>;
  options?: { max?: number };
  end(): Promise<void>;
}

// Surface of the Neon/pg Pool that the retry/metrics shim needs. Kept
// loose because Neon's serverless Pool extends pg-pool but the types are
// re-declared in @neondatabase/serverless.
type ConnectCallback = (err: Error | undefined, client?: unknown, release?: (err?: Error) => void) => void;
interface PoolWithMetrics {
  connect(cb?: ConnectCallback): Promise<{ release(): void } & Record<string, unknown>> | void;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  totalCount?: number;
  idleCount?: number;
  waitingCount?: number;
}

function isAcquireTimeoutError(err: unknown): boolean {
  if (!err) return false;
  const msg = err instanceof Error ? err.message : String(err);
  // pg-pool throws "timeout exceeded when trying to connect" when
  // connectionTimeoutMillis elapses with no free client.
  return /timeout exceeded when trying to connect/i.test(msg);
}

function poolMetrics(pool: PoolWithMetrics): { total: number; idle: number; waiting: number } {
  return {
    total: pool.totalCount ?? -1,
    idle: pool.idleCount ?? -1,
    waiting: pool.waitingCount ?? -1,
  };
}

function logAcquireTimeout(pool: PoolWithMetrics, op: 'connect' | 'query', attempt: number, willRetry: boolean): void {
  const m = poolMetrics(pool);
  // Direct stderr write — the structured logger imports this module so we
  // cannot import it here without a circular dependency.
  process.stderr.write(
    `[DB] acquire timeout op=${op} attempt=${attempt} willRetry=${willRetry} ` +
    `pool.total=${m.total} pool.idle=${m.idle} pool.waiting=${m.waiting} ` +
    `max=${DB_POOL_MAX} connectTimeoutMs=${DB_CONNECT_TIMEOUT_MS}\n`
  );
}

/**
 * Wrap `pool.connect()` and `pool.query()` so that a single transient
 * acquire timeout (Neon WebSocket compute-resume race) is retried once
 * with jitter before bubbling. The retry is bounded at 1 attempt by
 * construction — there's no recursive call — so a true pool-saturation
 * incident cannot amplify into a retry storm.
 *
 * The first failure ALWAYS logs the pool metrics (total/idle/waiting) so
 * ops can distinguish pool exhaustion (high `total`, high `waiting`) from
 * Neon-side connectivity (low `total`, low `waiting`).
 */
function installAcquireRetry(pool: PoolWithMetrics): void {
  // Wrap only `pool.connect()` — pg-pool's `pool.query()` internally calls
  // `this.connect(callback)` to acquire a client, so wrapping connect
  // covers both code paths.
  //
  // CRITICAL: pg-pool's `pool.connect` supports BOTH a promise form
  // (`connect(): Promise<Client>`) AND a callback form
  // (`connect((err, client, release) => {...}): void`), and `pool.query`
  // uses the callback form internally. An async-only wrapper would
  // silently never invoke the callback and `pool.query` would hang
  // forever (debugged at boot during task #757). We bridge both forms.
  const originalConnect = pool.connect.bind(pool) as PoolWithMetrics['connect'];

  async function acquireWithRetry(): Promise<unknown> {
    try {
      return await (originalConnect() as Promise<unknown>);
    } catch (err) {
      if (!isAcquireTimeoutError(err)) throw err;
      logAcquireTimeout(pool, 'connect', 1, /*willRetry*/ true);
      const jitter = Math.floor(Math.random() * DB_ACQUIRE_RETRY_JITTER_MS);
      await new Promise((r) => setTimeout(r, DB_ACQUIRE_RETRY_DELAY_MS + jitter));
      try {
        return await (originalConnect() as Promise<unknown>);
      } catch (err2) {
        if (isAcquireTimeoutError(err2)) logAcquireTimeout(pool, 'connect', 2, /*willRetry*/ false);
        throw err2;
      }
    }
  }

  (pool as { connect: (cb?: ConnectCallback) => Promise<unknown> | void }).connect = function patchedConnect(cb?: ConnectCallback) {
    if (typeof cb === 'function') {
      // Callback form (pg-pool internal `pool.query` uses this). We must
      // invoke `cb(err, client, release)` where `release` releases the
      // client. The PoolClient itself exposes `.release()`, so we adapt.
      acquireWithRetry().then(
        (client) => {
          const c = client as { release(err?: Error): void };
          cb(undefined, c, (err?: Error) => c.release(err));
        },
        (err) => cb(err instanceof Error ? err : new Error(String(err))),
      );
      return;
    }
    return acquireWithRetry();
  };
}

function initializeDatabase(): { pool: AppPool; db: ReturnType<typeof neonDrizzle> | ReturnType<typeof pgDrizzle> } {
  if (isProduction) {
    if (!process.env.NEON_DATABASE_URL) {
      throw new Error("NEON_DATABASE_URL must be set in production.");
    }
    neonConfig.webSocketConstructor = ws;
    const neonPool = new NeonPool({
      connectionString: process.env.NEON_DATABASE_URL,
      max: DB_POOL_MAX,
      idleTimeoutMillis: DB_IDLE_TIMEOUT_MS,
      connectionTimeoutMillis: DB_CONNECT_TIMEOUT_MS,
    });
    // Apply per-client statement_timeout so a runaway query cannot hold a
    // client for the full pool-acquire window. The listener fires for
    // every freshly-established backend connection (pg-pool semantics).
    neonPool.on('connect', (client: unknown) => {
      const c = client as { query(sql: string): Promise<unknown> };
      void c.query(`SET statement_timeout = ${DB_STATEMENT_TIMEOUT_MS}`).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[DB] failed to set statement_timeout on new client: ${message}\n`);
      });
    });
    installAcquireRetry(neonPool as unknown as PoolWithMetrics);
    const neonDb = neonDrizzle({ client: neonPool, schema });
    return { pool: neonPool, db: neonDb };
  } else {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL must be set in development.");
    }
    const pgPool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      max: DB_POOL_MAX,
      idleTimeoutMillis: DB_IDLE_TIMEOUT_MS,
      connectionTimeoutMillis: DB_CONNECT_TIMEOUT_MS,
    });
    pgPool.on('connect', (client: pg.PoolClient) => {
      void client.query(`SET statement_timeout = ${DB_STATEMENT_TIMEOUT_MS}`).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[DB] failed to set statement_timeout on new client: ${message}\n`);
      });
    });
    installAcquireRetry(pgPool as unknown as PoolWithMetrics);
    const pgDb = pgDrizzle({ client: pgPool, schema });
    return { pool: pgPool, db: pgDb };
  }
}

const { pool, db } = initializeDatabase();

// This runs at module load time so it intentionally uses a direct stderr write
// (rather than the structured logger) because the logger itself may not yet be
// initialised at this point in the startup sequence.
process.stderr.write(
  `[DB] pool initialized — max: ${pool.options?.max ?? 'N/A'} ` +
  `connectTimeoutMs=${DB_CONNECT_TIMEOUT_MS} idleTimeoutMs=${DB_IDLE_TIMEOUT_MS} ` +
  `statementTimeoutMs=${DB_STATEMENT_TIMEOUT_MS} ` +
  `(${isProduction ? 'Neon/production' : 'local/development'})\n`
);

export { pool, db };

/**
 * Returns a snapshot of pool client counts for diagnostic endpoints /
 * tests. Values are -1 when the underlying pool doesn't expose them
 * (e.g. a mock).
 */
export function getPoolMetrics(): { total: number; idle: number; waiting: number } {
  return poolMetrics(pool as unknown as PoolWithMetrics);
}

export async function initDb(): Promise<void> {
  const client = isProduction
    ? await (pool as unknown as { connect(): Promise<{ query(s: string): Promise<unknown>; release(): void }> }).connect()
    : null;
  const q: { query(s: string): Promise<unknown> } = client ?? pool;

  try {
    if (client) {
      // initDb runs DDL (CREATE EXTENSION, ALTER TABLE, schema drift scan)
      // which can legitimately take longer than the per-client default
      // applied at pool-connect time. Override to 60s for this session.
      await client.query('SET statement_timeout = 60000');
      process.stderr.write('[db] statement_timeout set to 60s for init queries\n');
    }

    process.stderr.write('[db] step: pg_trgm\n');
    try {
      await q.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[db] pg_trgm extension not available — full-text search will be slow. ` +
        `Run: CREATE EXTENSION IF NOT EXISTS pg_trgm; on your database. ${message}\n`
      );
    }

    process.stderr.write('[db] step: applyColumnMigrations\n');
    await applyColumnMigrations(q);
    process.stderr.write('[db] step: runSchemaDriftCheck\n');
    await runSchemaDriftCheck(q);
    process.stderr.write('[db] step: initDb done\n');
  } finally {
    if (client) client.release();
  }
}
