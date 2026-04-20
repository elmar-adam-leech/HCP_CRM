/**
 * CI entrypoint that catches missing schema migrations before deploy.
 *
 * Steps:
 *   1. Connect to a Postgres pointed at by DATABASE_URL (the CI workflow
 *      provisions an ephemeral one).
 *   2. Apply the bundled bootstrap snapshot (`migrations/0000_*.sql`).
 *   3. Apply the runtime `columnMigrations` block from `server/schema-drift.ts`.
 *   4. Run the same drift comparison the live server runs at boot.
 *
 * If a developer adds a column to `shared/schema/*` without adding a
 * matching idempotent statement to `columnMigrations`, the drift check
 * will fail this script with a non-zero exit, failing the PR before
 * any tenant database can drift.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import {
  applyColumnMigrations,
  runSchemaDriftCheck,
  type SchemaDriftLogger,
} from '../schema-drift';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const logger: SchemaDriftLogger = {
  info: (m) => process.stdout.write(`${m}\n`),
  warn: (m) => process.stderr.write(`${m}\n`),
};

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL must be set. In CI this should point at the ephemeral Postgres service.',
    );
  }

  const pool = new pg.Pool({ connectionString, max: 4 });

  try {
    // The bootstrap snapshot uses gen_random_bytes (pgcrypto) for default
    // values and pg_trgm for indexes. Enable both before applying it.
    for (const ext of ['pgcrypto', 'pg_trgm']) {
      try {
        await pool.query(`CREATE EXTENSION IF NOT EXISTS ${ext}`);
      } catch (err) {
        logger.warn(
          `[ci] ${ext} extension not available — continuing. ${(err as Error).message}`,
        );
      }
    }

    const bootstrapPath = resolve(__dirname, '../../migrations/0000_past_sugar_man.sql');
    logger.info(`[ci] applying bootstrap snapshot: ${bootstrapPath}`);
    const bootstrapSql = readFileSync(bootstrapPath, 'utf8');
    // drizzle-kit emits statements separated by `--> statement-breakpoint`
    const statements = bootstrapSql
      .split(/-->\s*statement-breakpoint/g)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const stmt of statements) {
      try {
        await pool.query(stmt);
      } catch (err) {
        const message = (err as Error).message;
        // The bootstrap is not strictly idempotent (no IF NOT EXISTS on
        // every statement). Tolerate "already exists" so re-runs against
        // a warm cache still work, but surface anything else.
        if (/already exists/i.test(message)) continue;
        logger.warn(`[ci] bootstrap statement failed: ${message}\n${stmt.slice(0, 200)}`);
        throw err;
      }
    }

    logger.info('[ci] bootstrap snapshot applied — running runtime columnMigrations');
    await applyColumnMigrations(pool, logger);

    logger.info('[ci] running schema drift check');
    await runSchemaDriftCheck(pool, logger);

    logger.info('[ci] OK — no schema drift detected.');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  process.stderr.write(`[ci] schema drift check FAILED: ${(err as Error).message}\n`);
  process.exit(1);
});
