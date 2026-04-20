ALTER TABLE "lead_capture_inboxes" ADD COLUMN IF NOT EXISTS "spam_confidence_threshold" integer NOT NULL DEFAULT 80;

CREATE TABLE IF NOT EXISTS "spam_audit_log" (
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
);

CREATE INDEX IF NOT EXISTS "spam_audit_log_inbox_id_idx" ON "spam_audit_log"("inbox_id");
CREATE INDEX IF NOT EXISTS "spam_audit_log_contractor_id_idx" ON "spam_audit_log"("contractor_id");
