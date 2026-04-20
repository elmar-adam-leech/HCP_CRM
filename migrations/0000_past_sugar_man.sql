-- ============================================================
-- Migration 0000: Initial schema
-- ============================================================
-- Enable pg_trgm FIRST — required for any GIN trigram indexes
-- on text columns used for ILIKE search. The extension is
-- idempotent and safe to run on every deploy.
-- ============================================================
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ============================================================
-- Enum types
-- ============================================================
DO $$ BEGIN
  CREATE TYPE "user_role" AS ENUM ('super_admin', 'admin', 'manager', 'user');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "contact_type" AS ENUM ('lead', 'customer', 'inactive');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "contact_status" AS ENUM ('new', 'contacted', 'scheduled', 'active', 'disqualified', 'inactive');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "lead_status" AS ENUM ('new', 'contacted', 'qualified', 'converted', 'disqualified');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "job_status" AS ENUM ('scheduled', 'in_progress', 'completed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "job_priority" AS ENUM ('low', 'medium', 'high');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "estimate_status" AS ENUM ('draft', 'sent', 'pending', 'approved', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "message_type" AS ENUM ('text', 'email');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "message_status" AS ENUM ('sent', 'delivered', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "message_direction" AS ENUM ('inbound', 'outbound');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "template_type" AS ENUM ('text', 'email');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "template_status" AS ENUM ('draft', 'pending_approval', 'approved', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "provider_type" AS ENUM ('email', 'sms', 'calling');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "email_provider" AS ENUM ('gmail', 'sendgrid', 'outlook', 'mailgun');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "sms_provider" AS ENUM ('dialpad', 'twilio', 'messagebird', 'nexmo');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "calling_provider" AS ENUM ('dialpad', 'twilio', 'ringcentral', 'zoom');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "activity_type" AS ENUM ('note', 'call', 'email', 'sms', 'meeting', 'follow_up', 'status_change');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "dialpad_owner_type" AS ENUM ('user', 'department', 'company');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "dialpad_sync_status" AS ENUM ('pending', 'in_progress', 'completed', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "notification_type" AS ENUM ('lead_assigned', 'estimate_approved', 'estimate_rejected', 'job_completed', 'new_message', 'follow_up_due', 'system');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "workflow_trigger_type" AS ENUM ('entity_created', 'entity_updated', 'status_changed', 'field_changed', 'time_based', 'manual');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "workflow_action_type" AS ENUM ('send_email', 'send_sms', 'create_notification', 'update_entity', 'assign_user', 'ai_generate_content', 'ai_analyze', 'conditional_branch', 'delay', 'wait_until');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "workflow_execution_status" AS ENUM ('pending', 'running', 'completed', 'failed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "workflow_approval_status" AS ENUM ('approved', 'pending_approval', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "employee_role" AS ENUM ('sales', 'technician', 'estimator', 'dispatcher', 'manager', 'admin');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "sync_frequency" AS ENUM ('daily', 'weekly', 'hourly', 'every-5-minutes');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================
-- Tables
-- ============================================================

-- contractors (root tenant table — no foreign key deps)
CREATE TABLE IF NOT EXISTS "contractors" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "domain" text NOT NULL UNIQUE,
  "booking_slug" text UNIQUE,
  "timezone" text DEFAULT 'America/New_York',
  "housecall_pro_sync_start_date" timestamp,
  "default_dialpad_number" text,
  "dialpad_activity_last_sync_at" timestamp,
  "dialpad_activity_sync_enabled" boolean NOT NULL DEFAULT true,
  "webhook_api_key" varchar DEFAULT encode(gen_random_bytes(32), 'hex'),
  "created_at" timestamp NOT NULL DEFAULT now()
);

-- users (depends on contractors)
CREATE TABLE IF NOT EXISTS "users" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "username" text NOT NULL UNIQUE,
  "password" text NOT NULL,
  "name" text NOT NULL,
  "email" text NOT NULL,
  "role" user_role NOT NULL DEFAULT 'user',
  "token_version" integer NOT NULL DEFAULT 1,
  "contractor_id" varchar REFERENCES "contractors"("id"),
  "dialpad_default_number" text,
  "gmail_connected" boolean NOT NULL DEFAULT false,
  "gmail_refresh_token" text,
  "gmail_email" text,
  "gmail_last_sync_at" timestamp,
  "gmail_sync_history_id" text,
  "can_manage_integrations" boolean NOT NULL DEFAULT false,
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "users_email_idx" ON "users" ("email");
CREATE INDEX IF NOT EXISTS "users_email_lower_idx" ON "users" (lower("email"));
CREATE INDEX IF NOT EXISTS "users_contractor_id_idx" ON "users" ("contractor_id");

-- user_contractors (junction table)
CREATE TABLE IF NOT EXISTS "user_contractors" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" varchar NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "contractor_id" varchar NOT NULL REFERENCES "contractors"("id") ON DELETE CASCADE,
  "role" user_role NOT NULL DEFAULT 'user',
  "dialpad_default_number" text,
  "call_preference" text DEFAULT 'integration',
  "can_manage_integrations" boolean NOT NULL DEFAULT false,
  "is_salesperson" boolean NOT NULL DEFAULT false,
  "housecall_pro_user_id" text,
  "last_assignment_at" timestamp,
  "calendar_color" text,
  "working_days" integer[] DEFAULT '{1,2,3,4,5}',
  "working_hours_start" text DEFAULT '09:00',
  "working_hours_end" text DEFAULT '17:00',
  "has_custom_schedule" boolean NOT NULL DEFAULT false,
  "created_at" timestamp NOT NULL DEFAULT now(),
  UNIQUE ("user_id", "contractor_id")
);

CREATE INDEX IF NOT EXISTS "user_contractors_user_id_idx" ON "user_contractors" ("user_id");
CREATE INDEX IF NOT EXISTS "user_contractors_contractor_id_idx" ON "user_contractors" ("contractor_id");
CREATE INDEX IF NOT EXISTS "user_contractors_salesperson_idx" ON "user_contractors" ("contractor_id", "is_salesperson");

-- revoked_tokens
CREATE TABLE IF NOT EXISTS "revoked_tokens" (
  "jti" varchar PRIMARY KEY NOT NULL,
  "user_id" varchar NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "expires_at" timestamp NOT NULL,
  "revoked_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "revoked_tokens_expires_at_idx" ON "revoked_tokens" ("expires_at");
CREATE INDEX IF NOT EXISTS "revoked_tokens_user_id_idx" ON "revoked_tokens" ("user_id");

-- user_invitations
CREATE TABLE IF NOT EXISTS "user_invitations" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "email" text NOT NULL,
  "role" user_role NOT NULL DEFAULT 'user',
  "invite_code" text NOT NULL UNIQUE,
  "contractor_id" varchar NOT NULL REFERENCES "contractors"("id"),
  "invited_by" varchar NOT NULL REFERENCES "users"("id"),
  "accepted_at" timestamp,
  "expires_at" timestamp NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "user_invitations_contractor_id_idx" ON "user_invitations" ("contractor_id");
CREATE INDEX IF NOT EXISTS "user_invitations_invited_by_idx" ON "user_invitations" ("invited_by");

-- password_reset_tokens
CREATE TABLE IF NOT EXISTS "password_reset_tokens" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" varchar NOT NULL REFERENCES "users"("id"),
  "token" text NOT NULL UNIQUE,
  "expires_at" timestamp NOT NULL,
  "used_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "password_reset_tokens_user_id_idx" ON "password_reset_tokens" ("user_id");

-- oauth_states
CREATE TABLE IF NOT EXISTS "oauth_states" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "state" text NOT NULL UNIQUE,
  "user_id" varchar NOT NULL,
  "redirect_host" text NOT NULL,
  "expires_at" timestamp NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "oauth_states_state_idx" ON "oauth_states" ("state");
CREATE INDEX IF NOT EXISTS "oauth_states_expires_at_idx" ON "oauth_states" ("expires_at");

-- sync_schedules
CREATE TABLE IF NOT EXISTS "sync_schedules" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "contractor_id" varchar NOT NULL REFERENCES "contractors"("id"),
  "integration_name" varchar NOT NULL,
  "frequency" sync_frequency NOT NULL DEFAULT 'daily',
  "last_sync_at" timestamp,
  "next_sync_at" timestamp NOT NULL,
  "is_enabled" boolean NOT NULL DEFAULT true,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  UNIQUE ("contractor_id", "integration_name")
);

CREATE INDEX IF NOT EXISTS "sync_schedules_next_sync_at_idx" ON "sync_schedules" ("next_sync_at", "is_enabled");

-- terminology_settings
CREATE TABLE IF NOT EXISTS "terminology_settings" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "contractor_id" varchar NOT NULL REFERENCES "contractors"("id") UNIQUE,
  "lead_label" text NOT NULL DEFAULT 'Lead',
  "leads_label" text NOT NULL DEFAULT 'Leads',
  "estimate_label" text NOT NULL DEFAULT 'Estimate',
  "estimates_label" text NOT NULL DEFAULT 'Estimates',
  "job_label" text NOT NULL DEFAULT 'Job',
  "jobs_label" text NOT NULL DEFAULT 'Jobs',
  "message_label" text NOT NULL DEFAULT 'Message',
  "messages_label" text NOT NULL DEFAULT 'Messages',
  "template_label" text NOT NULL DEFAULT 'Template',
  "templates_label" text NOT NULL DEFAULT 'Templates',
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

-- business_targets
CREATE TABLE IF NOT EXISTS "business_targets" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "contractor_id" varchar NOT NULL REFERENCES "contractors"("id"),
  "speed_to_lead_minutes" integer NOT NULL DEFAULT 60,
  "follow_up_rate_percent" decimal(5,2) NOT NULL DEFAULT 80.00,
  "set_rate_percent" decimal(5,2) NOT NULL DEFAULT 40.00,
  "close_rate_percent" decimal(5,2) NOT NULL DEFAULT 25.00,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "business_targets_contractor_id_idx" ON "business_targets" ("contractor_id");

-- contacts
CREATE TABLE IF NOT EXISTS "contacts" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "emails" text[] DEFAULT '{}',
  "phones" text[] DEFAULT '{}',
  "address" text,
  "type" contact_type NOT NULL DEFAULT 'lead',
  "status" contact_status NOT NULL DEFAULT 'new',
  "source" text,
  "notes" text,
  "tags" text[] DEFAULT '{}',
  "follow_up_date" timestamp,
  "utm_source" text,
  "utm_medium" text,
  "utm_campaign" text,
  "utm_term" text,
  "utm_content" text,
  "page_url" text,
  "housecall_pro_customer_id" varchar,
  "housecall_pro_estimate_id" varchar,
  "scheduled_at" timestamp,
  "scheduled_employee_id" varchar,
  "is_scheduled" boolean NOT NULL DEFAULT false,
  "contacted_at" timestamp,
  "contacted_by_user_id" varchar REFERENCES "users"("id"),
  "scheduled_by_user_id" varchar REFERENCES "users"("id"),
  "external_id" varchar,
  "external_source" varchar,
  "normalized_phone" text,
  "contractor_id" varchar NOT NULL REFERENCES "contractors"("id"),
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "contacts_contractor_id_idx" ON "contacts" ("contractor_id");
CREATE INDEX IF NOT EXISTS "contacts_type_idx" ON "contacts" ("type");
CREATE INDEX IF NOT EXISTS "contacts_status_idx" ON "contacts" ("status");
CREATE INDEX IF NOT EXISTS "contacts_is_scheduled_idx" ON "contacts" ("is_scheduled");
CREATE INDEX IF NOT EXISTS "contacts_created_at_idx" ON "contacts" ("created_at");
CREATE INDEX IF NOT EXISTS "contacts_contacted_at_idx" ON "contacts" ("contacted_at");
CREATE INDEX IF NOT EXISTS "contacts_contractor_type_idx" ON "contacts" ("contractor_id", "type");
CREATE INDEX IF NOT EXISTS "contacts_contractor_status_idx" ON "contacts" ("contractor_id", "status");
CREATE INDEX IF NOT EXISTS "contacts_contractor_scheduled_idx" ON "contacts" ("contractor_id", "is_scheduled");
CREATE INDEX IF NOT EXISTS "contacts_contractor_date_idx" ON "contacts" ("contractor_id", "created_at");
CREATE INDEX IF NOT EXISTS "contacts_external_lookup_idx" ON "contacts" ("contractor_id", "external_source", "external_id");
CREATE INDEX IF NOT EXISTS "contacts_tags_idx" ON "contacts" ("tags");
CREATE INDEX IF NOT EXISTS "contacts_follow_up_date_idx" ON "contacts" ("follow_up_date") WHERE follow_up_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS "contacts_contractor_follow_up_idx" ON "contacts" ("contractor_id", "follow_up_date") WHERE follow_up_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS "contacts_housecall_pro_customer_id_idx" ON "contacts" ("housecall_pro_customer_id") WHERE housecall_pro_customer_id IS NOT NULL;
-- GIN indexes for array-contains queries (@> operator) — require the btree_gin or built-in GIN operator class
CREATE INDEX IF NOT EXISTS "contacts_emails_gin_idx" ON "contacts" USING gin ("emails");
CREATE INDEX IF NOT EXISTS "contacts_phones_gin_idx" ON "contacts" USING gin ("phones");
CREATE INDEX IF NOT EXISTS "contacts_contractor_normalized_phone_idx" ON "contacts" ("contractor_id", "normalized_phone");

-- scheduled_bookings
CREATE TABLE IF NOT EXISTS "scheduled_bookings" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "contractor_id" varchar NOT NULL REFERENCES "contractors"("id") ON DELETE CASCADE,
  "assigned_salesperson_id" varchar NOT NULL REFERENCES "users"("id"),
  "contact_id" varchar REFERENCES "contacts"("id") ON DELETE SET NULL,
  "housecall_pro_event_id" text,
  "title" text NOT NULL,
  "start_time" timestamp NOT NULL,
  "end_time" timestamp NOT NULL,
  "customer_name" text,
  "customer_email" text,
  "customer_phone" text,
  "notes" text,
  "status" text NOT NULL DEFAULT 'confirmed',
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "scheduled_bookings_contractor_idx" ON "scheduled_bookings" ("contractor_id");
CREATE INDEX IF NOT EXISTS "scheduled_bookings_salesperson_idx" ON "scheduled_bookings" ("assigned_salesperson_id");
CREATE INDEX IF NOT EXISTS "scheduled_bookings_start_time_idx" ON "scheduled_bookings" ("start_time");

-- estimates
CREATE TABLE IF NOT EXISTS "estimates" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "title" text NOT NULL,
  "description" text,
  "amount" decimal(10,2) NOT NULL,
  "status" estimate_status NOT NULL DEFAULT 'draft',
  "valid_until" timestamp,
  "follow_up_date" timestamp,
  "contact_id" varchar NOT NULL REFERENCES "contacts"("id"),
  "housecall_pro_estimate_id" varchar,
  "housecall_pro_customer_id" varchar,
  "scheduled_start" timestamp,
  "scheduled_end" timestamp,
  "scheduled_employee_id" varchar,
  "synced_at" timestamp,
  "external_id" varchar,
  "external_source" varchar,
  "contractor_id" varchar NOT NULL REFERENCES "contractors"("id"),
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "estimates_contractor_id_idx" ON "estimates" ("contractor_id");
CREATE INDEX IF NOT EXISTS "estimates_contact_id_idx" ON "estimates" ("contact_id");
CREATE INDEX IF NOT EXISTS "estimates_status_idx" ON "estimates" ("status");
CREATE INDEX IF NOT EXISTS "estimates_created_at_idx" ON "estimates" ("created_at");
CREATE INDEX IF NOT EXISTS "estimates_contractor_status_idx" ON "estimates" ("contractor_id", "status");
CREATE INDEX IF NOT EXISTS "estimates_contractor_date_idx" ON "estimates" ("contractor_id", "created_at");
CREATE INDEX IF NOT EXISTS "estimates_follow_up_date_idx" ON "estimates" ("follow_up_date");
CREATE INDEX IF NOT EXISTS "estimates_external_id_contractor_idx" ON "estimates" ("external_id", "contractor_id") WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS "estimates_housecall_pro_estimate_id_idx" ON "estimates" ("housecall_pro_estimate_id") WHERE housecall_pro_estimate_id IS NOT NULL;
-- B-tree composite index for title search (ILIKE with pg_trgm uses a separate GIN — this supports sort/filter)
CREATE INDEX IF NOT EXISTS "estimates_contractor_title_idx" ON "estimates" ("contractor_id", "title");

-- jobs
CREATE TABLE IF NOT EXISTS "jobs" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "title" text NOT NULL,
  "type" text NOT NULL,
  "status" job_status NOT NULL DEFAULT 'scheduled',
  "priority" job_priority NOT NULL DEFAULT 'medium',
  "value" decimal(10,2) NOT NULL,
  "estimated_hours" integer,
  "scheduled_date" timestamp,
  "contact_id" varchar NOT NULL REFERENCES "contacts"("id"),
  "estimate_id" varchar REFERENCES "estimates"("id"),
  "notes" text,
  "external_id" varchar,
  "external_source" varchar,
  "contractor_id" varchar NOT NULL REFERENCES "contractors"("id"),
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "jobs_contractor_id_idx" ON "jobs" ("contractor_id");
CREATE INDEX IF NOT EXISTS "jobs_contact_id_idx" ON "jobs" ("contact_id");
CREATE INDEX IF NOT EXISTS "jobs_status_idx" ON "jobs" ("status");
CREATE INDEX IF NOT EXISTS "jobs_created_at_idx" ON "jobs" ("created_at");
CREATE INDEX IF NOT EXISTS "jobs_scheduled_date_idx" ON "jobs" ("scheduled_date");
CREATE INDEX IF NOT EXISTS "jobs_contractor_status_idx" ON "jobs" ("contractor_id", "status");
CREATE INDEX IF NOT EXISTS "jobs_contractor_date_idx" ON "jobs" ("contractor_id", "created_at");
CREATE INDEX IF NOT EXISTS "jobs_external_id_idx" ON "jobs" ("external_id") WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS "jobs_estimate_id_idx" ON "jobs" ("estimate_id");
CREATE INDEX IF NOT EXISTS "jobs_contractor_title_idx" ON "jobs" ("contractor_id", "title");

-- leads
CREATE TABLE IF NOT EXISTS "leads" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "contact_id" varchar NOT NULL REFERENCES "contacts"("id") ON DELETE CASCADE,
  "status" lead_status NOT NULL DEFAULT 'new',
  "source" text,
  "message" text,
  "housecall_pro_lead_id" varchar,
  "utm_source" text,
  "utm_medium" text,
  "utm_campaign" text,
  "utm_term" text,
  "utm_content" text,
  "page_url" text,
  "raw_payload" text,
  "archived" boolean NOT NULL DEFAULT false,
  "follow_up_date" timestamp,
  "converted_at" timestamp,
  "converted_to_estimate_id" varchar REFERENCES "estimates"("id"),
  "converted_to_job_id" varchar REFERENCES "jobs"("id"),
  "assigned_to_user_id" varchar REFERENCES "users"("id"),
  "contractor_id" varchar NOT NULL REFERENCES "contractors"("id"),
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "leads_contractor_id_idx" ON "leads" ("contractor_id");
CREATE INDEX IF NOT EXISTS "leads_contact_id_idx" ON "leads" ("contact_id");
CREATE INDEX IF NOT EXISTS "leads_status_idx" ON "leads" ("status");
CREATE INDEX IF NOT EXISTS "leads_created_at_idx" ON "leads" ("created_at");
CREATE INDEX IF NOT EXISTS "leads_contractor_status_idx" ON "leads" ("contractor_id", "status");
CREATE INDEX IF NOT EXISTS "leads_contractor_date_idx" ON "leads" ("contractor_id", "created_at");
CREATE INDEX IF NOT EXISTS "leads_contact_created_idx" ON "leads" ("contact_id", "created_at");
CREATE INDEX IF NOT EXISTS "leads_assigned_to_user_id_idx" ON "leads" ("assigned_to_user_id");
CREATE INDEX IF NOT EXISTS "leads_converted_to_estimate_id_idx" ON "leads" ("converted_to_estimate_id");
CREATE INDEX IF NOT EXISTS "leads_converted_to_job_id_idx" ON "leads" ("converted_to_job_id");

-- messages
CREATE TABLE IF NOT EXISTS "messages" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "type" message_type NOT NULL DEFAULT 'text',
  "status" message_status NOT NULL DEFAULT 'sent',
  "direction" message_direction NOT NULL DEFAULT 'outbound',
  "content" text NOT NULL,
  "to_number" text NOT NULL,
  "from_number" text,
  "contact_id" varchar REFERENCES "contacts"("id") ON DELETE CASCADE,
  "estimate_id" varchar REFERENCES "estimates"("id") ON DELETE CASCADE,
  "user_id" varchar REFERENCES "users"("id") ON DELETE SET NULL,
  "external_message_id" text,
  "contractor_id" varchar NOT NULL REFERENCES "contractors"("id"),
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "messages_contractor_id_idx" ON "messages" ("contractor_id");
CREATE INDEX IF NOT EXISTS "messages_contact_id_idx" ON "messages" ("contact_id");
CREATE INDEX IF NOT EXISTS "messages_to_number_idx" ON "messages" ("to_number");
CREATE INDEX IF NOT EXISTS "messages_from_number_idx" ON "messages" ("from_number");
CREATE INDEX IF NOT EXISTS "messages_direction_idx" ON "messages" ("direction");
CREATE INDEX IF NOT EXISTS "messages_created_at_idx" ON "messages" ("created_at");
CREATE INDEX IF NOT EXISTS "messages_estimate_id_idx" ON "messages" ("estimate_id");
CREATE INDEX IF NOT EXISTS "messages_contractor_phone_idx" ON "messages" ("contractor_id", "to_number");
CREATE INDEX IF NOT EXISTS "messages_contractor_contact_idx" ON "messages" ("contractor_id", "contact_id");
CREATE INDEX IF NOT EXISTS "messages_external_message_id_idx" ON "messages" ("external_message_id");
CREATE INDEX IF NOT EXISTS "messages_contractor_contact_created_idx" ON "messages" ("contractor_id", "contact_id", "created_at");

-- webhooks
CREATE TABLE IF NOT EXISTS "webhooks" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "contractor_id" varchar NOT NULL REFERENCES "contractors"("id"),
  "service" varchar NOT NULL,
  "webhook_type" varchar NOT NULL,
  "external_webhook_id" varchar,
  "webhook_url" text NOT NULL,
  "is_active" boolean NOT NULL DEFAULT true,
  "last_received_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "webhooks_contractor_id_idx" ON "webhooks" ("contractor_id");
CREATE INDEX IF NOT EXISTS "webhooks_service_idx" ON "webhooks" ("service");
CREATE INDEX IF NOT EXISTS "webhooks_webhook_type_idx" ON "webhooks" ("webhook_type");
CREATE INDEX IF NOT EXISTS "webhooks_is_active_idx" ON "webhooks" ("is_active");
CREATE INDEX IF NOT EXISTS "webhooks_contractor_service_idx" ON "webhooks" ("contractor_id", "service");

-- webhook_events
CREATE TABLE IF NOT EXISTS "webhook_events" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "webhook_id" varchar REFERENCES "webhooks"("id"),
  "contractor_id" varchar REFERENCES "contractors"("id"),
  "service" varchar NOT NULL,
  "event_type" varchar NOT NULL,
  "payload" text NOT NULL,
  "processed" boolean NOT NULL DEFAULT false,
  "processed_at" timestamp,
  "error_message" text,
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "webhook_events_webhook_id_idx" ON "webhook_events" ("webhook_id");
CREATE INDEX IF NOT EXISTS "webhook_events_contractor_id_idx" ON "webhook_events" ("contractor_id");
CREATE INDEX IF NOT EXISTS "webhook_events_service_idx" ON "webhook_events" ("service");
CREATE INDEX IF NOT EXISTS "webhook_events_event_type_idx" ON "webhook_events" ("event_type");
CREATE INDEX IF NOT EXISTS "webhook_events_processed_idx" ON "webhook_events" ("processed");
CREATE INDEX IF NOT EXISTS "webhook_events_created_at_idx" ON "webhook_events" ("created_at");
CREATE INDEX IF NOT EXISTS "webhook_events_processed_created_at_idx" ON "webhook_events" ("processed", "created_at");
CREATE INDEX IF NOT EXISTS "webhook_events_unprocessed_idx" ON "webhook_events" ("created_at") WHERE processed = false;

-- templates
CREATE TABLE IF NOT EXISTS "templates" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "title" text NOT NULL,
  "content" text NOT NULL,
  "type" template_type NOT NULL,
  "status" template_status NOT NULL DEFAULT 'pending_approval',
  "created_by" varchar NOT NULL REFERENCES "users"("id"),
  "approved_by" varchar REFERENCES "users"("id"),
  "approved_at" timestamp,
  "rejection_reason" text,
  "contractor_id" varchar NOT NULL REFERENCES "contractors"("id"),
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "templates_contractor_id_idx" ON "templates" ("contractor_id");
CREATE INDEX IF NOT EXISTS "templates_type_idx" ON "templates" ("type");

-- calls
CREATE TABLE IF NOT EXISTS "calls" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "external_call_id" varchar NOT NULL,
  "to_number" varchar NOT NULL,
  "from_number" varchar,
  "status" varchar NOT NULL DEFAULT 'initiated',
  "contact_id" varchar REFERENCES "contacts"("id"),
  "user_id" varchar REFERENCES "users"("id"),
  "contractor_id" varchar NOT NULL REFERENCES "contractors"("id"),
  "call_url" text,
  "metadata" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "calls_contractor_id_idx" ON "calls" ("contractor_id");
CREATE INDEX IF NOT EXISTS "calls_contact_id_idx" ON "calls" ("contact_id");
CREATE INDEX IF NOT EXISTS "calls_external_call_id_idx" ON "calls" ("external_call_id");
CREATE INDEX IF NOT EXISTS "calls_to_number_idx" ON "calls" ("to_number");
CREATE INDEX IF NOT EXISTS "calls_from_number_idx" ON "calls" ("from_number");
CREATE INDEX IF NOT EXISTS "calls_status_idx" ON "calls" ("status");
CREATE INDEX IF NOT EXISTS "calls_user_id_idx" ON "calls" ("user_id");
CREATE INDEX IF NOT EXISTS "calls_created_at_idx" ON "calls" ("created_at");
CREATE INDEX IF NOT EXISTS "calls_contractor_contact_idx" ON "calls" ("contractor_id", "contact_id");

-- activities
CREATE TABLE IF NOT EXISTS "activities" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "type" activity_type NOT NULL DEFAULT 'note',
  "title" text,
  "content" text NOT NULL,
  "metadata" text,
  "contact_id" varchar REFERENCES "contacts"("id") ON DELETE CASCADE,
  "estimate_id" varchar REFERENCES "estimates"("id") ON DELETE CASCADE,
  "job_id" varchar REFERENCES "jobs"("id") ON DELETE CASCADE,
  "user_id" varchar REFERENCES "users"("id") ON DELETE SET NULL,
  "contractor_id" varchar NOT NULL REFERENCES "contractors"("id"),
  "external_id" varchar,
  "external_source" varchar,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "activities_contractor_id_idx" ON "activities" ("contractor_id");
CREATE INDEX IF NOT EXISTS "activities_type_idx" ON "activities" ("type");
CREATE INDEX IF NOT EXISTS "activities_contact_id_idx" ON "activities" ("contact_id");
CREATE INDEX IF NOT EXISTS "activities_estimate_id_idx" ON "activities" ("estimate_id");
CREATE INDEX IF NOT EXISTS "activities_job_id_idx" ON "activities" ("job_id");
CREATE INDEX IF NOT EXISTS "activities_user_id_idx" ON "activities" ("user_id");
CREATE INDEX IF NOT EXISTS "activities_created_at_idx" ON "activities" ("created_at");
CREATE INDEX IF NOT EXISTS "activities_contractor_type_idx" ON "activities" ("contractor_id", "type");
CREATE INDEX IF NOT EXISTS "activities_contractor_contact_idx" ON "activities" ("contractor_id", "contact_id");
CREATE INDEX IF NOT EXISTS "activities_contractor_date_idx" ON "activities" ("contractor_id", "created_at");
CREATE INDEX IF NOT EXISTS "activities_external_lookup_idx" ON "activities" ("external_source", "external_id");
CREATE INDEX IF NOT EXISTS "activities_contractor_type_contact_idx" ON "activities" ("contractor_id", "type", "contact_id");
CREATE INDEX IF NOT EXISTS "activities_contractor_contact_date_idx" ON "activities" ("contractor_id", "contact_id", "created_at");

-- notifications
CREATE TABLE IF NOT EXISTS "notifications" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" varchar NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "contractor_id" varchar NOT NULL REFERENCES "contractors"("id") ON DELETE CASCADE,
  "type" notification_type NOT NULL,
  "title" text NOT NULL,
  "message" text NOT NULL,
  "link" text,
  "read" boolean NOT NULL DEFAULT false,
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "notifications_user_id_idx" ON "notifications" ("user_id");
CREATE INDEX IF NOT EXISTS "notifications_contractor_id_idx" ON "notifications" ("contractor_id");
CREATE INDEX IF NOT EXISTS "notifications_user_unread_idx" ON "notifications" ("user_id", "read");
CREATE INDEX IF NOT EXISTS "notifications_created_at_idx" ON "notifications" ("created_at");
CREATE INDEX IF NOT EXISTS "notifications_user_contractor_unread_created_idx" ON "notifications" ("user_id", "contractor_id", "read", "created_at");

-- contractor_credentials
CREATE TABLE IF NOT EXISTS "contractor_credentials" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" varchar NOT NULL REFERENCES "contractors"("id"),
  "service" varchar NOT NULL,
  "credential_key" varchar NOT NULL,
  "encrypted_value" text NOT NULL,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  UNIQUE ("tenant_id", "service", "credential_key")
);

-- contractor_providers
CREATE TABLE IF NOT EXISTS "contractor_providers" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" varchar NOT NULL REFERENCES "contractors"("id"),
  "provider_type" provider_type NOT NULL,
  "email_provider" email_provider,
  "sms_provider" sms_provider,
  "calling_provider" calling_provider,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  UNIQUE ("tenant_id", "provider_type")
);

-- contractor_integrations
CREATE TABLE IF NOT EXISTS "contractor_integrations" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" varchar NOT NULL REFERENCES "contractors"("id"),
  "integration_name" varchar NOT NULL,
  "is_enabled" boolean NOT NULL DEFAULT false,
  "enabled_at" timestamp,
  "disabled_at" timestamp,
  "enabled_by" varchar REFERENCES "users"("id"),
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  UNIQUE ("tenant_id", "integration_name")
);

CREATE INDEX IF NOT EXISTS "contractor_integrations_enabled_by_idx" ON "contractor_integrations" ("enabled_by");

-- employees
CREATE TABLE IF NOT EXISTS "employees" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "contractor_id" varchar NOT NULL REFERENCES "contractors"("id"),
  "external_source" varchar,
  "external_id" varchar,
  "first_name" text NOT NULL,
  "last_name" text NOT NULL,
  "email" text,
  "is_active" boolean NOT NULL DEFAULT true,
  "external_role" text,
  "roles" text[] NOT NULL DEFAULT '{}',
  "department" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  UNIQUE ("contractor_id", "external_source", "external_id")
);

-- dialpad_phone_numbers
CREATE TABLE IF NOT EXISTS "dialpad_phone_numbers" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "contractor_id" varchar NOT NULL REFERENCES "contractors"("id"),
  "phone_number" text NOT NULL,
  "dialpad_id" text,
  "display_name" text,
  "department" text,
  "can_send_sms" boolean NOT NULL DEFAULT false,
  "can_receive_sms" boolean NOT NULL DEFAULT false,
  "can_make_calls" boolean NOT NULL DEFAULT false,
  "can_receive_calls" boolean NOT NULL DEFAULT false,
  "is_active" boolean NOT NULL DEFAULT true,
  "last_sync_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  UNIQUE ("contractor_id", "phone_number")
);

-- user_phone_number_permissions
CREATE TABLE IF NOT EXISTS "user_phone_number_permissions" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" varchar NOT NULL REFERENCES "users"("id"),
  "phone_number_id" varchar NOT NULL REFERENCES "dialpad_phone_numbers"("id"),
  "contractor_id" varchar NOT NULL REFERENCES "contractors"("id"),
  "can_send_sms" boolean NOT NULL DEFAULT false,
  "can_make_calls" boolean NOT NULL DEFAULT false,
  "is_active" boolean NOT NULL DEFAULT true,
  "assigned_by" varchar REFERENCES "users"("id"),
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  UNIQUE ("user_id", "phone_number_id")
);

CREATE INDEX IF NOT EXISTS "user_phone_permissions_user_id_idx" ON "user_phone_number_permissions" ("user_id");
CREATE INDEX IF NOT EXISTS "user_phone_permissions_phone_number_id_idx" ON "user_phone_number_permissions" ("phone_number_id");
CREATE INDEX IF NOT EXISTS "user_phone_permissions_contractor_id_idx" ON "user_phone_number_permissions" ("contractor_id");

-- dialpad_users
CREATE TABLE IF NOT EXISTS "dialpad_users" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "contractor_id" varchar NOT NULL REFERENCES "contractors"("id"),
  "dialpad_user_id" text NOT NULL,
  "email" text NOT NULL,
  "first_name" text,
  "last_name" text,
  "full_name" text,
  "is_active" boolean NOT NULL DEFAULT true,
  "department" text,
  "phone_numbers" text[] DEFAULT '{}',
  "last_sync_at" timestamp,
  "sync_checksum" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  UNIQUE ("contractor_id", "dialpad_user_id")
);

CREATE INDEX IF NOT EXISTS "dialpad_users_contractor_id_idx" ON "dialpad_users" ("contractor_id");

-- dialpad_departments
CREATE TABLE IF NOT EXISTS "dialpad_departments" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "contractor_id" varchar NOT NULL REFERENCES "contractors"("id"),
  "dialpad_department_id" text NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "is_active" boolean NOT NULL DEFAULT true,
  "phone_numbers" text[] DEFAULT '{}',
  "user_count" integer DEFAULT 0,
  "last_sync_at" timestamp,
  "sync_checksum" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  UNIQUE ("contractor_id", "dialpad_department_id")
);

CREATE INDEX IF NOT EXISTS "dialpad_departments_contractor_id_idx" ON "dialpad_departments" ("contractor_id");

-- dialpad_sync_jobs
CREATE TABLE IF NOT EXISTS "dialpad_sync_jobs" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "contractor_id" varchar NOT NULL REFERENCES "contractors"("id"),
  "sync_type" text NOT NULL,
  "status" dialpad_sync_status NOT NULL DEFAULT 'pending',
  "started_at" timestamp,
  "completed_at" timestamp,
  "error_message" text,
  "records_processed" integer DEFAULT 0,
  "records_success" integer DEFAULT 0,
  "records_error" integer DEFAULT 0,
  "last_successful_sync_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "dialpad_sync_jobs_contractor_id_idx" ON "dialpad_sync_jobs" ("contractor_id");
CREATE INDEX IF NOT EXISTS "dialpad_sync_jobs_status_idx" ON "dialpad_sync_jobs" ("status");
CREATE INDEX IF NOT EXISTS "dialpad_sync_jobs_created_at_idx" ON "dialpad_sync_jobs" ("created_at");
CREATE INDEX IF NOT EXISTS "dialpad_sync_jobs_contractor_status_idx" ON "dialpad_sync_jobs" ("contractor_id", "status");

-- workflows
CREATE TABLE IF NOT EXISTS "workflows" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "contractor_id" varchar NOT NULL REFERENCES "contractors"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "description" text,
  "is_active" boolean NOT NULL DEFAULT false,
  "trigger_type" workflow_trigger_type NOT NULL,
  "trigger_config" text NOT NULL,
  "approval_status" workflow_approval_status NOT NULL DEFAULT 'pending_approval',
  "approved_by" varchar REFERENCES "users"("id"),
  "approved_at" timestamp,
  "rejection_reason" text,
  "created_by" varchar NOT NULL REFERENCES "users"("id"),
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "workflows_contractor_id_idx" ON "workflows" ("contractor_id");
CREATE INDEX IF NOT EXISTS "workflows_is_active_idx" ON "workflows" ("is_active");
CREATE INDEX IF NOT EXISTS "workflows_trigger_type_idx" ON "workflows" ("trigger_type");
CREATE INDEX IF NOT EXISTS "workflows_approval_status_idx" ON "workflows" ("approval_status");
CREATE INDEX IF NOT EXISTS "workflows_contractor_active_idx" ON "workflows" ("contractor_id", "is_active");
CREATE INDEX IF NOT EXISTS "workflows_contractor_approval_idx" ON "workflows" ("contractor_id", "approval_status");

-- workflow_steps
CREATE TABLE IF NOT EXISTS "workflow_steps" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workflow_id" varchar NOT NULL REFERENCES "workflows"("id") ON DELETE CASCADE,
  "step_order" integer NOT NULL,
  "action_type" workflow_action_type NOT NULL,
  "action_config" text NOT NULL,
  "parent_step_id" varchar,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "workflow_steps_workflow_id_idx" ON "workflow_steps" ("workflow_id");
CREATE INDEX IF NOT EXISTS "workflow_steps_workflow_order_idx" ON "workflow_steps" ("workflow_id", "step_order");
CREATE INDEX IF NOT EXISTS "workflow_steps_parent_step_id_idx" ON "workflow_steps" ("parent_step_id");

-- workflow_executions
CREATE TABLE IF NOT EXISTS "workflow_executions" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workflow_id" varchar NOT NULL REFERENCES "workflows"("id") ON DELETE CASCADE,
  "contractor_id" varchar NOT NULL REFERENCES "contractors"("id") ON DELETE CASCADE,
  "status" workflow_execution_status NOT NULL DEFAULT 'pending',
  "trigger_data" text,
  "execution_log" text,
  "error_message" text,
  "current_step" integer,
  "started_at" timestamp,
  "completed_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "workflow_executions_workflow_id_idx" ON "workflow_executions" ("workflow_id");
CREATE INDEX IF NOT EXISTS "workflow_executions_contractor_id_idx" ON "workflow_executions" ("contractor_id");
CREATE INDEX IF NOT EXISTS "workflow_executions_status_idx" ON "workflow_executions" ("status");
CREATE INDEX IF NOT EXISTS "workflow_executions_created_at_idx" ON "workflow_executions" ("created_at");
CREATE INDEX IF NOT EXISTS "workflow_executions_workflow_status_idx" ON "workflow_executions" ("workflow_id", "status");
CREATE INDEX IF NOT EXISTS "workflow_executions_workflow_created_at_idx" ON "workflow_executions" ("workflow_id", "created_at");
