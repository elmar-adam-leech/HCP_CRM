#!/bin/bash
set -e
npm install

# Pre-seed the drizzle.__drizzle_migrations table with all already-applied
# migration tags (0000–0013) so that drizzle-kit migrate does not try to
# re-run migrations that were previously applied via drizzle-kit push.
node -e "
const { Pool } = require('pg');
const url = process.env.NEON_DATABASE_URL || process.env.DATABASE_URL;
if (!url) { console.error('No DB URL'); process.exit(1); }
const pool = new Pool({ connectionString: url });

const tags = [
  '0000_past_sugar_man',
  '0001_oauth_states',
  '0002_enable_pg_trgm',
  '0003_booking_redirect_url',
  '0004_allowed_integrations',
  '0005_assignment_rules',
  '0006_lead_capture_inboxes',
  '0007_sender_rules',
  '0008_spam_threshold_audit_log',
  '0009_activities_unique_external_idx',
  '0010_salesperson_display_order',
  '0011_drop_contractor_webhook_api_key',
  '0012_contacts_trgm_indexes',
  '0013_schema_hardening',
];

async function run() {
  await pool.query(\`
    CREATE SCHEMA IF NOT EXISTS drizzle;
    CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
      id SERIAL PRIMARY KEY,
      hash TEXT NOT NULL UNIQUE,
      created_at BIGINT
    );
  \`);
  for (const tag of tags) {
    await pool.query(
      'INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES (\$1, \$2) ON CONFLICT DO NOTHING',
      [tag, Date.now()]
    );
    console.log('Migration seeded (idempotent):', tag);
  }
  pool.end();
}
run().catch(e => { console.error(e); process.exit(1); });
"

# Runs drizzle-kit migrate (non-interactive, no prompts ever).
# Using npx directly because the environment prevents editing package.json
# to add a db:migrate script; functionally equivalent to `npm run db:migrate`.
npx drizzle-kit migrate
