-- Task #682: Drop the stale single-column unique index on sales_processes.
--
-- The original sales_processes table (migration 0025) was created with a
-- unique index on `contractor_id` alone (`sales_processes_contractor_unique`)
-- back when every tenant only had a single cadence. When multi-cadence
-- support landed (Task #567), the Drizzle schema was updated to a partial
-- unique index on (contractor_id, trigger_type, COALESCE(target_status,''))
-- filtered by `archived_at IS NULL` — but no migration ever dropped the old
-- single-column unique. Both indexes coexisted in production, and the legacy
-- one rejected any second cadence per contractor with a 23505, surfacing as
-- a 500 from POST /api/sales-process/cadences.
--
-- This migration:
--   1) Idempotently (re)creates the partial unique index that matches the
--      Drizzle schema, so the DB-level uniqueness rule is in place before
--      the old constraint is removed.
--   2) Drops the stale single-column unique index.
--
-- Both statements are guarded with IF (NOT) EXISTS so they're safe on fresh
-- databases (where 0025 + the multi-cadence ALTERs from 0027/0028 era have
-- already established the new shape) and on the production database where
-- the stale index is currently sitting.

CREATE UNIQUE INDEX IF NOT EXISTS "sales_processes_trigger_unique"
  ON "sales_processes"("contractor_id", "trigger_type", COALESCE("target_status", ''))
  WHERE "archived_at" IS NULL;

DROP INDEX IF EXISTS "sales_processes_contractor_unique";
