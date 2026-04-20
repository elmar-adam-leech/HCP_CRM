-- Ensure pg_trgm extension is available (idempotent).
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- GIN trigram indexes for contact search.
-- These enable ILIKE '%term%' queries in getContactsPaginated/getContactsCount
-- to use index scans via pg_trgm instead of sequential scans.
-- The gin_trgm_ops operator class is required for GIN indexes on text columns.
CREATE INDEX IF NOT EXISTS contacts_name_trgm_idx ON contacts USING GIN (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS contacts_address_trgm_idx ON contacts USING GIN (address gin_trgm_ops);
CREATE INDEX IF NOT EXISTS contacts_source_trgm_idx ON contacts USING GIN (source gin_trgm_ops);
