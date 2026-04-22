-- Task #514: Speed up Reports loading
-- Adds composite indexes that match the actual filter shapes used by the
-- Estimates reports (Lost Revenue, Time to Close) and the Speed-to-Lead
-- report. All statements are idempotent so the file is safe to re-run.

-- Lost Revenue groups rejected estimates by month using updated_at as the
-- transition timestamp; Time to Close also reads updated_at. A composite
-- (contractor_id, status, updated_at) lets these queries do an index scan
-- instead of filtering on status after a contractor_date scan.
CREATE INDEX IF NOT EXISTS "estimates_contractor_status_updated_at_idx"
  ON "estimates" ("contractor_id", "status", "updated_at");

-- Speed-to-Lead joins activities to leads via contact_id and filters by
-- type='call'. The created_at column is then used to compute first-call
-- latency. This composite covers the (contractor_id, type, contact_id,
-- created_at) lookup so the join is index-only.
CREATE INDEX IF NOT EXISTS "activities_contractor_type_contact_created_idx"
  ON "activities" ("contractor_id", "type", "contact_id", "created_at");
