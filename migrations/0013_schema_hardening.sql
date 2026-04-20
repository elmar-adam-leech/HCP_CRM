-- Schema hardening migration
--
-- PRECONDITIONS (run these checks in staging/prod before applying):
--
--   1. Duplicate calls check — migration will fail if duplicates exist:
--      SELECT contractor_id, external_call_id, COUNT(*) FROM calls
--        GROUP BY contractor_id, external_call_id HAVING COUNT(*) > 1;
--
--   2. Duplicate leads check — migration will fail if duplicates exist:
--      SELECT contractor_id, housecall_pro_lead_id, COUNT(*) FROM leads
--        WHERE housecall_pro_lead_id IS NOT NULL
--        GROUP BY contractor_id, housecall_pro_lead_id HAVING COUNT(*) > 1;
--
--   3. Malformed JSON in activities.metadata — will cause ::jsonb cast to fail:
--      SELECT id FROM activities WHERE metadata IS NOT NULL AND metadata !~ '^[\[{]';
--      (A non-empty result set means those rows need manual remediation before running.)
--
--   4. Malformed JSON in calls.metadata:
--      SELECT id FROM calls WHERE metadata IS NOT NULL AND metadata !~ '^[\[{]';
--
--   5. Non-canonical webhook service values — will cause enum cast to fail:
--      SELECT DISTINCT service FROM webhook_events WHERE LOWER(service) NOT IN
--        ('dialpad', 'housecall-pro', 'facebook', 'twilio');
--      SELECT DISTINCT service FROM webhooks WHERE LOWER(service) NOT IN
--        ('dialpad', 'housecall-pro', 'facebook', 'twilio');
--
--   6. Non-canonical webhook_type values — will cause enum cast to fail:
--      SELECT DISTINCT webhook_type FROM webhooks WHERE LOWER(webhook_type) NOT IN
--        ('sms', 'call', 'estimate', 'lead', 'job', 'customer', 'payment');
--
-- ROLLBACK NOTES:
--   - Unique indexes: DROP INDEX calls_external_call_id_unique_idx;
--                     DROP INDEX leads_housecall_pro_lead_id_unique_idx;
--   - JSONB columns: ALTER TABLE activities ALTER COLUMN metadata TYPE text
--                      USING CASE WHEN metadata IS NULL THEN NULL ELSE metadata::text END;
--                    ALTER TABLE calls ALTER COLUMN metadata TYPE text
--                      USING CASE WHEN metadata IS NULL THEN NULL ELSE metadata::text END;
--   - Column renames: ALTER TABLE contractor_credentials RENAME COLUMN contractor_id TO tenant_id;
--                     (same for contractor_providers, contractor_integrations)
--   - Enum rollback requires DROP TYPE after reverting columns back to varchar.

-- 1. Unique index on calls.external_call_id to prevent duplicate records during webhook race conditions
CREATE UNIQUE INDEX IF NOT EXISTS calls_external_call_id_unique_idx ON calls (contractor_id, external_call_id);

-- 2. Unique index on leads.housecall_pro_lead_id to prevent duplicate records during webhook race conditions
--    Partial index: only enforced when housecall_pro_lead_id IS NOT NULL (most rows have no HCP ID)
CREATE UNIQUE INDEX IF NOT EXISTS leads_housecall_pro_lead_id_unique_idx ON leads (contractor_id, housecall_pro_lead_id)
  WHERE housecall_pro_lead_id IS NOT NULL;

-- 3. Add index on scheduled_bookings.contact_id for fast contact detail page lookups
CREATE INDEX IF NOT EXISTS scheduled_bookings_contact_id_idx ON scheduled_bookings (contact_id);

-- 4. Migrate activities.metadata from text to jsonb
--    The USING clause is NULL-safe: NULL values pass through unchanged.
--    Fails if any non-NULL rows contain invalid JSON — run precondition check #3 first.
ALTER TABLE activities ALTER COLUMN metadata TYPE jsonb USING CASE WHEN metadata IS NULL THEN NULL ELSE metadata::jsonb END;

-- 5. Migrate calls.metadata from text to jsonb
--    Fails if any non-NULL rows contain invalid JSON — run precondition check #4 first.
ALTER TABLE calls ALTER COLUMN metadata TYPE jsonb USING CASE WHEN metadata IS NULL THEN NULL ELSE metadata::jsonb END;

-- 6. Rename tenant_id to contractor_id in contractor_credentials
--    Column was named tenant_id in the DB but exposed as contractorId in Drizzle — now aligned.
ALTER TABLE contractor_credentials RENAME COLUMN tenant_id TO contractor_id;

-- 7. Rename tenant_id to contractor_id in contractor_providers
ALTER TABLE contractor_providers RENAME COLUMN tenant_id TO contractor_id;

-- 8. Rename tenant_id to contractor_id in contractor_integrations
ALTER TABLE contractor_integrations RENAME COLUMN tenant_id TO contractor_id;

-- 9. Create enum types for webhook service names and event types
--    Run precondition checks #5 and #6 before this block.
CREATE TYPE webhook_service AS ENUM ('dialpad', 'housecall-pro', 'facebook', 'twilio');
CREATE TYPE webhook_event_type AS ENUM ('sms', 'call', 'estimate', 'lead', 'job', 'customer', 'payment');

-- 10. Normalise webhook_events.service to lowercase, then cast to enum
UPDATE webhook_events SET service = LOWER(service) WHERE service IS NOT NULL;
ALTER TABLE webhook_events ALTER COLUMN service TYPE webhook_service USING service::webhook_service;

-- 11. Normalise webhooks.service to lowercase, then cast to enum
UPDATE webhooks SET service = LOWER(service) WHERE service IS NOT NULL;
ALTER TABLE webhooks ALTER COLUMN service TYPE webhook_service USING service::webhook_service;

-- 12. Normalise webhooks.webhook_type to lowercase, then cast to enum
UPDATE webhooks SET webhook_type = LOWER(webhook_type) WHERE webhook_type IS NOT NULL;
ALTER TABLE webhooks ALTER COLUMN webhook_type TYPE webhook_event_type USING webhook_type::webhook_event_type;
