-- Distinguish permanently-failed background processing from successful processing.
-- See server/jobs/dialpad-event-worker.ts and shared/schema/messages.ts.
ALTER TABLE "webhook_events" ADD COLUMN IF NOT EXISTS "failed_at" timestamp;

CREATE INDEX IF NOT EXISTS "webhook_events_failed_at_idx" ON "webhook_events" ("failed_at");

-- Migrate existing rows: any row that was marked processed=true while carrying
-- a "Background processing failed after" error_message was actually a permanent
-- failure under the old encoding. Re-stamp those as the new failed state so
-- audit views and the backlog checker count them correctly.
UPDATE "webhook_events"
SET "processed" = false,
    "failed_at" = COALESCE("processed_at", now())
WHERE "processed" = true
  AND "error_message" LIKE 'Background processing failed after%';

-- Rebuild the partial pending-events index to also exclude failed rows.
DROP INDEX IF EXISTS "webhook_events_unprocessed_idx";
CREATE INDEX IF NOT EXISTS "webhook_events_unprocessed_idx"
  ON "webhook_events" ("created_at")
  WHERE processed = false AND failed_at IS NULL;
