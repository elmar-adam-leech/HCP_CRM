-- Task #684: speed up the HCP webhook-health checker queries.
--
-- The HcpWebhookHealth tick runs four queries against `webhook_events` that
-- all filter by (contractor_id, service) plus event_type and either pick the
-- latest row by created_at or aggregate over a 10-minute / 24-hour window.
-- The existing single-column indexes force the planner to bitmap-AND across
-- multiple narrow indexes and re-sort by created_at, which is slow enough
-- under DB-pool pressure to time out at the connection layer (the symptom
-- seen in production: "timeout exceeded when trying to connect").
--
-- A composite (contractor_id, service, event_type, created_at DESC) covers
-- every one of those queries with a single index-only / index-range scan.
--
-- This statement is mirrored in `server/schema-drift.ts` `columnMigrations`
-- so that it is also applied at boot on environments that bypass drizzle-kit.

CREATE INDEX IF NOT EXISTS "webhook_events_contractor_service_event_type_created_at_idx"
  ON "webhook_events"("contractor_id", "service", "event_type", "created_at" DESC);
