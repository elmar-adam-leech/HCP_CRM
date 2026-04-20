-- Migration 0015: Fix integration table column names
-- Migration 0013 renamed tenant_id -> contractor_id in production.
-- Local dev databases that ran an older version of 0013 may still have tenant_id.
-- These DO blocks are safe no-ops if the column is already named contractor_id.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'contractor_credentials' AND column_name = 'tenant_id'
  ) THEN
    ALTER TABLE contractor_credentials RENAME COLUMN tenant_id TO contractor_id;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'contractor_providers' AND column_name = 'tenant_id'
  ) THEN
    ALTER TABLE contractor_providers RENAME COLUMN tenant_id TO contractor_id;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'contractor_integrations' AND column_name = 'tenant_id'
  ) THEN
    ALTER TABLE contractor_integrations RENAME COLUMN tenant_id TO contractor_id;
  END IF;
END $$;
