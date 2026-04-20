-- Ensure pg_trgm extension is available for GIN trigram indexes on text columns.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
