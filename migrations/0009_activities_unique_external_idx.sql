CREATE UNIQUE INDEX IF NOT EXISTS "activities_unique_external_idx" ON "activities" ("contractor_id", "external_source", "external_id") WHERE external_id IS NOT NULL;
