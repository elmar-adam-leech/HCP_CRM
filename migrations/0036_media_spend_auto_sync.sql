-- Task #702: extend media_spend with auto-sync metadata so rows imported
-- from Facebook Ads / Google Ads can be distinguished from manually
-- entered ones in the UI, and the auto-sync job can avoid clobbering
-- manual entries.
--
-- All ALTERs use IF NOT EXISTS so the file is safe to re-run and is
-- mirrored by startup migrations in server/schema-drift.ts.

ALTER TABLE media_spend ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual';
ALTER TABLE media_spend ADD COLUMN IF NOT EXISTS external_account_id text;
ALTER TABLE media_spend ADD COLUMN IF NOT EXISTS last_synced_at timestamp;
