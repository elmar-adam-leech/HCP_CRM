import { pool } from "../db";
import { logger } from "../utils/logger";
import { formatDbError } from "../utils/db-error";

const log = logger("JobLock");

/**
 * Postgres advisory-lock helper for one-shot background jobs.
 *
 * Why: background jobs that used to run on always-on in-app timers are now also
 * runnable as isolated Replit Scheduled Deployment invocations (see
 * `server/worker.ts`). Two invocations of the same job can overlap if one run
 * takes longer than the cron interval, and during the migration window an
 * in-app timer could overlap with a scheduled run. A session-level Postgres
 * advisory lock guarantees that only ONE holder of a given job name runs at a
 * time across every process and every machine that shares the database.
 *
 * The lock is held for the lifetime of `fn` on a dedicated pooled client (the
 * lock is session-scoped, so the SAME connection must take and release it),
 * and is always released in a `finally` block. If the lock is already held,
 * `fn` is skipped and `{ ran: false }` is returned — the next scheduled
 * invocation will pick the work up.
 */

// Deterministic signed-32-bit hash (FNV-1a) of the job name, used as the
// advisory-lock key. Cast to ::bigint in SQL so Postgres selects the
// single-argument pg_try_advisory_lock(bigint) overload.
function hashKey(name: string): number {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h | 0;
}

interface LockClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  release(err?: Error): void;
}

export interface JobLockResult<T> {
  /** True if the lock was acquired and `fn` ran; false if skipped (lock held). */
  ran: boolean;
  /** The return value of `fn` when `ran` is true. */
  result?: T;
}

export async function withJobLock<T>(
  name: string,
  fn: () => Promise<T>,
): Promise<JobLockResult<T>> {
  const key = hashKey(name);
  const client = (await (
    pool as unknown as { connect(): Promise<LockClient> }
  ).connect()) as LockClient;

  let locked = false;
  try {
    const res = await client.query("SELECT pg_try_advisory_lock($1::bigint) AS locked", [key]);
    locked = res.rows[0]?.locked === true;
    if (!locked) {
      log.warn(`Skipping job "${name}" — another invocation holds the advisory lock (key=${key})`);
      return { ran: false };
    }
    const result = await fn();
    return { ran: true, result };
  } finally {
    if (locked) {
      try {
        await client.query("SELECT pg_advisory_unlock($1::bigint)", [key]);
      } catch (err) {
        log.error(`Failed to release advisory lock for "${name}": ${formatDbError(err)}`);
      }
    }
    client.release();
  }
}
