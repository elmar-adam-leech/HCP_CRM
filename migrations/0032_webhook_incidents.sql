-- Task #678: persist HCP webhook outage incidents so admin notifications
-- fire exactly once per outage even when the server restarts repeatedly,
-- and so the auto-backfill is invoked at most once per incident.

CREATE TABLE IF NOT EXISTS "webhook_incidents" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  "contractor_id" varchar NOT NULL REFERENCES "contractors"("id"),
  "service" varchar NOT NULL,
  "kind" varchar NOT NULL,
  "opened_at" timestamp NOT NULL DEFAULT now(),
  "closed_at" timestamp,
  "notified_at" timestamp,
  "backfill_attempted_at" timestamp,
  "backfill_summary" text
);

CREATE INDEX IF NOT EXISTS "webhook_incidents_contractor_service_kind_idx"
  ON "webhook_incidents"("contractor_id", "service", "kind");

-- Unique partial index: at most one OPEN incident per (contractor, service,
-- kind). Combined with `INSERT ... ON CONFLICT DO NOTHING` in the app, this
-- gives us an atomic "open if not already open" guarantee — multiple health
-- checker ticks (or multiple processes) can race without ever producing
-- duplicate incidents, duplicate notifications, or duplicate backfills.
CREATE UNIQUE INDEX IF NOT EXISTS "webhook_incidents_unique_open_idx"
  ON "webhook_incidents"("contractor_id", "service", "kind")
  WHERE closed_at IS NULL;

-- Keep the non-unique lookup index too (pg planner will pick the cheaper one
-- per query) — but the original non-unique partial would shadow the unique
-- one, so drop it.
DROP INDEX IF EXISTS "webhook_incidents_open_idx";
