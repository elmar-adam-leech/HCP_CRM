CREATE TABLE IF NOT EXISTS "lead_capture_inboxes" (
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
);

CREATE INDEX IF NOT EXISTS "lead_capture_inboxes_contractor_id_idx" ON "lead_capture_inboxes" ("contractor_id");
