ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "approved_at" timestamp;
ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "rejected_at" timestamp;

-- Backfill existing rows so the Time-to-Close report has a value to anchor on.
-- We use updated_at as the best available approximation of the prior transition
-- time. Subsequent edits will not change this value because the application
-- only writes approved_at/rejected_at on first transition into the status.
UPDATE "estimates"
SET "approved_at" = "updated_at"
WHERE "status" = 'approved' AND "approved_at" IS NULL;

UPDATE "estimates"
SET "rejected_at" = "updated_at"
WHERE "status" = 'rejected' AND "rejected_at" IS NULL;
