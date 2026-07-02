import { isTable, getTableName, getTableColumns, type Table } from "drizzle-orm";
import * as schema from "@shared/schema";

export interface SchemaDriftPool {
  query(sql: string): Promise<unknown>;
}

export interface SchemaDriftLogger {
  info(message: string): void;
  warn(message: string): void;
}

export const defaultLogger: SchemaDriftLogger = {
  info: (m) => process.stderr.write(m.endsWith('\n') ? m : `${m}\n`),
  warn: (m) => process.stderr.write(m.endsWith('\n') ? m : `${m}\n`),
};

// ──────────────────────────────────────────────────────────────────────────
// SINGLE SOURCE OF TRUTH for runtime schema changes.
//
// Every column / index / table / enum value that the Drizzle schema in
// `shared/schema/*` declares — beyond the initial bootstrap in
// `migrations/0000_*.sql` — MUST have a corresponding idempotent statement
// in this array. Do **not** rely on `drizzle-kit push`, ad-hoc psql, or new
// SQL files in `migrations/` to roll out a column to existing tenants:
// those paths only touch one database and silently leave the others behind,
// which is what caused the recurring "column does not exist" 500s
// (tasks #432, #433, #434). The `runSchemaDriftCheck()` enforces this rule
// by failing loudly when a Drizzle-declared column is missing from the
// database — both at server boot (`server/db.ts`) and in CI against an
// ephemeral Postgres (`server/scripts/check-schema-drift.ts`).
//
// All statements must be idempotent (`IF NOT EXISTS`, `DO $$ ... END $$`,
// etc.) because this block runs on every boot.
// ──────────────────────────────────────────────────────────────────────────
export const columnMigrations: Array<{ sql: string; description: string }> = [
    {
      sql: `ALTER TABLE user_contractors ADD COLUMN IF NOT EXISTS allowed_integrations text[]`,
      description: 'user_contractors.allowed_integrations (per-user integration permissions)',
    },
    {
      sql: `ALTER TABLE sales_processes ADD COLUMN IF NOT EXISTS stop_statuses text[]`,
      description: 'sales_processes.stop_statuses (per-cadence early-stop statuses, task #725)',
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS "assignment_rules" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "contractor_id" varchar NOT NULL REFERENCES "contractors"("id") ON DELETE CASCADE,
        "name" text NOT NULL,
        "conditions" text NOT NULL DEFAULT '[]',
        "assign_to_user_id" varchar REFERENCES "users"("id") ON DELETE SET NULL,
        "priority" integer NOT NULL DEFAULT 0,
        "is_active" boolean NOT NULL DEFAULT true,
        "created_at" timestamp NOT NULL DEFAULT now(),
        "updated_at" timestamp NOT NULL DEFAULT now()
      ); CREATE INDEX IF NOT EXISTS "assignment_rules_contractor_id_idx" ON "assignment_rules" ("contractor_id"); CREATE INDEX IF NOT EXISTS "assignment_rules_priority_idx" ON "assignment_rules" ("contractor_id", "priority")`,
      description: 'assignment_rules table (lead assignment rules)',
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS "lead_capture_inboxes" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        "contractor_id" varchar NOT NULL REFERENCES "contractors"("id"),
        "email_address" text NOT NULL,
        "gmail_refresh_token" text NOT NULL,
        "last_sync_at" timestamp,
        "spam_filter_enabled" boolean NOT NULL DEFAULT false,
        "is_active" boolean NOT NULL DEFAULT true,
        "created_at" timestamp DEFAULT now() NOT NULL,
        "updated_at" timestamp DEFAULT now() NOT NULL,
        CONSTRAINT "lead_capture_inboxes_contractor_id_unique" UNIQUE("contractor_id")
      )`,
      description: 'lead_capture_inboxes table (lead capture email inbox per contractor)',
    },
    {
      sql: `ALTER TABLE estimates ADD COLUMN IF NOT EXISTS hcp_options jsonb`,
      description: 'estimates.hcp_options (HCP estimate options array)',
    },
    {
      sql: `ALTER TABLE estimates
            ADD COLUMN IF NOT EXISTS status_manually_set boolean NOT NULL DEFAULT false`,
      description: 'estimates.status_manually_set (per-estimate manual-status flag)',
    },
    {
      sql: `ALTER TABLE lead_capture_inboxes ADD COLUMN IF NOT EXISTS sender_rules jsonb DEFAULT '[]'::jsonb`,
      description: 'lead_capture_inboxes.sender_rules (per-sender email handling rules)',
    },
    {
      sql: `ALTER TABLE lead_capture_inboxes ADD COLUMN IF NOT EXISTS spam_confidence_threshold integer NOT NULL DEFAULT 80`,
      description: 'lead_capture_inboxes.spam_confidence_threshold (configurable spam threshold)',
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS "spam_audit_log" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        "inbox_id" varchar NOT NULL REFERENCES "lead_capture_inboxes"("id"),
        "contractor_id" varchar NOT NULL REFERENCES "contractors"("id"),
        "sender_email" text NOT NULL,
        "subject" text NOT NULL,
        "body" text NOT NULL,
        "spam_confidence" integer NOT NULL,
        "reason" text,
        "flagged_at" timestamp DEFAULT now() NOT NULL,
        "recovered_at" timestamp,
        "recovered_lead_id" varchar
      )`,
      description: 'spam_audit_log table (audit log of emails flagged as spam)',
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS spam_audit_log_inbox_id_idx ON spam_audit_log(inbox_id)`,
      description: 'spam_audit_log.inbox_id index',
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS spam_audit_log_contractor_id_idx ON spam_audit_log(contractor_id)`,
      description: 'spam_audit_log.contractor_id index',
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS "hcp_excluded_customers" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        "contractor_id" varchar NOT NULL REFERENCES "contractors"("id"),
        "hcp_customer_id" varchar NOT NULL,
        "excluded_at" timestamp DEFAULT now() NOT NULL
      )`,
      description: 'hcp_excluded_customers table (track deleted HCP customers to prevent re-sync)',
    },
    {
      sql: `CREATE UNIQUE INDEX IF NOT EXISTS hcp_excluded_customers_contractor_customer_idx ON hcp_excluded_customers(contractor_id, hcp_customer_id)`,
      description: 'hcp_excluded_customers unique index on (contractor_id, hcp_customer_id)',
    },
    {
      sql: `ALTER TABLE contractors ADD COLUMN IF NOT EXISTS estimate_archive_days integer`,
      description: 'contractors.estimate_archive_days (estimate active window setting)',
    },
    {
      sql: `ALTER TABLE contractors ADD COLUMN IF NOT EXISTS hcp_send_leads boolean NOT NULL DEFAULT true`,
      description: 'contractors.hcp_send_leads (controls whether new leads are pushed to HCP)',
    },
    {
      sql: `ALTER TABLE contractors ADD COLUMN IF NOT EXISTS hcp_sync_skip_tags text[] NOT NULL DEFAULT '{}'`,
      description: 'contractors.hcp_sync_skip_tags (lead tags that should skip HCP sync)',
    },
    {
      sql: `ALTER TABLE user_contractors ADD COLUMN IF NOT EXISTS display_order integer`,
      description: 'user_contractors.display_order (salesperson display ordering)',
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS webhook_events_cleanup_idx ON webhook_events(created_at, processed)`,
      description: 'webhook_events (created_at, processed) index for cleanup job',
    },
    {
      // Partial index intended to make the DialpadEventPoller's
      //   WHERE service = 'dialpad' AND processed = false
      // query cheap as the table grows. Declared in
      // shared/schema/messages.ts but only present in the bundled
      // migrations/0000_*.sql snapshot, which is not run on existing prod
      // databases. As webhook_events grows, the seq scan gets slow enough
      // to hit Neon's statement_timeout, surfacing as the recurring
      // "Failed to query unprocessed dialpad webhook events" error in
      // production logs (task #406). This idempotent CREATE backfills the
      // index on every existing tenant.
      sql: `CREATE INDEX IF NOT EXISTS webhook_events_unprocessed_idx ON webhook_events(created_at) WHERE processed = false`,
      description: 'webhook_events partial index on unprocessed rows (planner hint for DialpadEventPoller — fixes #406 stuck-events backlog)',
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS workflow_executions_status_resume_idx ON workflow_executions(status, resume_at)`,
      description: 'workflow_executions (status, resume_at) composite index for suspended-execution poller',
    },
    {
      sql: `ALTER TYPE estimate_status ADD VALUE IF NOT EXISTS 'scheduled'`,
      description: 'estimate_status enum: add scheduled value',
    },
    {
      sql: `ALTER TYPE estimate_status ADD VALUE IF NOT EXISTS 'in_progress'`,
      description: 'estimate_status enum: add in_progress value',
    },
    {
      sql: `DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM pg_enum
          WHERE enumlabel = 'pending'
            AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'estimate_status')
        ) THEN
          UPDATE estimates SET status = 'scheduled' WHERE status = 'pending' AND external_source = 'housecall-pro' AND scheduled_start IS NOT NULL;
        END IF;
      END $$`,
      description: 'backfill: reclassify HCP pending estimates with scheduled_start as scheduled',
    },
    {
      sql: `DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE table_name = 'user_contractors'
            AND constraint_name = 'user_contractors_user_id_contractor_id_unique'
            AND constraint_type = 'UNIQUE'
        ) THEN
          ALTER TABLE user_contractors ADD CONSTRAINT user_contractors_user_id_contractor_id_unique UNIQUE (user_id, contractor_id);
        END IF;
      END $$`,
      description: 'user_contractors unique constraint on (user_id, contractor_id)',
    },
    {
      sql: `ALTER TYPE workflow_action_type ADD VALUE IF NOT EXISTS 'set_follow_up'`,
      description: 'workflow_action_type enum: add set_follow_up value',
    },
    {
      sql: `ALTER TYPE lead_status ADD VALUE IF NOT EXISTS 'lost'`,
      description: 'lead_status enum: add lost value (#516)',
    },
    {
      sql: `ALTER TYPE contact_status ADD VALUE IF NOT EXISTS 'lost'`,
      description: 'contact_status enum: add lost value (#516)',
    },
    {
      sql: `ALTER TYPE workflow_trigger_type ADD VALUE IF NOT EXISTS 'estimate_option_approved'`,
      description: 'workflow_trigger_type enum: add estimate_option_approved value (#437)',
    },
    {
      sql: `ALTER TYPE workflow_trigger_type ADD VALUE IF NOT EXISTS 'estimate_option_rejected'`,
      description: 'workflow_trigger_type enum: add estimate_option_rejected value (#437)',
    },
    {
      sql: `ALTER TYPE workflow_trigger_type ADD VALUE IF NOT EXISTS 'estimate_stale'`,
      description: 'workflow_trigger_type enum: add estimate_stale value (#437)',
    },
    {
      sql: `ALTER TYPE workflow_trigger_type ADD VALUE IF NOT EXISTS 'payment_received'`,
      description: 'workflow_trigger_type enum: add payment_received value (#437)',
    },
    {
      sql: `ALTER TYPE workflow_trigger_type ADD VALUE IF NOT EXISTS 'deposit_received'`,
      description: 'workflow_trigger_type enum: add deposit_received value (#437)',
    },
    {
      sql: `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS follow_up_date timestamp`,
      description: 'jobs.follow_up_date (nullable timestamp for follow-up scheduling)',
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS jobs_follow_up_date_idx ON jobs (contractor_id, follow_up_date) WHERE follow_up_date IS NOT NULL`,
      description: 'jobs.follow_up_date index for efficient follow-up queries',
    },
    {
      sql: `ALTER TABLE templates ADD COLUMN IF NOT EXISTS subject text`,
      description: 'templates.subject (email subject line for email templates)',
    },
    {
      sql: `DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'contractor_credentials' AND column_name = 'tenant_id'
        ) THEN
          ALTER TABLE contractor_credentials RENAME COLUMN tenant_id TO contractor_id;
        END IF;
      END $$`,
      description: 'contractor_credentials: rename tenant_id -> contractor_id (migration 0015)',
    },
    {
      sql: `DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'contractor_providers' AND column_name = 'tenant_id'
        ) THEN
          ALTER TABLE contractor_providers RENAME COLUMN tenant_id TO contractor_id;
        END IF;
      END $$`,
      description: 'contractor_providers: rename tenant_id -> contractor_id (migration 0015)',
    },
    {
      sql: `DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'contractor_integrations' AND column_name = 'tenant_id'
        ) THEN
          ALTER TABLE contractor_integrations RENAME COLUMN tenant_id TO contractor_id;
        END IF;
      END $$`,
      description: 'contractor_integrations: rename tenant_id -> contractor_id (migration 0015)',
    },
    {
      sql: `ALTER TABLE contractors ADD COLUMN IF NOT EXISTS logo_url text`,
      description: 'contractors.logo_url (company logo: https URL or base64 data URI)',
    },
    {
      sql: `ALTER TABLE contractors ADD COLUMN IF NOT EXISTS brand_color text`,
      description: 'contractors.brand_color (optional brand/accent hex color used to theme the public booking page)',
    },
    {
      sql: `ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_enabled boolean NOT NULL DEFAULT false`,
      description: 'users.mfa_enabled (whether TOTP-based MFA is enabled)',
    },
    {
      sql: `ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_secret_encrypted jsonb`,
      description: 'users.mfa_secret_encrypted (AES-256-GCM encrypted TOTP secret)',
    },
    {
      sql: `ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_recovery_codes jsonb NOT NULL DEFAULT '[]'::jsonb`,
      description: 'users.mfa_recovery_codes (bcrypt-hashed one-time recovery codes)',
    },
    {
      sql: `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS last_activity_at timestamp`,
      description: 'contacts.last_activity_at (for retention policy queries)',
    },
    {
      sql: `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS erased_at timestamp`,
      description: 'contacts.erased_at (GDPR erasure timestamp)',
    },
    {
      sql: `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS anonymized boolean NOT NULL DEFAULT false`,
      description: 'contacts.anonymized (GDPR anonymization flag)',
    },
    {
      sql: `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS retention_flagged_at timestamp`,
      description: 'contacts.retention_flagged_at (data retention review flag)',
    },
    {
      sql: `ALTER TABLE contractors ADD COLUMN IF NOT EXISTS data_retention_months integer`,
      description: 'contractors.data_retention_months (per-tenant data retention policy)',
    },
    {
      sql: `ALTER TABLE contractors ADD COLUMN IF NOT EXISTS privacy_notice_markdown text`,
      description: 'contractors.privacy_notice_markdown (per-tenant privacy notice)',
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS "consent_logs" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "contractor_id" varchar NOT NULL REFERENCES "contractors"("id"),
        "contact_id" varchar REFERENCES "contacts"("id") ON DELETE SET NULL,
        "user_id" varchar REFERENCES "users"("id") ON DELETE SET NULL,
        "source" text NOT NULL,
        "opt_in_type" text NOT NULL DEFAULT 'implied',
        "consent_version" text NOT NULL,
        "ip_hash" text,
        "metadata" jsonb DEFAULT '{}'::jsonb,
        "withdrawn_at" timestamp,
        "created_at" timestamp DEFAULT now() NOT NULL
      )`,
      description: 'consent_logs table (GDPR/CCPA consent tracking)',
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS consent_logs_contractor_created_at_idx ON consent_logs(contractor_id, created_at)`,
      description: 'consent_logs composite index on (contractor_id, created_at)',
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS consent_logs_contact_id_idx ON consent_logs(contact_id)`,
      description: 'consent_logs index on contact_id',
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS "audit_logs" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "contractor_id" varchar REFERENCES "contractors"("id") ON DELETE CASCADE,
        "user_id" varchar REFERENCES "users"("id") ON DELETE SET NULL,
        "action" text NOT NULL,
        "entity_type" text,
        "entity_id" text,
        "before" jsonb,
        "after" jsonb,
        "reason" text,
        "ip_address" text,
        "user_agent" text,
        "created_at" timestamp NOT NULL DEFAULT now()
      )`,
      description: 'audit_logs table (SOC 2 evidence store and GDPR audit trail)',
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS audit_logs_contractor_created_at_idx ON audit_logs(contractor_id, created_at)`,
      description: 'audit_logs composite index on (contractor_id, created_at)',
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS audit_logs_user_id_idx ON audit_logs(user_id)`,
      description: 'audit_logs.user_id index',
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS audit_logs_entity_id_idx ON audit_logs(entity_id)`,
      description: 'audit_logs index on entity_id for filtering by contact/job/etc',
    },
    {
      sql: `ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS reason text`,
      description: 'audit_logs.reason (GDPR erasure/retention reason)',
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS "hcp_calendar_events" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "contractor_id" varchar NOT NULL REFERENCES "contractors"("id") ON DELETE CASCADE,
        "hcp_event_id" varchar NOT NULL,
        "hcp_employee_id" varchar NOT NULL,
        "start_time" timestamp NOT NULL,
        "end_time" timestamp NOT NULL,
        "title" text,
        "status" text,
        "synced_at" timestamp NOT NULL DEFAULT now()
      )`,
      description: 'hcp_calendar_events table (HCP manual time blocks for local availability queries)',
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS hcp_calendar_events_contractor_employee_idx ON hcp_calendar_events(contractor_id, hcp_employee_id)`,
      description: 'hcp_calendar_events index on (contractor_id, hcp_employee_id)',
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS hcp_calendar_events_start_time_idx ON hcp_calendar_events(contractor_id, start_time)`,
      description: 'hcp_calendar_events index on (contractor_id, start_time)',
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS hcp_calendar_events_hcp_event_id_idx ON hcp_calendar_events(contractor_id, hcp_event_id)`,
      description: 'hcp_calendar_events index on (contractor_id, hcp_event_id)',
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS workflows_active_approved_idx ON workflows(contractor_id, is_active, approval_status)`,
      description: 'workflows composite index on (contractor_id, is_active, approval_status) for triggerWorkflowsForEvent',
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS estimates_contractor_follow_up_idx ON estimates(contractor_id, follow_up_date) WHERE follow_up_date IS NOT NULL`,
      description: 'estimates contractor-scoped follow-up index (contractor_id, follow_up_date) partial where non-null',
    },
    {
      sql: `DROP TYPE IF EXISTS dialpad_owner_type`,
      description: 'drop orphaned dialpad_owner_type enum (never used as a column type)',
    },
    {
      sql: `DROP TYPE IF EXISTS employee_role`,
      description: 'drop orphaned employee_role enum (employees table uses text[] instead)',
    },
    {
      sql: `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS street text`,
      description: 'contacts.street (structured address: street line)',
    },
    {
      sql: `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS city text`,
      description: 'contacts.city (structured address: city)',
    },
    {
      sql: `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS state text`,
      description: 'contacts.state (structured address: state)',
    },
    {
      sql: `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS zip text`,
      description: 'contacts.zip (structured address: zip code)',
    },
    {
      sql: `ALTER TABLE scheduled_bookings ADD COLUMN IF NOT EXISTS booking_payload jsonb`,
      description: 'scheduled_bookings.booking_payload (raw request body for audit trail)',
    },
    {
      sql: `DROP TABLE IF EXISTS calls`,
      description: 'drop orphaned calls table (replaced by activity metadata; nothing reads from it)',
    },
    {
      sql: `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS booking_code text`,
      description: 'contacts.booking_code (short alphanumeric code for clean booking URLs)',
    },
    {
      sql: `CREATE UNIQUE INDEX IF NOT EXISTS contacts_booking_code_idx ON contacts(booking_code) WHERE booking_code IS NOT NULL`,
      description: 'contacts.booking_code unique index (for fast short-code lookups)',
    },
    {
      // Task #792 — backfill booking_code for any contact rows still missing
      // one so the workflow/SMS booking-link emitters can always produce a
      // ?c=<code> URL and never fall back to the legacy ?contactId=<uuid>
      // form. Idempotent: only touches rows where booking_code IS NULL, and
      // re-running is a no-op once every row has a code. Uses an md5-hex
      // first-8-chars code with a bounded per-row retry loop in case the
      // unique index rejects a randomly-generated collision.
      sql: `DO $$
        DECLARE
          r RECORD;
          new_code text;
          attempt int;
        BEGIN
          FOR r IN SELECT id FROM contacts WHERE booking_code IS NULL LOOP
            attempt := 0;
            LOOP
              new_code := substr(md5(random()::text || r.id::text || attempt::text || clock_timestamp()::text), 1, 8);
              BEGIN
                UPDATE contacts SET booking_code = new_code WHERE id = r.id;
                EXIT;
              EXCEPTION WHEN unique_violation THEN
                attempt := attempt + 1;
                IF attempt > 5 THEN
                  RAISE NOTICE 'Could not assign booking_code for contact % after 5 attempts', r.id;
                  EXIT;
                END IF;
              END;
            END LOOP;
          END LOOP;
        END $$`,
      description: 'contacts.booking_code backfill for legacy rows missing a short code (task #792)',
    },
    {
      sql: `DO $$ DECLARE dup_count integer; BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_indexes WHERE indexname = 'estimates_unique_external_idx'
        ) THEN
          -- Only create the unique index if there are no existing duplicates.
          -- Pre-existing duplicates (linked to jobs via FK) must be cleaned up manually.
          -- createCrmEstimate uses ON CONFLICT against this index for atomic dedup;
          -- tenants where this index is skipped fall back to sequential check-then-insert.
          SELECT COUNT(*) INTO dup_count FROM (
            SELECT contractor_id, external_source, external_id
            FROM estimates
            WHERE external_id IS NOT NULL AND external_source IS NOT NULL
            GROUP BY contractor_id, external_source, external_id
            HAVING COUNT(*) > 1
          ) dups;
          IF dup_count = 0 THEN
            CREATE UNIQUE INDEX IF NOT EXISTS estimates_unique_external_idx
              ON estimates(contractor_id, external_source, external_id)
              WHERE external_id IS NOT NULL AND external_source IS NOT NULL;
          ELSE
            RAISE NOTICE 'Skipping estimates_unique_external_idx: % duplicate groups found; clean up manually first', dup_count;
          END IF;
        END IF;
      END $$`,
      description: 'estimates unique index on (contractor_id, external_source, external_id) to prevent duplicate CRM rows',
    },
    {
      sql: `ALTER TABLE messages ADD COLUMN IF NOT EXISTS read_at timestamp`,
      description: 'messages.read_at (tracks when inbound messages were read)',
    },
    {
      sql: `ALTER TABLE activities ADD COLUMN IF NOT EXISTS read_at timestamp`,
      description: 'activities.read_at (inbound email unread tracking — task #468)',
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS messages_unread_inbound_idx ON messages (contractor_id, contact_id) WHERE direction = 'inbound' AND read_at IS NULL`,
      description: 'messages partial index for unread inbound lookups',
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS "shared_email_accounts" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "contractor_id" varchar NOT NULL REFERENCES "contractors"("id"),
        "email" text NOT NULL,
        "display_name" text,
        "gmail_refresh_token" text NOT NULL,
        "connected_by_user_id" varchar REFERENCES "users"("id") ON DELETE SET NULL,
        "created_at" timestamp DEFAULT now() NOT NULL,
        CONSTRAINT "shared_email_accounts_contractor_id_unique" UNIQUE("contractor_id")
      )`,
      description: 'shared_email_accounts table (shared company email per contractor)',
    },
    {
      sql: `DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE constraint_name = 'shared_email_accounts_connected_by_user_id_fkey'
            AND table_name = 'shared_email_accounts'
        ) THEN
          ALTER TABLE shared_email_accounts
            ADD CONSTRAINT shared_email_accounts_connected_by_user_id_fkey
            FOREIGN KEY (connected_by_user_id) REFERENCES users(id) ON DELETE SET NULL;
        END IF;
      END $$`,
      description: 'shared_email_accounts.connected_by_user_id FK to users(id)',
    },
    {
      sql: `ALTER TABLE leads ADD COLUMN IF NOT EXISTS aged boolean NOT NULL DEFAULT false`,
      description: 'leads.aged (aged leads monitoring flag)',
    },
    {
      sql: `UPDATE contacts SET last_activity_at = COALESCE(
        (SELECT MAX(a.created_at) FROM activities a WHERE a.contact_id = contacts.id),
        contacts.created_at
      ) WHERE last_activity_at IS NULL`,
      description: 'backfill contacts.last_activity_at from most recent activity or created_at (runs once for rows without a value)',
    },
    {
      sql: `ALTER TABLE contacts ALTER COLUMN last_activity_at SET DEFAULT now()`,
      description: 'contacts.last_activity_at: set DB default to now() for all insert paths',
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS contacts_contractor_activity_idx ON contacts(contractor_id, last_activity_at)`,
      description: 'contacts composite index on (contractor_id, last_activity_at) for activity-date sorting',
    },
    {
      sql: `DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM pg_enum
          WHERE enumlabel IN ('draft', 'pending')
            AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'estimate_status')
        ) THEN
          UPDATE estimates SET status = 'scheduled' WHERE status::text IN ('draft', 'pending');
        END IF;
      END $$`,
      description: 'migrate estimate status: draft/pending → scheduled',
    },
    {
      sql: `DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM pg_enum
          WHERE enumlabel = 'draft'
            AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'estimate_status')
        ) THEN
          ALTER TYPE estimate_status RENAME TO estimate_status_old;
          CREATE TYPE estimate_status AS ENUM ('sent', 'scheduled', 'in_progress', 'approved', 'rejected');
          ALTER TABLE estimates ALTER COLUMN status DROP DEFAULT;
          ALTER TABLE estimates ALTER COLUMN status TYPE estimate_status USING status::text::estimate_status;
          ALTER TABLE estimates ALTER COLUMN status SET DEFAULT 'scheduled';
          DROP TYPE estimate_status_old;
        END IF;
      END $$`,
      description: 'estimate_status enum: remove draft and pending values',
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS dialpad_webhook_state (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        contractor_id varchar NOT NULL UNIQUE REFERENCES contractors(id),
        sms_webhook_id text,
        sms_subscription_id text,
        call_webhook_id text,
        call_subscription_ids text[],
        last_registered_call_url text,
        last_registered_sms_url text,
        last_registered_at timestamp,
        updated_at timestamp NOT NULL DEFAULT now()
      )`,
      description: 'dialpad_webhook_state table (per-contractor persistence of registered webhook + subscription IDs for drift detection)',
    },
    {
      // Distinguish permanently-failed background processing from successful
      // processing. Previously the worker marked exhausted retries as
      // processed=true with an error_message, which conflated success with
      // failure in the audit log and let failed rows fall out of the
      // backlog count. Task #409.
      sql: `ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS failed_at timestamp`,
      description: 'webhook_events.failed_at (distinguishes permanent processing failures from successful processing)',
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS webhook_events_failed_at_idx ON webhook_events(failed_at)`,
      description: 'webhook_events.failed_at index (for failed-events surface and 24h failure backlog check)',
    },
    {
      // Re-stamp historical rows that the old worker marked processed=true
      // with a "Background processing failed after" error message — those
      // were always permanent failures, not successes. Idempotent.
      sql: `UPDATE webhook_events
            SET processed = false,
                failed_at = COALESCE(processed_at, now())
            WHERE processed = true
              AND failed_at IS NULL
              AND error_message LIKE 'Background processing failed after%'`,
      description: 'backfill: reclassify historic worker-failed webhook_events rows as failed instead of processed',
    },
    {
      // Rebuild the partial pending-events index so the poller's
      //   processed = false AND failed_at IS NULL
      // scan stays cheap by also excluding permanently-failed rows.
      sql: `DROP INDEX IF EXISTS webhook_events_unprocessed_idx`,
      description: 'drop legacy webhook_events_unprocessed_idx so it can be recreated with the failed_at predicate',
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS webhook_events_unprocessed_idx ON webhook_events(created_at) WHERE processed = false AND failed_at IS NULL`,
      description: 'webhook_events partial index on pending rows (excludes failed_at — keeps DialpadEventPoller scan cheap)',
    },
    {
      sql: `ALTER TABLE leads ADD COLUMN IF NOT EXISTS hcp_sync_skip_reason text`,
      description: 'leads.hcp_sync_skip_reason (records why a lead was not pushed to HCP)',
    },
    {
      sql: `ALTER TABLE leads ADD COLUMN IF NOT EXISTS hcp_sync_skip_detail text`,
      description: 'leads.hcp_sync_skip_detail (human-readable detail for HCP skip/failure reason)',
    },
    {
      // Declared in shared/schema/settings.ts on the sharedEmailAccounts
      // table but the original CREATE TABLE block above (and the bundled
      // migrations/0000_*.sql snapshot) never added it for existing tenants,
      // so the Gmail sync scheduler errored every minute with
      //   column "last_sync_at" does not exist (Postgres 42703)
      // on any DB created before this column was added to the Drizzle schema.
      sql: `ALTER TABLE shared_email_accounts ADD COLUMN IF NOT EXISTS last_sync_at timestamp`,
      description: 'shared_email_accounts.last_sync_at (Gmail sync scheduler high-water mark)',
    },
    {
      // Declared in shared/schema/settings.ts on the contractors table but
      // never present in any prior CREATE TABLE / ALTER TABLE migration,
      // so any DB created from those legacy migrations is missing it and
      // contractor reads fail. Default true matches the schema default.
      sql: `ALTER TABLE contractors ADD COLUMN IF NOT EXISTS auto_learn_reply_addresses boolean NOT NULL DEFAULT true`,
      description: 'contractors.auto_learn_reply_addresses (Gmail reply-address auto-learning toggle)',
    },
    {
      // Declared in shared/schema/settings.ts (contractors.bookingRedirectUrl)
      // and added by migrations/0003_booking_redirect_url.sql, but the CI
      // drift check only applies the bootstrap snapshot 0000_*.sql, so this
      // must live in columnMigrations (the runtime source of truth) too.
      sql: `ALTER TABLE contractors ADD COLUMN IF NOT EXISTS booking_redirect_url text`,
      description: 'contractors.booking_redirect_url (post-booking redirect URL)',
    },
    {
      // Declared in the Drizzle workflow_executions schema as a `resume_at`
      // timestamp for suspended/delayed executions. Never had its own SQL
      // migration, so existing tenants and a fresh ephemeral DB both miss
      // it without this idempotent ALTER.
      sql: `ALTER TABLE workflow_executions ADD COLUMN IF NOT EXISTS resume_at timestamp`,
      description: 'workflow_executions.resume_at (suspended-execution wake time)',
    },
    // ---- Task #435: HCP foundation data (line items, salesperson, payments) ----
    {
      sql: `ALTER TABLE estimates ADD COLUMN IF NOT EXISTS line_items jsonb`,
      description: 'estimates.line_items (HCP line_items snapshot)',
    },
    {
      sql: `ALTER TABLE estimates ADD COLUMN IF NOT EXISTS salesperson_user_id varchar`,
      description: 'estimates.salesperson_user_id (resolved salesperson user)',
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS estimates_salesperson_user_id_idx ON estimates(contractor_id, salesperson_user_id) WHERE salesperson_user_id IS NOT NULL`,
      description: 'estimates_salesperson_user_id_idx (per-tenant salesperson lookup)',
    },
    {
      sql: `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS line_items jsonb`,
      description: 'jobs.line_items (HCP line_items snapshot)',
    },
    {
      sql: `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS salesperson_user_id varchar`,
      description: 'jobs.salesperson_user_id (resolved salesperson user)',
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS jobs_salesperson_user_id_idx ON jobs(contractor_id, salesperson_user_id) WHERE salesperson_user_id IS NOT NULL`,
      description: 'jobs_salesperson_user_id_idx (per-tenant salesperson lookup)',
    },
    {
      sql: `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS paid_amount numeric(10,2)`,
      description: 'jobs.paid_amount (latest payment amount captured from job.paid)',
    },
    {
      sql: `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS payment_method text`,
      description: 'jobs.payment_method (latest payment method)',
    },
    {
      sql: `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS paid_at timestamp`,
      description: 'jobs.paid_at (timestamp of latest payment)',
    },
    {
      sql: `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS is_deposit boolean`,
      description: 'jobs.is_deposit (whether the latest payment was a deposit)',
    },
    {
      sql: `ALTER TABLE employees ADD COLUMN IF NOT EXISTS user_contractor_id varchar`,
      description: 'employees.user_contractor_id (link HCP employee to user_contractors row)',
    },
    {
      // Wrap the FK ADD in DO/EXCEPTION because IF NOT EXISTS isn't supported
      // for ADD CONSTRAINT in older PG versions; running this twice must be a
      // no-op so it stays compatible with the rest of the startup migrations.
      sql: `DO $$ BEGIN
              ALTER TABLE employees
                ADD CONSTRAINT employees_user_contractor_id_fkey
                FOREIGN KEY (user_contractor_id) REFERENCES user_contractors(id) ON DELETE SET NULL;
            EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
      description: 'employees.user_contractor_id FK to user_contractors(id) ON DELETE SET NULL',
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS employees_user_contractor_id_idx ON employees(contractor_id, user_contractor_id) WHERE user_contractor_id IS NOT NULL`,
      description: 'employees_user_contractor_id_idx (per-tenant lookup of linked employees)',
    },
    // ---- Task #445: Top-level estimate status-change metadata ----
    {
      sql: `ALTER TABLE estimates ADD COLUMN IF NOT EXISTS approval_status_changed_at timestamp`,
      description: 'estimates.approval_status_changed_at (timestamp of latest parent-status flip)',
    },
    {
      sql: `ALTER TABLE estimates ADD COLUMN IF NOT EXISTS most_recent_status_change_reason text`,
      description: 'estimates.most_recent_status_change_reason (free-form reason for latest status change)',
    },
    // ---- Task #464: Time-to-close anchors for estimates ----
    {
      sql: `ALTER TABLE estimates ADD COLUMN IF NOT EXISTS approved_at timestamp`,
      description: 'estimates.approved_at (Task #464: time-to-close anchor for approved estimates)',
    },
    {
      sql: `ALTER TABLE estimates ADD COLUMN IF NOT EXISTS rejected_at timestamp`,
      description: 'estimates.rejected_at (Task #464: time-to-close anchor for rejected estimates)',
    },
    {
      sql: `UPDATE estimates SET approved_at = updated_at WHERE status = 'approved' AND approved_at IS NULL`,
      description: 'backfill estimates.approved_at from updated_at for existing approved rows (one-time, idempotent)',
    },
    {
      sql: `UPDATE estimates SET rejected_at = updated_at WHERE status = 'rejected' AND rejected_at IS NULL`,
      description: 'backfill estimates.rejected_at from updated_at for existing rejected rows (one-time, idempotent)',
    },
    // ---- Task #506: Sales Process settings + scheduling engine ----
    {
      sql: `DO $$ BEGIN
              CREATE TYPE "sales_process_action_type" AS ENUM ('call', 'text', 'email');
            EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
      description: 'sales_process_action_type enum',
    },
    {
      sql: `DO $$ BEGIN
              CREATE TYPE "sales_process_step_mode" AS ENUM ('manual', 'auto');
            EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
      description: 'sales_process_step_mode enum',
    },
    {
      sql: `DO $$ BEGIN
              CREATE TYPE "sales_process_task_status" AS ENUM ('pending', 'completed', 'skipped', 'failed');
            EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
      description: 'sales_process_task_status enum',
    },
    {
      sql: `DO $$ BEGIN
              CREATE TYPE "sales_process_completion_reason" AS ENUM (
                'manual', 'activity_logged', 'auto_sent', 'lead_status_changed', 'step_deleted'
              );
            EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
      description: 'sales_process_completion_reason enum',
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS "sales_processes" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        "contractor_id" varchar NOT NULL REFERENCES "contractors"("id") ON DELETE CASCADE,
        "name" text NOT NULL DEFAULT 'Default sales process',
        "active" boolean NOT NULL DEFAULT false,
        "created_at" timestamp NOT NULL DEFAULT now(),
        "updated_at" timestamp NOT NULL DEFAULT now()
      )`,
      description: 'sales_processes table (per-tenant cadence config)',
    },
    {
      sql: `CREATE UNIQUE INDEX IF NOT EXISTS "sales_processes_contractor_unique" ON "sales_processes"("contractor_id")`,
      description: 'sales_processes unique index on contractor_id (one process per tenant for now)',
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS "sales_process_steps" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        "sales_process_id" varchar NOT NULL REFERENCES "sales_processes"("id") ON DELETE CASCADE,
        "day_offset" integer NOT NULL,
        "action_type" "sales_process_action_type" NOT NULL,
        "mode" "sales_process_step_mode" NOT NULL DEFAULT 'manual',
        "message_template" text,
        "display_order" integer NOT NULL DEFAULT 0,
        "created_at" timestamp NOT NULL DEFAULT now(),
        "updated_at" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "sales_process_steps_day_offset_nonneg" CHECK ("day_offset" >= 0)
      )`,
      description: 'sales_process_steps table (ordered cadence touchpoints)',
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS "sales_process_steps_process_idx" ON "sales_process_steps"("sales_process_id")`,
      description: 'sales_process_steps index by parent process',
    },
    {
      sql: `CREATE UNIQUE INDEX IF NOT EXISTS "sales_process_steps_unique_per_process" ON "sales_process_steps"("sales_process_id", "day_offset", "action_type")`,
      description: 'sales_process_steps unique (process, day_offset, action_type)',
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS "sales_process_task_instances" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        "contractor_id" varchar NOT NULL REFERENCES "contractors"("id") ON DELETE CASCADE,
        "lead_id" varchar NOT NULL REFERENCES "leads"("id") ON DELETE CASCADE,
        "step_id" varchar NOT NULL REFERENCES "sales_process_steps"("id") ON DELETE RESTRICT,
        "action_type" "sales_process_action_type" NOT NULL,
        "mode" "sales_process_step_mode" NOT NULL,
        "due_at" timestamp NOT NULL,
        "status" "sales_process_task_status" NOT NULL DEFAULT 'pending',
        "completion_reason" "sales_process_completion_reason",
        "completed_at" timestamp,
        "completed_by" varchar REFERENCES "users"("id"),
        "failure_reason" text,
        "attempt_count" integer NOT NULL DEFAULT 0,
        "created_at" timestamp NOT NULL DEFAULT now()
      )`,
      description: 'sales_process_task_instances table (per-lead cadence to-dos)',
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS "sales_process_task_instances_tenant_status_due_idx" ON "sales_process_task_instances"("contractor_id", "status", "due_at")`,
      description: 'sales_process_task_instances index (tenant, status, due_at) for cron scans + Follow-ups page',
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS "sales_process_task_instances_lead_status_idx" ON "sales_process_task_instances"("lead_id", "status")`,
      description: 'sales_process_task_instances index (lead, status) for per-lead views',
    },
    {
      sql: `ALTER TABLE "sales_process_steps" ADD COLUMN IF NOT EXISTS "archived_at" timestamp`,
      description: 'sales_process_steps.archived_at (soft-delete column)',
    },
    {
      sql: `DROP INDEX IF EXISTS "sales_process_steps_unique_per_process"`,
      description: 'drop legacy non-partial unique index so it can be recreated as partial (excludes archived rows)',
    },
    {
      sql: `CREATE UNIQUE INDEX IF NOT EXISTS "sales_process_steps_unique_per_process" ON "sales_process_steps"("sales_process_id", "day_offset", "action_type") WHERE "archived_at" IS NULL`,
      description: 'sales_process_steps unique (process, day_offset, action_type) WHERE archived_at IS NULL',
    },
    // Task #729: per-step rep coaching surfaced on the Follow-Ups page.
    {
      sql: `ALTER TABLE "sales_process_steps" ADD COLUMN IF NOT EXISTS "call_script" text`,
      description: 'sales_process_steps.call_script (rep call talk track, task #729)',
    },
    {
      sql: `ALTER TABLE "sales_process_steps" ADD COLUMN IF NOT EXISTS "guidance" text`,
      description: 'sales_process_steps.guidance (rep coaching/why-this-step text, task #729)',
    },
    // Task #567: multiple cadences per tenant with triggers/targets. The
    // schema added these columns but the previous PR forgot to register the
    // runtime drift migrations — without them the boot-time drift check
    // refuses to start the server.
    {
      sql: `ALTER TABLE "sales_processes" ADD COLUMN IF NOT EXISTS "trigger_type" text NOT NULL DEFAULT 'lead_created'`,
      description: 'sales_processes.trigger_type (cadence trigger discriminator)',
    },
    {
      sql: `ALTER TABLE "sales_processes" ADD COLUMN IF NOT EXISTS "target_status" text`,
      description: 'sales_processes.target_status (status filter for status-change triggers)',
    },
    {
      sql: `ALTER TABLE "sales_processes" ADD COLUMN IF NOT EXISTS "entity_type" text NOT NULL DEFAULT 'lead'`,
      description: 'sales_processes.entity_type (lead vs estimate cadence)',
    },
    {
      sql: `ALTER TABLE "sales_processes" ADD COLUMN IF NOT EXISTS "archived_at" timestamp`,
      description: 'sales_processes.archived_at (soft-delete column)',
    },
    {
      sql: `ALTER TABLE "sales_process_task_instances" ADD COLUMN IF NOT EXISTS "estimate_id" varchar REFERENCES "estimates"("id") ON DELETE CASCADE`,
      description: 'sales_process_task_instances.estimate_id (estimate-anchored cadences)',
    },
    // Task #514: Reports speedups. Composite indexes that match the actual filter
    // shapes used by the Estimates "Lost Revenue" / "Time to Close" reports
    // (which group by status + updated_at) and the Speed-to-Lead report
    // (which joins activities to leads via contact_id and filters by type).
    {
      sql: `CREATE INDEX IF NOT EXISTS "estimates_contractor_status_updated_at_idx" ON "estimates" ("contractor_id", "status", "updated_at")`,
      description: 'estimates composite index (contractor_id, status, updated_at) for Lost Revenue / Time to Close reports',
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS "activities_contractor_type_contact_created_idx" ON "activities" ("contractor_id", "type", "contact_id", "created_at")`,
      description: 'activities composite index (contractor_id, type, contact_id, created_at) for Speed-to-Lead report',
    },
    {
      sql: `ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "google_lead_id" varchar`,
      description: 'leads.google_lead_id (task #490: O(1) GLS poller lookups)',
    },
    {
      // Backfill from rawPayload for any rows ingested before the column existed
      // so the GLS poller can immediately switch to indexed lookups without
      // re-creating duplicate leads on the next poll.
      sql: `UPDATE "leads"
              SET "google_lead_id" = substring("raw_payload" FROM '"_gls_lead_id":"([^"]+)"')
            WHERE "source" = 'google_local_services'
              AND "google_lead_id" IS NULL
              AND "raw_payload" LIKE '%"_gls_lead_id":"%'`,
      description: 'leads.google_lead_id backfill from raw_payload (task #490)',
    },
    {
      sql: `CREATE UNIQUE INDEX IF NOT EXISTS "leads_google_lead_id_unique_idx" ON "leads"("contractor_id", "google_lead_id") WHERE "google_lead_id" IS NOT NULL`,
      description: 'leads (contractor_id, google_lead_id) partial unique index (task #490)',
    },
    {
      sql: `ALTER TABLE "sales_process_task_instances" ALTER COLUMN "lead_id" DROP NOT NULL`,
      description: 'sales_process_task_instances.lead_id nullable (XOR with estimate_id)',
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS "refresh_tokens" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "user_id" varchar NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "contractor_id" varchar NOT NULL REFERENCES "contractors"("id") ON DELETE CASCADE,
        "token_hash" text NOT NULL,
        "device_id" text,
        "created_at" timestamp NOT NULL DEFAULT now(),
        "expires_at" timestamp NOT NULL,
        "last_used_at" timestamp,
        "revoked_at" timestamp,
        "ip" text,
        "user_agent" text
      )`,
      description: 'refresh_tokens table (long-lived refresh tokens for PWA persistent login, task #650)',
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS "refresh_tokens_token_hash_idx" ON "refresh_tokens" ("token_hash")`,
      description: 'refresh_tokens.token_hash index (lookup by hash on /api/auth/refresh)',
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS "refresh_tokens_user_id_idx" ON "refresh_tokens" ("user_id")`,
      description: 'refresh_tokens.user_id index (logout-all revocation)',
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS "refresh_tokens_expires_at_idx" ON "refresh_tokens" ("expires_at")`,
      description: 'refresh_tokens.expires_at index (cleanup of expired rows)',
    },
    {
      sql: `ALTER TABLE "refresh_tokens" ADD COLUMN IF NOT EXISTS "rotated_at" timestamp`,
      description: 'refresh_tokens.rotated_at (rotation timestamp; enables grace-window for in-flight retries vs. hard revocation)',
    },
    // ---- Task #651: WebAuthn passkey unlock ----
    {
      sql: `CREATE TABLE IF NOT EXISTS "webauthn_credentials" (
              "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
              "user_id" varchar NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
              "credential_id" text NOT NULL UNIQUE,
              "public_key" text NOT NULL,
              "counter" bigint NOT NULL DEFAULT 0,
              "transports" text[],
              "device_label" text NOT NULL,
              "created_at" timestamp NOT NULL DEFAULT now(),
              "last_used_at" timestamp
            )`,
      description: 'webauthn_credentials table (Task #651: registered passkeys)',
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS "webauthn_credentials_user_id_idx" ON "webauthn_credentials"("user_id")`,
      description: 'webauthn_credentials.user_id index',
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS "webauthn_challenges" (
              "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
              "user_id" varchar REFERENCES "users"("id") ON DELETE CASCADE,
              "session_id" text UNIQUE,
              "challenge" text NOT NULL,
              "purpose" text NOT NULL,
              "expires_at" timestamp NOT NULL,
              "created_at" timestamp NOT NULL DEFAULT now()
            )`,
      description: 'webauthn_challenges table (Task #651: short-lived register/login challenges)',
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS "webauthn_challenges_expires_at_idx" ON "webauthn_challenges"("expires_at")`,
      description: 'webauthn_challenges.expires_at index',
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS "webauthn_challenges_user_id_idx" ON "webauthn_challenges"("user_id")`,
      description: 'webauthn_challenges.user_id index',
    },
    // ---- Task #678: HCP webhook restart resilience & auto-backfill ----
    {
      // Note: `service` is varchar (not the webhook_service pg enum) because
      // the live webhook_events.service column is varchar in production —
      // matching that here keeps the two tables compatible without forcing
      // an enum-creation migration.
      sql: `CREATE TABLE IF NOT EXISTS "webhook_incidents" (
              "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
              "contractor_id" varchar NOT NULL REFERENCES "contractors"("id"),
              "service" varchar NOT NULL,
              "kind" varchar NOT NULL,
              "opened_at" timestamp NOT NULL DEFAULT now(),
              "closed_at" timestamp,
              "notified_at" timestamp,
              "backfill_attempted_at" timestamp,
              "backfill_summary" text
            )`,
      description: 'webhook_incidents table (Task #678: persisted outage markers + backfill log)',
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS "webhook_incidents_contractor_service_kind_idx"
              ON "webhook_incidents"("contractor_id", "service", "kind")`,
      description: 'webhook_incidents lookup index by (contractor, service, kind)',
    },
    {
      // Task #748: track oldest updated_at covered by the last successful
      // backfill so the HCP settings card can show "Fetched through" next
      // to "Last resync". Idempotent ADD IF NOT EXISTS for safe replay.
      sql: `ALTER TABLE "webhook_incidents"
              ADD COLUMN IF NOT EXISTS "backfill_fetched_through_at" timestamp`,
      description: 'webhook_incidents.backfill_fetched_through_at (Task #748)',
    },
    {
      // Unique partial index — see migration 0032 comment. Enforces the
      // "at most one open incident per (contractor, service, kind)" rule
      // at the DB level so app-side ON CONFLICT DO NOTHING is atomic.
      sql: `CREATE UNIQUE INDEX IF NOT EXISTS "webhook_incidents_unique_open_idx"
              ON "webhook_incidents"("contractor_id", "service", "kind")
              WHERE closed_at IS NULL`,
      description: 'webhook_incidents UNIQUE partial index on open incidents (atomic single-incident guarantee)',
    },
    {
      // Drop the older non-unique partial — the new unique partial supersedes
      // it. Safe to run repeatedly because of IF EXISTS.
      sql: `DROP INDEX IF EXISTS "webhook_incidents_open_idx"`,
      description: 'drop legacy non-unique webhook_incidents_open_idx (replaced by unique partial)',
    },
    // ---- Task #710: Throttle webhook health alerts (24h cooldown) ----
    // A sibling table to webhook_incidents that records the last successful
    // page per (contractor, service, kind) so we can suppress repeat
    // email + in-app notifications inside the cooldown window. We can't
    // hang this off webhook_incidents because the cooldown must span
    // multiple open/close cycles (a flapping outage opens and closes the
    // incident on every tick).
    {
      sql: `CREATE TABLE IF NOT EXISTS "webhook_incident_alert_throttle" (
              "contractor_id" varchar NOT NULL REFERENCES "contractors"("id"),
              "service" varchar NOT NULL,
              "kind" varchar NOT NULL,
              "last_alerted_at" timestamp NOT NULL
            )`,
      description: 'webhook_incident_alert_throttle table (Task #710: per-(contractor, service, kind) cooldown)',
    },
    {
      sql: `CREATE UNIQUE INDEX IF NOT EXISTS "webhook_incident_alert_throttle_pk"
              ON "webhook_incident_alert_throttle"("contractor_id", "service", "kind")`,
      description: 'webhook_incident_alert_throttle unique index on (contractor_id, service, kind)',
    },
    // Task #682: Drop the stale single-column unique index that was created
    // back when each tenant could only have one cadence. Multi-cadence support
    // (Task #567) added trigger_type/target_status/entity_type/archived_at and
    // a partial unique index on (contractor_id, trigger_type,
    // COALESCE(target_status,'')) WHERE archived_at IS NULL — but the old
    // single-column unique was never dropped, so any second cadence insert
    // for a contractor 500s with a 23505 on `sales_processes_contractor_unique`.
    // This entry must run AFTER the trigger_type/target_status/entity_type/
    // archived_at column adds above so the replacement uniqueness rule is
    // already in force before the old constraint is removed.
    {
      sql: `CREATE UNIQUE INDEX IF NOT EXISTS "sales_processes_trigger_unique"
              ON "sales_processes"("contractor_id", "trigger_type", COALESCE("target_status", ''))
              WHERE "archived_at" IS NULL`,
      description: 'sales_processes partial unique index on (contractor_id, trigger_type, COALESCE(target_status,\'\')) — multi-cadence replacement',
    },
    {
      sql: `DROP INDEX IF EXISTS "sales_processes_contractor_unique"`,
      description: 'drop stale single-column unique index sales_processes_contractor_unique (multi-cadence replacement is now in place)',
    },
    // ---- Task #684: HCP webhook-health checker performance ----
    // The four health queries all filter by (contractor_id, service) plus
    // event_type and order by created_at DESC. Without a covering composite
    // the planner bitmap-ANDs across narrow indexes and re-sorts, which under
    // pool pressure was slow enough to surface as `timeout exceeded when
    // trying to connect` and silently fail the health check (Task #684).
    {
      sql: `CREATE INDEX IF NOT EXISTS "webhook_events_contractor_service_event_type_created_at_idx"
              ON "webhook_events"("contractor_id", "service", "event_type", "created_at" DESC)`,
      description: 'webhook_events composite index for HCP webhook-health checker (task #684)',
    },
    // ---- Task #694: Self-Scheduled vs Sales-Scheduled report ----
    // Persist the booking origin on every scheduled_bookings row so the new
    // report can split totals into "self-scheduled" (public booking link) vs
    // "scheduled by salesperson" without re-deriving from the activity log on
    // every request. New rows default to 'in_app_booking'; the public booking
    // path explicitly writes 'public_booking' (see server/scheduling/booking.ts).
    {
      sql: `ALTER TABLE scheduled_bookings
            ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'in_app_booking'`,
      description: 'scheduled_bookings.source (booking origin for scheduling-source report, task #694)',
    },
    // One-shot backfill for historical rows (idempotent — only touches rows
    // still at the default 'in_app_booking' that have a 'public_booking'
    // status_change activity for the same contact within ±10 minutes of the
    // booking's created_at). The window is wide enough to absorb the small
    // ordering gap between the activity log write in markContactScheduled
    // and the subsequent scheduled_bookings insert in bookAppointment, but
    // narrow enough that re-bookings of the same contact are not mis-tagged.
    {
      sql: `UPDATE scheduled_bookings sb
              SET source = 'public_booking'
              WHERE sb.source = 'in_app_booking'
                AND sb.contact_id IS NOT NULL
                AND EXISTS (
                  SELECT 1 FROM activities a
                  WHERE a.contact_id = sb.contact_id
                    AND a.contractor_id = sb.contractor_id
                    AND a.type = 'status_change'
                    AND a.external_source = 'public_booking'
                    AND a.created_at BETWEEN sb.created_at - interval '10 minutes'
                                         AND sb.created_at + interval '10 minutes'
                )`,
      description: 'backfill scheduled_bookings.source = public_booking from activities log (task #694)',
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS "scheduled_bookings_contractor_created_at_idx"
              ON "scheduled_bookings"("contractor_id", "created_at")`,
      description: 'scheduled_bookings (contractor_id, created_at) index for scheduling-source report (task #694)',
    },
    // ---- Task #698: backfill public-booking source on historical rows ----
    // Augments the task #694 backfill with two recovery rules so the
    // Self-Scheduled vs Sales-Scheduled report stops misclassifying historical
    // public bookings as in-app:
    //   1. If the raw `booking_payload` we captured at booking time carries
    //      `"source": "public_booking"`, the row definitely came from the
    //      public widget — re-tag it.
    //   2. Failing that, look for a public-booking activity (meeting OR
    //      status_change) for the same contact within ±5 minutes of the
    //      booking's created_at. The new path also picks up the `meeting`
    //      activity written by server/routes/public.ts which the original
    //      task #694 backfill missed because it only looked at status_change.
    // Both statements are idempotent (`source <> 'public_booking'`) so this
    // is safe to re-run on every boot.
    {
      sql: `UPDATE scheduled_bookings sb
              SET source = 'public_booking'
            WHERE sb.source <> 'public_booking'
              AND sb.booking_payload IS NOT NULL
              AND sb.booking_payload->>'source' = 'public_booking'`,
      description: 'backfill scheduled_bookings.source from booking_payload->>source (task #698)',
    },
    {
      sql: `UPDATE scheduled_bookings sb
              SET source = 'public_booking'
            WHERE sb.source <> 'public_booking'
              AND sb.contact_id IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM activities a
                 WHERE a.contact_id = sb.contact_id
                   AND a.contractor_id = sb.contractor_id
                   AND a.type IN ('meeting', 'status_change')
                   AND a.external_source = 'public_booking'
                   AND a.created_at BETWEEN sb.created_at - interval '5 minutes'
                                        AND sb.created_at + interval '5 minutes'
              )`,
      description: 'backfill scheduled_bookings.source from public_booking activities (task #698)',
    },
    // ---- AI SMS scheduling agent settings (task #697) ----
    {
      sql: `ALTER TABLE contractors ADD COLUMN IF NOT EXISTS ai_scheduling_enabled boolean NOT NULL DEFAULT false`,
      description: 'contractors.ai_scheduling_enabled (master on/off for the AI SMS scheduling agent)',
    },
    {
      sql: `ALTER TABLE contractors ADD COLUMN IF NOT EXISTS ai_scheduling_personality text`,
      description: 'contractors.ai_scheduling_personality (free-text persona/tone instructions for the AI agent)',
    },
    {
      sql: `ALTER TABLE contractors ADD COLUMN IF NOT EXISTS ai_scheduling_company_context text`,
      description: 'contractors.ai_scheduling_company_context (free-text company background the AI agent should know)',
    },
    // ---- Task #706: AI SMS scheduling agent ----
    {
      sql: `ALTER TABLE contractors ADD COLUMN IF NOT EXISTS ai_scheduling_window_hours integer NOT NULL DEFAULT 72`,
      description: 'contractors.ai_scheduling_window_hours (how long after a flagged outreach SMS the AI may engage)',
    },
    {
      sql: `ALTER TABLE messages ADD COLUMN IF NOT EXISTS ai_authored boolean NOT NULL DEFAULT false`,
      description: 'messages.ai_authored (true when an outbound message was composed by the AI scheduling agent)',
    },
    {
      sql: `ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_scheduling_intent boolean NOT NULL DEFAULT false`,
      description: 'messages.is_scheduling_intent (true on outbound workflow SMS rows whose step was marked scheduling-intent)',
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS "ai_scheduling_conversations" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "contractor_id" varchar NOT NULL REFERENCES "contractors"("id") ON DELETE CASCADE,
        "contact_id" varchar NOT NULL REFERENCES "contacts"("id") ON DELETE CASCADE,
        "triggering_message_id" varchar REFERENCES "messages"("id") ON DELETE SET NULL,
        "triggering_workflow_execution_id" varchar REFERENCES "workflow_executions"("id") ON DELETE SET NULL,
        "status" text NOT NULL DEFAULT 'active',
        "proposed_start_time" timestamp,
        "proposed_salesperson_user_id" varchar REFERENCES "users"("id") ON DELETE SET NULL,
        "proposed_address" text,
        "exchange_count" integer NOT NULL DEFAULT 0,
        "last_inbound_message_id" varchar REFERENCES "messages"("id") ON DELETE SET NULL,
        "last_outbound_message_id" varchar REFERENCES "messages"("id") ON DELETE SET NULL,
        "handoff_reason" text,
        "created_at" timestamp NOT NULL DEFAULT now(),
        "updated_at" timestamp NOT NULL DEFAULT now()
      )`,
      description: 'ai_scheduling_conversations table (task #706: AI SMS scheduling agent state)',
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS ai_sched_conv_contractor_idx ON ai_scheduling_conversations (contractor_id)`,
      description: 'ai_scheduling_conversations.contractor_id index',
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS ai_sched_conv_contact_idx ON ai_scheduling_conversations (contact_id)`,
      description: 'ai_scheduling_conversations.contact_id index',
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS ai_sched_conv_status_idx ON ai_scheduling_conversations (status)`,
      description: 'ai_scheduling_conversations.status index',
    },
    {
      sql: `CREATE UNIQUE INDEX IF NOT EXISTS ai_sched_conv_unique_open_idx ON ai_scheduling_conversations (contractor_id, contact_id) WHERE status IN ('active','awaiting_confirmation')`,
      description: 'ai_scheduling_conversations partial unique index — at most one open conversation per contact',
    },
    // ---- Task #696: media_spend (manual ad-spend entries for ROI report) ----
    {
      sql: `CREATE TABLE IF NOT EXISTS "media_spend" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        "contractor_id" varchar NOT NULL REFERENCES "contractors"("id"),
        "platform" text NOT NULL,
        "month" date NOT NULL,
        "amount" decimal(12, 2) NOT NULL DEFAULT '0',
        "note" text,
        "created_by_user_id" varchar,
        "updated_by_user_id" varchar,
        "created_at" timestamp NOT NULL DEFAULT now(),
        "updated_at" timestamp NOT NULL DEFAULT now()
      )`,
      description: 'media_spend table (task #696: manual ad-spend entries for ROI by Source report)',
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS "media_spend_contractor_id_idx" ON "media_spend"("contractor_id")`,
      description: 'media_spend tenant lookup index',
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS "media_spend_contractor_month_idx" ON "media_spend"("contractor_id", "month")`,
      description: 'media_spend (contractor_id, month) index for ROI report scans',
    },
    {
      sql: `CREATE UNIQUE INDEX IF NOT EXISTS "media_spend_unique_platform_month_idx" ON "media_spend"("contractor_id", "platform", "month")`,
      description: 'media_spend unique (contractor_id, platform, month) — one entry per platform per month',
    },
    // ---- Task #702: media_spend auto-sync columns ----
    {
      sql: `ALTER TABLE media_spend ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual'`,
      description: 'media_spend.source (task #702: manual vs auto-synced row marker)',
    },
    {
      sql: `ALTER TABLE media_spend ADD COLUMN IF NOT EXISTS external_account_id text`,
      description: 'media_spend.external_account_id (task #702: originating ad account id)',
    },
    {
      sql: `ALTER TABLE media_spend ADD COLUMN IF NOT EXISTS last_synced_at timestamp`,
      description: 'media_spend.last_synced_at (task #702: when this row was last touched by auto-sync)',
    },
    // ---- media_spend campaign-level entries ----
    {
      sql: `ALTER TABLE "media_spend" ADD COLUMN IF NOT EXISTS "campaign" text`,
      description: 'media_spend.campaign (optional campaign within a platform)',
    },
    {
      sql: `DROP INDEX IF EXISTS "media_spend_unique_platform_month_idx"`,
      description: 'drop old (contractor_id, platform, month) unique index — replaced by campaign-aware index',
    },
    {
      sql: `CREATE UNIQUE INDEX IF NOT EXISTS "media_spend_unique_platform_campaign_month_idx" ON "media_spend"("contractor_id", "platform", "campaign", "month") NULLS NOT DISTINCT`,
      description: 'media_spend unique (contractor_id, platform, campaign, month) NULLS NOT DISTINCT',
    },
    // ---- Task #721: estimates.document_sent_at (document-sent lifecycle independent of visit status) ----
    {
      sql: `ALTER TABLE estimates ADD COLUMN IF NOT EXISTS document_sent_at timestamp`,
      description: 'estimates.document_sent_at (task #721: document-sent timestamp, sticky, independent of visit status)',
    },
    // ---- Task #738: users.passkey_prompt_dismissed_at (post-login passkey enrollment prompt dismissal) ----
    {
      sql: `ALTER TABLE users ADD COLUMN IF NOT EXISTS passkey_prompt_dismissed_at timestamp`,
      description: 'users.passkey_prompt_dismissed_at (task #738: per-user dismissal of post-login passkey enrollment prompt)',
    },
    // ---- Task #798: un-stick leads that were promoted to a customer-only status ----
    // A manually-entered lead pushed to Housecall Pro could be round-tripped
    // back as type=customer / status=active, which is not a valid leads-pipeline
    // status — so the lead vanished from every Leads filter, tab, and Kanban
    // column. The forward-looking guard in storage.createContact/updateContact
    // prevents new occurrences; this one-time, idempotent backfill repairs the
    // existing stuck rows.
    //
    // Targets only contacts that still have an OPEN (non-archived, non-terminal)
    // lead row — i.e. work the contractor still considers an active lead. It
    // resets them to type=lead and a sensible pipeline status: `scheduled` when
    // the contact is booked (is_scheduled, or has a scheduled estimate/job),
    // otherwise `new`. Genuine customers (no lead row, or only
    // converted/lost/disqualified leads) are left untouched and keep `active`.
    // Re-running is a no-op once every matching row has been fixed.
    {
      sql: `UPDATE contacts c
            SET type = 'lead',
                status = (CASE
                  WHEN c.is_scheduled THEN 'scheduled'
                  WHEN EXISTS (
                    SELECT 1 FROM estimates e
                    WHERE e.contact_id = c.id
                      AND e.contractor_id = c.contractor_id
                      AND e.scheduled_start IS NOT NULL
                  ) THEN 'scheduled'
                  WHEN EXISTS (
                    SELECT 1 FROM jobs j
                    WHERE j.contact_id = c.id
                      AND j.contractor_id = c.contractor_id
                      AND j.scheduled_date IS NOT NULL
                  ) THEN 'scheduled'
                  ELSE 'new'
                END)::contact_status,
                updated_at = now()
            WHERE c.status IN ('active', 'inactive')
              AND EXISTS (
                SELECT 1 FROM leads l
                WHERE l.contact_id = c.id
                  AND l.contractor_id = c.contractor_id
                  AND l.archived = false
                  AND l.status NOT IN ('converted', 'lost', 'disqualified')
              )`,
      description: 'backfill: reset leads stuck on customer-only status (active/inactive) back into the pipeline (task #798)',
    },
    // Task #805 — lead-level first-contact timing (per-lead speed-to-lead).
    {
      sql: `ALTER TABLE leads ADD COLUMN IF NOT EXISTS contacted_at timestamp`,
      description: 'leads.contacted_at (task #805: when this lead was first contacted)',
    },
    {
      sql: `ALTER TABLE leads ADD COLUMN IF NOT EXISTS contacted_by_user_id varchar`,
      description: 'leads.contacted_by_user_id (task #805: user who first contacted this lead)',
    },
    {
      sql: `DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE constraint_name = 'leads_contacted_by_user_id_fkey'
            AND table_name = 'leads'
        ) THEN
          ALTER TABLE leads
            ADD CONSTRAINT leads_contacted_by_user_id_fkey
            FOREIGN KEY (contacted_by_user_id) REFERENCES users(id);
        END IF;
      END $$`,
      description: 'leads.contacted_by_user_id FK to users(id) (task #805)',
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS leads_contractor_contacted_at_idx ON leads (contractor_id, contacted_at)`,
      description: 'leads composite index on (contractor_id, contacted_at) for dashboard speed-to-lead/contacted aggregates (task #805)',
    },
    {
      sql: `CREATE INDEX IF NOT EXISTS leads_contact_archived_status_created_idx ON leads (contact_id, archived, status, created_at)`,
      description: 'leads composite index on (contact_id, archived, status, created_at) for effective-stage derivation (task #805)',
    },
    {
      // Task #805 — one-time, idempotent backfill: seed each contact's MOST
      // RECENT lead with the contact-level contacted_at / contacted_by_user_id
      // (best-effort; historical multi-lead contacts carry only one
      // contact-level timestamp). Only touches lead rows whose contacted_at is
      // still NULL, so re-running is a no-op once seeded.
      sql: `UPDATE leads l
            SET contacted_at = c.contacted_at,
                contacted_by_user_id = c.contacted_by_user_id
            FROM contacts c
            WHERE l.contact_id = c.id
              AND l.contacted_at IS NULL
              AND c.contacted_at IS NOT NULL
              AND l.id = (
                SELECT l2.id FROM leads l2
                WHERE l2.contact_id = c.id
                ORDER BY l2.created_at DESC
                LIMIT 1
              )`,
      description: 'backfill leads.contacted_at/contacted_by_user_id from contact-level timing onto most-recent lead per contact (task #805)',
    },
    // ── Twilio telephony integration (task #822) ──────────────────────────
    {
      sql: `ALTER TABLE contractors ADD COLUMN IF NOT EXISTS default_twilio_number text`,
      description: 'contractors.default_twilio_number (org default Twilio number, task #822)',
    },
    {
      sql: `ALTER TABLE contractors ADD COLUMN IF NOT EXISTS twilio_record_calls boolean NOT NULL DEFAULT false`,
      description: 'contractors.twilio_record_calls (call-recording toggle, OFF by default, task #822)',
    },
    {
      sql: `ALTER TABLE user_contractors ADD COLUMN IF NOT EXISTS twilio_default_number text`,
      description: 'user_contractors.twilio_default_number (per-user Twilio send/call number, task #822)',
    },
    {
      sql: `ALTER TABLE contractors ADD COLUMN IF NOT EXISTS twilio_inbound_call_mode text NOT NULL DEFAULT 'crm'`,
      description: "contractors.twilio_inbound_call_mode ('crm' = CRM answers inbound calls; 'external' = keep contractor's Twilio Studio Flow/IVR, task #853)",
    },
    {
      sql: `ALTER TABLE user_contractors ADD COLUMN IF NOT EXISTS twilio_phone_to_ring text`,
      description: "user_contractors.twilio_phone_to_ring (rep's personal phone for bridge calls, task #822)",
    },
    {
      sql: `ALTER TABLE contractors ADD COLUMN IF NOT EXISTS twilio_ring_tree jsonb`,
      description: 'contractors.twilio_ring_tree (inbound-call ring order config; NULL = default first-user-with-phone behavior, task #854)',
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS "twilio_phone_numbers" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "contractor_id" varchar NOT NULL REFERENCES "contractors"("id"),
        "phone_number" text NOT NULL,
        "twilio_sid" text,
        "display_name" text,
        "can_send_sms" boolean NOT NULL DEFAULT false,
        "can_receive_sms" boolean NOT NULL DEFAULT false,
        "can_make_calls" boolean NOT NULL DEFAULT false,
        "can_receive_calls" boolean NOT NULL DEFAULT false,
        "is_active" boolean NOT NULL DEFAULT true,
        "last_sync_at" timestamp,
        "created_at" timestamp NOT NULL DEFAULT now(),
        "updated_at" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "twilio_phone_numbers_contractor_phone_unique" UNIQUE ("contractor_id", "phone_number")
      ); CREATE INDEX IF NOT EXISTS "twilio_phone_numbers_contractor_id_idx" ON "twilio_phone_numbers" ("contractor_id")`,
      description: 'twilio_phone_numbers table (task #822)',
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS "twilio_user_phone_permissions" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "user_id" varchar NOT NULL REFERENCES "users"("id"),
        "phone_number_id" varchar NOT NULL REFERENCES "twilio_phone_numbers"("id"),
        "contractor_id" varchar NOT NULL REFERENCES "contractors"("id"),
        "can_send_sms" boolean NOT NULL DEFAULT false,
        "can_make_calls" boolean NOT NULL DEFAULT false,
        "is_active" boolean NOT NULL DEFAULT true,
        "assigned_by" varchar REFERENCES "users"("id"),
        "created_at" timestamp NOT NULL DEFAULT now(),
        "updated_at" timestamp NOT NULL DEFAULT now(),
        CONSTRAINT "twilio_user_phone_perms_user_phone_unique" UNIQUE ("user_id", "phone_number_id")
      ); CREATE INDEX IF NOT EXISTS "twilio_user_phone_perms_user_id_idx" ON "twilio_user_phone_permissions" ("user_id"); CREATE INDEX IF NOT EXISTS "twilio_user_phone_perms_phone_id_idx" ON "twilio_user_phone_permissions" ("phone_number_id"); CREATE INDEX IF NOT EXISTS "twilio_user_phone_perms_contractor_id_idx" ON "twilio_user_phone_permissions" ("contractor_id")`,
      description: 'twilio_user_phone_permissions table (task #822)',
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS "twilio_webhook_state" (
        "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "contractor_id" varchar NOT NULL REFERENCES "contractors"("id") UNIQUE,
        "last_registered_voice_url" text,
        "last_registered_sms_url" text,
        "configured_number_sids" text[],
        "last_registered_at" timestamp,
        "updated_at" timestamp NOT NULL DEFAULT now()
      )`,
      description: 'twilio_webhook_state table (task #822)',
    },
    {
      sql: `ALTER TABLE "twilio_webhook_state" ADD COLUMN IF NOT EXISTS "configured_messaging_service_sids" text[]`,
      description: 'twilio_webhook_state.configured_messaging_service_sids (task #840)',
    },
    // ---- Task #844: reconnect orphaned Twilio recordings to their call ----
    // Twilio calls placed BEFORE the forward fix (which stamps
    // external_source='twilio' / external_id=<CallSid> on the click-to-call
    // activity) left two rows per call: a contact-linked "Phone call
    // initiated" row carrying metadata.externalCallId=<CallSid> but no
    // external_source/external_id, and an ORPHANED Twilio status/recording
    // row (external_source='twilio', external_id=<CallSid>, contact_id IS NULL)
    // that holds the recording but is detached from the contact's timeline.
    // This one-time, idempotent, tenant-scoped backfill (the metadata column
    // is `text` holding JSON, so every read casts `metadata::jsonb`) runs four
    // ordered statements in a single implicit transaction:
    //   A. Merge the orphan's recording/outcome fields into the originating
    //      click-to-call row (matched by CallSid: orphan.external_id =
    //      click-to-call metadata.externalCallId). external_id is NOT stamped
    //      yet so the unique index (contractor, external_source, external_id)
    //      cannot transiently collide while both rows still exist.
    //   B. Delete the now-merged orphan rows so each call shows ONE timeline
    //      entry with its recording.
    //   C. Stamp external_source='twilio'/external_id=<CallSid> on the merged
    //      click-to-call rows (orphan gone, so no unique-index conflict; a
    //      NOT EXISTS guard is belt-and-suspenders). This also lets any future
    //      webhook find and enrich the correct contact-linked row.
    //   D. Re-point any REMAINING orphans (no originating click-to-call row,
    //      e.g. inbound calls / voicemails) to the correct contact by matching
    //      the customer number (from_number for inbound, to_number otherwise)
    //      against contacts.normalized_phone — only when it resolves to exactly
    //      one contact.
    // Idempotent: A/B match only contact_id IS NULL orphans (gone after a full
    // run), C stamps only un-stamped rows that carry a merged call_sid, and D
    // touches only contact_id IS NULL orphans. Forward-fixed rows (external_id
    // already set) are excluded throughout. Historical-only; no live behavior
    // changes.
    {
      sql: `
        UPDATE activities a
        SET metadata = (
              (a.metadata::jsonb)
              || jsonb_build_object('provider', 'twilio')
              || jsonb_strip_nulls(jsonb_build_object(
                   'call_sid',           o.external_id,
                   'recording_url',      (o.metadata::jsonb)->>'recording_url',
                   'recording_sid',      (o.metadata::jsonb)->>'recording_sid',
                   'recording_playable', (o.metadata::jsonb)->'recording_playable',
                   'recording_details',  (o.metadata::jsonb)->'recording_details',
                   'outcome',            (o.metadata::jsonb)->>'outcome',
                   'duration_seconds',   (o.metadata::jsonb)->'duration_seconds'
                 ))
            )::text,
            updated_at = now()
        FROM activities o
        WHERE o.external_source = 'twilio'
          AND o.external_id IS NOT NULL
          AND o.contact_id IS NULL
          AND a.contractor_id = o.contractor_id
          AND a.type = 'call'
          AND a.contact_id IS NOT NULL
          AND a.external_id IS NULL
          AND a.external_source IS NULL
          AND (a.metadata::jsonb)->>'externalCallId' = o.external_id;

        DELETE FROM activities o
        WHERE o.external_source = 'twilio'
          AND o.external_id IS NOT NULL
          AND o.contact_id IS NULL
          AND EXISTS (
            SELECT 1 FROM activities c
            WHERE c.contractor_id = o.contractor_id
              AND c.type = 'call'
              AND c.contact_id IS NOT NULL
              AND (c.metadata::jsonb)->>'externalCallId' = o.external_id
          );

        UPDATE activities a
        SET external_source = 'twilio',
            external_id = (a.metadata::jsonb)->>'call_sid',
            updated_at = now()
        WHERE a.type = 'call'
          AND a.contact_id IS NOT NULL
          AND a.external_id IS NULL
          AND a.external_source IS NULL
          AND (a.metadata::jsonb) ? 'call_sid'
          AND (a.metadata::jsonb)->>'call_sid' <> ''
          AND NOT EXISTS (
            SELECT 1 FROM activities x
            WHERE x.contractor_id = a.contractor_id
              AND x.external_source = 'twilio'
              AND x.external_id = (a.metadata::jsonb)->>'call_sid'
          );

        UPDATE activities o
        SET contact_id = m.cid,
            updated_at = now()
        FROM (
          SELECT a.id AS aid, MIN(c.id) AS cid
          FROM activities a
          JOIN contacts c
            ON c.contractor_id = a.contractor_id
           AND c.normalized_phone IS NOT NULL
           AND c.normalized_phone <> ''
           AND c.normalized_phone = RIGHT(REGEXP_REPLACE(
                 CASE WHEN (a.metadata::jsonb)->>'direction' = 'inbound'
                      THEN (a.metadata::jsonb)->>'from_number'
                      ELSE (a.metadata::jsonb)->>'to_number' END,
                 '\\D', '', 'g'), 10)
          WHERE a.external_source = 'twilio'
            AND a.external_id IS NOT NULL
            AND a.contact_id IS NULL
          GROUP BY a.id
          HAVING COUNT(DISTINCT c.id) = 1
        ) m
        WHERE o.id = m.aid;
      `,
      description: 'backfill: reconnect orphaned Twilio call/recording activities to their contact (task #844)',
    },
  ];

export async function applyColumnMigrations(
  pool: SchemaDriftPool,
  logger: SchemaDriftLogger = defaultLogger,
): Promise<void> {
  for (const { sql: stmt, description } of columnMigrations) {
    try {
      await pool.query(stmt);
      logger.info(`[db] migration applied: ${description}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`[db] migration failed (${description}): ${message}`);
    }
  }
}

/**
 * Compares every table/column declared in the Drizzle schema (`shared/schema/*`)
 * against the live `information_schema.columns` view. If any Drizzle-declared
 * table or column is missing from the database, this throws — which crashes
 * boot loudly instead of letting routes 500 with `column "x" does not exist`
 * later (tasks #432, #433, #434).
 *
 * The fix when this fires is always the same: add an idempotent
 * `ALTER TABLE … ADD COLUMN IF NOT EXISTS …` (or `CREATE TABLE IF NOT EXISTS …`)
 * entry to `columnMigrations` above.
 */
export async function runSchemaDriftCheck(
  pool: SchemaDriftPool,
  logger: SchemaDriftLogger = defaultLogger,
): Promise<void> {
  const expected = new Map<string, Set<string>>();
  for (const value of Object.values(schema)) {
    if (!isTable(value as unknown)) continue;
    const table = value as unknown as Table;
    const tableName = getTableName(table);
    const columnSet = new Set<string>();
    for (const col of Object.values(getTableColumns(table)) as Array<{ name: string }>) {
      columnSet.add(col.name);
    }
    expected.set(tableName, columnSet);
  }

  // Fail closed: if we cannot read information_schema we have no way to prove
  // the live database matches the Drizzle schema, so refuse to start.
  const result = (await pool.query(
    `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`,
  )) as { rows: Array<{ table_name: string; column_name: string }> };

  const actual = new Map<string, Set<string>>();
  for (const row of result.rows) {
    let cols = actual.get(row.table_name);
    if (!cols) {
      cols = new Set();
      actual.set(row.table_name, cols);
    }
    cols.add(row.column_name);
  }

  const missingTables: string[] = [];
  const missingColumns: string[] = [];
  for (const [tableName, columns] of Array.from(expected.entries())) {
    const actualCols = actual.get(tableName);
    if (!actualCols) {
      missingTables.push(tableName);
      continue;
    }
    Array.from(columns).forEach((colName) => {
      if (!actualCols.has(colName)) {
        missingColumns.push(`${tableName}.${colName}`);
      }
    });
  }

  if (missingTables.length === 0 && missingColumns.length === 0) {
    logger.info('[db] schema drift check passed — every Drizzle-declared table/column exists in the database.');
    return;
  }

  const lines: string[] = [
    '[db] SCHEMA DRIFT DETECTED — Drizzle declares tables/columns that the live database is missing.',
    '     Add an idempotent statement to the columnMigrations array in server/schema-drift.ts',
    '     (the single source of truth for runtime schema changes) and redeploy.',
  ];
  for (const t of missingTables) lines.push(`       • missing table:  ${t}`);
  for (const c of missingColumns) lines.push(`       • missing column: ${c}`);
  const message = lines.join('\n');
  logger.warn(message);
  throw new Error(
    `Schema drift: ${missingTables.length} missing table(s), ${missingColumns.length} missing column(s). See log for details.`,
  );
}
