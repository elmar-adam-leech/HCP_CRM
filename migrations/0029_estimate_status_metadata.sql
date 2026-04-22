-- Task #445: Persist top-level estimate status-change metadata
-- Adds two columns used by HCP webhook handlers + the polling sync to record
-- when (and why) an estimate's parent status last flipped. Both are nullable
-- and backfilled best-effort by server/sync/hcp-backfill-foundation.ts.
--
-- IF NOT EXISTS so the file is safe to re-run and is mirrored by startup
-- migrations in server/schema-drift.ts.

ALTER TABLE estimates ADD COLUMN IF NOT EXISTS approval_status_changed_at timestamp;
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS most_recent_status_change_reason text;
