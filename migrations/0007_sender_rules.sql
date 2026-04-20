ALTER TABLE "lead_capture_inboxes" ADD COLUMN IF NOT EXISTS "sender_rules" jsonb DEFAULT '[]'::jsonb;
