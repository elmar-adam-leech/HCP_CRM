-- IMPORTANT: This migration MUST only be run after the application startup
-- migration (migrateDialpadWebhookApiKeys in server/index.ts) has successfully
-- copied all contractors.webhook_api_key values into contractor_credentials
-- (CredentialService encrypted storage). Running this migration independently
-- before app startup will cause plaintext keys to be lost.
--
-- In normal operation, the app startup migration drops this column automatically
-- after a successful data migration. This file exists for documentation and for
-- environments that apply Drizzle migration files explicitly.
ALTER TABLE contractors DROP COLUMN IF EXISTS webhook_api_key;
