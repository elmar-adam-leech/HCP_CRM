import { and, eq, gte, isNotNull } from 'drizzle-orm';
import { db } from '../db';
import { scheduledBookings, users, contractors } from '@shared/schema';
import { googleCalendarService, GoogleCalendarAuthError } from '../google-calendar-service';
import { invalidateAndRecompute, utcToLocalDateStr } from '../services/availability-cache';
import { getAvailabilityForDate } from '../scheduling/availability';
import { logger } from '../utils/logger';

const log = logger('GoogleCalendarReconcile');

// Only reconcile bookings whose start time is recent-or-future. A rep who
// reschedules a past appointment to a future slot is covered by the lookback
// window; there is no value in polling Google for long-past bookings, and the
// window bounds the work per pass.
const LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

export interface ReconcileSummary {
  checked: number;
  rescheduled: number;
  cancelled: number;
  errors: number;
}

/**
 * Reverse-sync scheduled bookings against Google Calendar (task #862).
 *
 * The booking write path creates a Google Calendar event and stores its id on
 * `scheduled_bookings.google_calendar_event_id`, but nothing closed the loop
 * when a rep edited or deleted that event directly in Google Calendar. This
 * pass correlates each active booking to its linked event via the stored id and:
 *   - marks the booking `cancelled` when the event was deleted or cancelled, and
 *   - updates the booking `startTime`/`endTime` when the event was moved.
 *
 * Each affected date has its availability cache invalidated + recomputed so
 * freed/moved slots surface to other customers immediately, mirroring the
 * booking-create and cancelBooking paths.
 */
export async function reconcileGoogleCalendarBookings(): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = { checked: 0, rescheduled: 0, cancelled: 0, errors: 0 };
  const windowStart = new Date(Date.now() - LOOKBACK_MS);

  const rows = await db.select({
    id: scheduledBookings.id,
    contractorId: scheduledBookings.contractorId,
    salespersonId: scheduledBookings.assignedSalespersonId,
    eventId: scheduledBookings.googleCalendarEventId,
    startTime: scheduledBookings.startTime,
    endTime: scheduledBookings.endTime,
    refreshToken: users.googleCalendarRefreshToken,
  })
    .from(scheduledBookings)
    .innerJoin(users, eq(users.id, scheduledBookings.assignedSalespersonId))
    .where(and(
      isNotNull(scheduledBookings.googleCalendarEventId),
      eq(scheduledBookings.status, 'confirmed'),
      eq(users.googleCalendarConnected, true),
      gte(scheduledBookings.startTime, windowStart),
    ));

  if (rows.length === 0) {
    return summary;
  }

  // Cache contractor timezones for the run so a busy pass doesn't re-query the
  // same contractor row for every one of its bookings.
  const timezoneCache = new Map<string, string>();
  const getTimezone = async (contractorId: string): Promise<string> => {
    const cached = timezoneCache.get(contractorId);
    if (cached) return cached;
    const [cRow] = await db.select({ timezone: contractors.timezone })
      .from(contractors)
      .where(eq(contractors.id, contractorId))
      .limit(1);
    const tz = cRow?.timezone || 'America/New_York';
    timezoneCache.set(contractorId, tz);
    return tz;
  };

  // Once a rep's token is proven dead we skip their remaining bookings this
  // pass instead of hammering Google with calls that will all fail.
  const disconnectedSalespeople = new Set<string>();

  for (const row of rows) {
    if (!row.eventId || !row.refreshToken) continue;
    if (disconnectedSalespeople.has(row.salespersonId)) continue;

    let state: Awaited<ReturnType<typeof googleCalendarService.getEvent>>;
    try {
      state = await googleCalendarService.getEvent(row.refreshToken, row.eventId);
    } catch (err) {
      if (err instanceof GoogleCalendarAuthError) {
        disconnectedSalespeople.add(row.salespersonId);
        try {
          await db.update(users)
            .set({ googleCalendarConnected: false })
            .where(eq(users.id, row.salespersonId));
          log.warn(`Marked salesperson ${row.salespersonId} disconnected — Google Calendar token rejected`);
        } catch (updateErr) {
          log.error('Failed to flag Google Calendar as disconnected:', updateErr);
        }
        continue;
      }
      // Transient error — leave the booking untouched and retry next pass.
      summary.errors++;
      log.warn(`Failed to fetch Google event ${row.eventId} for booking ${row.id} (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    summary.checked++;

    if (state.status === 'deleted' || state.status === 'cancelled') {
      await db.update(scheduledBookings)
        .set({ status: 'cancelled' as const, updatedAt: new Date() })
        .where(eq(scheduledBookings.id, row.id));
      summary.cancelled++;
      log.info(`Booking ${row.id} cancelled — Google event ${row.eventId} was ${state.status}`);

      const tz = await getTimezone(row.contractorId);
      invalidateAndRecompute(row.contractorId, tz, getAvailabilityForDate, [
        utcToLocalDateStr(row.startTime, tz),
      ]);
      continue;
    }

    // Live event — reflect any time change back onto the booking.
    const newStart = state.startTime;
    const newEnd = state.endTime;
    if (!newStart || !newEnd) {
      // All-day / date-only event — nothing timed to sync.
      continue;
    }

    const startChanged = newStart.getTime() !== row.startTime.getTime();
    const endChanged = newEnd.getTime() !== row.endTime.getTime();
    if (!startChanged && !endChanged) {
      continue;
    }

    await db.update(scheduledBookings)
      .set({ startTime: newStart, endTime: newEnd, updatedAt: new Date() })
      .where(eq(scheduledBookings.id, row.id));
    summary.rescheduled++;
    log.info(`Booking ${row.id} rescheduled from ${row.startTime.toISOString()} to ${newStart.toISOString()} (Google event ${row.eventId})`);

    const tz = await getTimezone(row.contractorId);
    const affectedDates = Array.from(new Set([
      utcToLocalDateStr(row.startTime, tz),
      utcToLocalDateStr(newStart, tz),
    ]));
    invalidateAndRecompute(row.contractorId, tz, getAvailabilityForDate, affectedDates);
  }

  if (summary.checked > 0 || summary.errors > 0) {
    log.info(`Reconcile pass complete: checked=${summary.checked} rescheduled=${summary.rescheduled} cancelled=${summary.cancelled} errors=${summary.errors}`);
  }
  return summary;
}
