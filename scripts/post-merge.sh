#!/bin/bash
set -e
npm install

# Decide whether drizzle-kit migrate has anything to do. The legacy backfill
# loop that used to live here (seeding tags 0000-0013 into
# drizzle.__drizzle_migrations) has been removed: those rows are already
# present in every environment that has merged at least once, and from 0014
# on Drizzle records its own work. See git history if a re-backfill is ever
# needed.
#
# Drizzle stores either:
#   - the legacy tag string (from the old backfill loop), or
#   - sha256(file contents) (from a real `drizzle-kit migrate` run)
# in the `hash` column. We accept either as "already applied".
node -e "
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const url = process.env.NEON_DATABASE_URL || process.env.DATABASE_URL;
if (!url) { console.error('No DB URL'); process.exit(1); }

const migrationsDir = 'migrations';
if (!fs.existsSync(migrationsDir)) {
  console.log('No migrations/ directory — nothing to check.');
  process.exit(0);
}
const entries = fs.readdirSync(migrationsDir)
  .filter(f => f.endsWith('.sql'))
  .sort()
  .map(f => {
    const sql = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
    return { tag: f.replace(/\.sql$/, ''), hash: crypto.createHash('sha256').update(sql).digest('hex') };
  });

const pool = new Pool({ connectionString: url });
(async () => {
  const res = await pool.query(\`
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'drizzle' AND table_name = '__drizzle_migrations'
  \`);
  if (res.rowCount === 0) {
    process.exit(2); // table missing — let drizzle-kit migrate create it
  }
  const rows = await pool.query('SELECT hash FROM drizzle.__drizzle_migrations');
  const known = new Set(rows.rows.map(r => r.hash));
  const missing = entries.filter(e => !known.has(e.hash) && !known.has(e.tag));
  await pool.end();
  if (missing.length === 0) {
    console.log('No new migrations to apply.');
    process.exit(0);
  }
  console.log('Pending migrations:', missing.map(m => m.tag).join(', '));
  process.exit(2);
})().catch(e => { console.error(e); process.exit(1); });
" && status=0 || status=$?
if [ $status -eq 0 ]; then
  exit 0
elif [ $status -ne 2 ]; then
  exit $status
fi

# Runs drizzle-kit migrate (non-interactive, no prompts ever).
# Using npx directly because the environment prevents editing package.json
# to add a db:migrate script; functionally equivalent to `npm run db:migrate`.
npx drizzle-kit migrate
