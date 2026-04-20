CREATE UNIQUE INDEX IF NOT EXISTS "estimates_unique_external_idx" ON "estimates" ("contractor_id", "external_source", "external_id") WHERE external_id IS NOT NULL AND external_source IS NOT NULL;
