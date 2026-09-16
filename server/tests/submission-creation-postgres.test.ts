import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { columnMigrations } from '../schema-drift';
import { isSubmissionCreationConflict } from '../utils/submission-identity';

// An isolated throwaway PostgreSQL instance: never reads application DB secrets.
const hasPostgres = spawnSync('pg_ctl', ['--version']).status === 0;
describe.skipIf(!hasPostgres)('submission creation uniqueness in PostgreSQL', () => {
  let dir: string;
  let pool: pg.Pool;
  let started = false;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'submission-pg-'));
    execFileSync('initdb', ['-D', join(dir, 'data'), '-A', 'trust', '-U', 'postgres'], { stdio: 'ignore' });
    execFileSync('pg_ctl', [
      '-D', join(dir, 'data'), '-l', join(dir, 'postgres.log'),
      '-o', `-k ${dir} -p 55439 -c listen_addresses=''`, '-w', 'start',
    ], { stdio: 'ignore' });
    started = true;
    pool = new pg.Pool({ host: dir, port: 55439, user: 'postgres', database: 'postgres', max: 8 });
    await pool.query('CREATE TABLE contacts (id serial PRIMARY KEY, contractor_id text NOT NULL)');
    const migration = columnMigrations.find(m => m.sql.includes('contacts_submission_creation_idx'))!;
    await pool.query(migration.sql);
    await pool.query(migration.sql); // Startup migrations must be safely repeatable.
  }, 30_000);
  afterAll(async () => {
    await pool?.end();
    if (started) execFileSync('pg_ctl', ['-D', join(dir, 'data'), '-m', 'immediate', '-w', 'stop'], { stdio: 'ignore' });
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('converges competing inserts onto one contact using the exact constraint error', async () => {
    const deliveries = await Promise.all(Array.from({ length: 20 }, async () => {
      try {
        const result = await pool.query(
          'INSERT INTO contacts (contractor_id, submission_creation_key) VALUES ($1, $2) RETURNING id',
          ['tenant-a', 'same-submission'],
        );
        return result.rows[0].id;
      } catch (error) {
        expect(isSubmissionCreationConflict({ cause: error })).toBe(true);
        const result = await pool.query(
          'SELECT id FROM contacts WHERE contractor_id = $1 AND submission_creation_key = $2',
          ['tenant-a', 'same-submission'],
        );
        return result.rows[0].id;
      }
    }));
    expect(new Set(deliveries).size).toBe(1);
    const count = await pool.query('SELECT count(*)::int AS count FROM contacts');
    expect(count.rows[0].count).toBe(1);
  });

  it('allows distinct IDs, tenant isolation, and unlimited unidentified submissions', async () => {
    const result = await pool.query(`INSERT INTO contacts (contractor_id, submission_creation_key)
      VALUES ('tenant-a', 'different-submission'), ('tenant-b', 'same-submission'),
        ('tenant-a', NULL), ('tenant-a', NULL) RETURNING id`);
    expect(new Set(result.rows.map(row => row.id)).size).toBe(4);
  });
});