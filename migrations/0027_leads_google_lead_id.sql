-- Task #490: Index Google Local Services lead IDs for faster status updates.
-- Promotes the GLS lead ID embedded in raw_payload to a first-class column
-- with a partial unique index per contractor so the poller's lookup becomes
-- an O(1) index hit instead of a JSON LIKE-scan over every GLS lead.
-- Also applied at runtime by server/schema-drift.ts so existing production
-- databases pick this up without a separate migration step.
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "google_lead_id" varchar;

UPDATE "leads"
   SET "google_lead_id" = substring("raw_payload" FROM '"_gls_lead_id":"([^"]+)"')
 WHERE "source" = 'google_local_services'
   AND "google_lead_id" IS NULL
   AND "raw_payload" LIKE '%"_gls_lead_id":"%';

CREATE UNIQUE INDEX IF NOT EXISTS "leads_google_lead_id_unique_idx"
  ON "leads"("contractor_id", "google_lead_id")
  WHERE "google_lead_id" IS NOT NULL;
