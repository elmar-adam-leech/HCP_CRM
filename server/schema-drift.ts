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
      sql: `UPDATE estimates SET status = 'scheduled' WHERE status = 'pending' AND external_source = 'housecall-pro' AND scheduled_start IS NOT NULL`,
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
      sql: `UPDATE estimates SET status = 'scheduled' WHERE status IN ('draft', 'pending')`,
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
