import { Pool as NeonPool, neonConfig } from '@neondatabase/serverless';
import { drizzle as neonDrizzle } from 'drizzle-orm/neon-serverless';
import pg from 'pg';
import { drizzle as pgDrizzle } from 'drizzle-orm/node-postgres';
import ws from "ws";
import * as schema from "@shared/schema";
import { applyColumnMigrations, runSchemaDriftCheck } from "./schema-drift";

const isProduction = process.env.NODE_ENV === 'production';

// Minimal interface for the subset of pool capabilities used by this codebase:
// - `query()` for raw SQL (pg_trgm extension check in initDb)
// - `options?.max` for logging pool config at startup
// - `end()` for graceful shutdown
interface AppPool {
  query(sql: string): Promise<unknown>;
  options?: { max?: number };
  end(): Promise<void>;
}

function initializeDatabase(): { pool: AppPool; db: ReturnType<typeof neonDrizzle> | ReturnType<typeof pgDrizzle> } {
  if (isProduction) {
    if (!process.env.NEON_DATABASE_URL) {
      throw new Error("NEON_DATABASE_URL must be set in production.");
    }
    neonConfig.webSocketConstructor = ws;
    // Force every server-side session to have a 60s statement_timeout via the
    // Postgres `options` startup parameter. This is applied at session-start
    // by the server itself — no extra SQL round-trip, no race window where a
    // first query could run without the timeout. Without this, a DDL waiting
    // on a lock (e.g. held by a previous crash-looping instance) hangs
    // forever and Node exits silently with code 13 ("Unfinished Top-Level
    // Await") — no error, no stack trace. 60s is comfortably longer than any
    // legitimate query/DDL in this codebase and short enough to surface lock
    // contention as a real Postgres rejection that the unhandledRejection
    // handler can catch.
    const neonUrl = new URL(process.env.NEON_DATABASE_URL);
    if (!neonUrl.searchParams.has('options')) {
      neonUrl.searchParams.set('options', '-c statement_timeout=60000');
    }
    const neonPool = new NeonPool({
      connectionString: neonUrl.toString(),
      max: Number(process.env.DB_POOL_MAX ?? 20),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    const neonDb = neonDrizzle({ client: neonPool, schema });
    return { pool: neonPool, db: neonDb };
  } else {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL must be set in development.");
    }
    const pgPool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      max: Number(process.env.DB_POOL_MAX ?? 20),
    });
    const pgDb = pgDrizzle({ client: pgPool, schema });
    return { pool: pgPool, db: pgDb };
  }
}

const { pool, db } = initializeDatabase();

// This runs at module load time so it intentionally uses a direct stderr write
// (rather than the structured logger) because the logger itself may not yet be
// initialised at this point in the startup sequence.
process.stderr.write(
  `[DB] pool initialized — max: ${pool.options?.max ?? 'N/A'} (${isProduction ? 'Neon/production' : 'local/development'})\n`
);

export { pool, db };

export async function initDb(): Promise<void> {
  process.stderr.write('[db] step: pg_trgm\n');
  try {
    await pool.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[db] pg_trgm extension not available — full-text search will be slow. ` +
      `Run: CREATE EXTENSION IF NOT EXISTS pg_trgm; on your database. ${message}\n`
    );
  }

  process.stderr.write('[db] step: applyColumnMigrations\n');
  await applyColumnMigrations(pool);
  process.stderr.write('[db] step: runSchemaDriftCheck\n');
  await runSchemaDriftCheck(pool);
  process.stderr.write('[db] step: initDb done\n');
}
