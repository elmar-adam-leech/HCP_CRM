-- Task #698: backfill scheduled_bookings.source for historical public-link
-- bookings that ended up at the default 'in_app_booking' value.
--
-- Two recovery paths, both idempotent and re-runnable:
--   1. The raw request body persisted in `booking_payload` includes the
--      booker-supplied `source`. If that JSON value is 'public_booking', the
--      booking definitely came from the public widget and the row's source
--      column should reflect that.
--   2. The `markContactScheduled` helper writes a `status_change` activity
--      tagged with `external_source = 'public_booking'` for every public
--      booking. If such an activity exists for the same contact within
--      ±5 minutes of the booking's `created_at`, we can safely re-tag the
--      booking row even when its raw payload has been pruned.
--
-- The `WHERE source <> 'public_booking'` guard on every UPDATE keeps this a
-- no-op on rows that already carry the correct source, so re-applying this
-- migration (e.g. via the schema-drift boot loop) is safe.
--
-- The 5-minute window matches the activity-correlation rule in the task spec
-- and is intentionally narrower than the existing schema-drift backfill
-- (±10 minutes from task #694) — public bookings always insert the
-- status_change activity in the same request as the scheduled_bookings row,
-- so the gap is sub-second in practice.
--
-- This statement is mirrored in `server/schema-drift.ts` `columnMigrations`
-- so existing tenants that bypass `drizzle-kit push` (the documented norm
-- for this codebase) also receive the backfill at boot.

UPDATE scheduled_bookings sb
   SET source = 'public_booking'
 WHERE sb.source <> 'public_booking'
   AND sb.booking_payload IS NOT NULL
   AND sb.booking_payload->>'source' = 'public_booking';

UPDATE scheduled_bookings sb
   SET source = 'public_booking'
 WHERE sb.source <> 'public_booking'
   AND sb.contact_id IS NOT NULL
   AND EXISTS (
     SELECT 1
       FROM activities a
      WHERE a.contact_id = sb.contact_id
        AND a.contractor_id = sb.contractor_id
        AND a.type IN ('meeting', 'status_change')
        AND a.external_source = 'public_booking'
        AND a.created_at BETWEEN sb.created_at - interval '5 minutes'
                             AND sb.created_at + interval '5 minutes'
   );
