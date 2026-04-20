-- GDPR & CCPA foundations: contact privacy fields, contractor settings, consent logs, audit log extensions

ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "last_activity_at" timestamp;
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "erased_at" timestamp;
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "anonymized" boolean NOT NULL DEFAULT false;
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "retention_flagged_at" timestamp;

ALTER TABLE "contractors" ADD COLUMN IF NOT EXISTS "data_retention_months" integer;
ALTER TABLE "contractors" ADD COLUMN IF NOT EXISTS "privacy_notice_markdown" text;

CREATE TABLE IF NOT EXISTS "consent_logs" (
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
);

CREATE INDEX IF NOT EXISTS "consent_logs_contractor_created_at_idx" ON "consent_logs" ("contractor_id", "created_at");
CREATE INDEX IF NOT EXISTS "consent_logs_contact_id_idx" ON "consent_logs" ("contact_id");

ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "reason" text;
CREATE INDEX IF NOT EXISTS "audit_logs_entity_id_idx" ON "audit_logs" ("entity_id");
