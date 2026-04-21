-- Task #506: Sales Process settings + scheduling engine
-- Adds three tables and four enums to encode and schedule per-tenant
-- best-practice cadences for new leads.
--
-- All statements are idempotent (IF NOT EXISTS / DO blocks) so the file is
-- safe to re-run.

DO $$ BEGIN
  CREATE TYPE "sales_process_action_type" AS ENUM ('call', 'text', 'email');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "sales_process_step_mode" AS ENUM ('manual', 'auto');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "sales_process_task_status" AS ENUM ('pending', 'completed', 'skipped', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "sales_process_completion_reason" AS ENUM (
    'manual', 'activity_logged', 'auto_sent', 'lead_status_changed', 'step_deleted'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "sales_processes" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  "contractor_id" varchar NOT NULL REFERENCES "contractors"("id") ON DELETE CASCADE,
  "name" text NOT NULL DEFAULT 'Default sales process',
  "active" boolean NOT NULL DEFAULT false,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "sales_processes_contractor_unique"
  ON "sales_processes"("contractor_id");

CREATE TABLE IF NOT EXISTS "sales_process_steps" (
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
);

CREATE INDEX IF NOT EXISTS "sales_process_steps_process_idx"
  ON "sales_process_steps"("sales_process_id");

CREATE UNIQUE INDEX IF NOT EXISTS "sales_process_steps_unique_per_process"
  ON "sales_process_steps"("sales_process_id", "day_offset", "action_type");

CREATE TABLE IF NOT EXISTS "sales_process_task_instances" (
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
);

CREATE INDEX IF NOT EXISTS "sales_process_task_instances_tenant_status_due_idx"
  ON "sales_process_task_instances"("contractor_id", "status", "due_at");

CREATE INDEX IF NOT EXISTS "sales_process_task_instances_lead_status_idx"
  ON "sales_process_task_instances"("lead_id", "status");
