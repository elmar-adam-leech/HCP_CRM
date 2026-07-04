import { db } from '../db';
import { scheduledBookings, contractors, estimates, hcpCalendarEvents, users } from '@shared/schema';
import { eq, ne, and, gte, lte, isNotNull } from 'drizzle-orm';
import type { BusyWindow, AvailableSlot, SalespersonInfo, CalendarEvent } from '../types/scheduling';
import {
  parseWorkingHours as parseWorkingHoursUtil,
  createDateInTimezone as createDateInTimezoneUtil,
  getDayOfWeekInTimezone as getDayOfWeekInTimezoneUtil,
} from '../utils/time';
import { logger } from '../utils/logger';
import { getSalespeople, getBookings } from './queries';
import { getCachedAvailability, setCachedAvailability, coalesceAvailabilityRequest } from '../services/availability-cache';
import { googleCalendarService, GoogleCalendarAuthError } from '../google-calendar-service';

const log = logger('SchedulingService');

/**
 * Default duration of each bookable slot in minutes. Tenant-configurable via
 * contractors.appointment_duration_minutes (task #858); this is the fallback
 * used when the column is unset.
 */
const SLOT_DURATION_MINUTES = 60;

/**
 * Granularity at which slots are offered to customers (every N minutes).
 * Lower values give more booking options but increase slot-generation work.
 * Must be ≤ SLOT_DURATION_MINUTES.
 */
const SLOT_INTERVAL_MINUTES = 15;

/**
 * Default buffer applied before and after each busy window when checking
 * availability. Prevents back-to-back appointments with no travel / prep time.
 * Tenant-configurable via contractors.appointment_buffer_minutes (task #858);
 * this is the fallback used when the column is unset.
 */
export const BUFFER_MINUTES = 30;

/**
 * Read a tenant's configurable appointment length + buffer (task #858).
 * Falls back to the historical constants when the columns are unset.
 */
export async function getAppointmentSettings(
  tenantId: string,
): Promise<{ durationMinutes: number; bufferMinutes: number }> {
  const [row] = await db.select({
    duration: contractors.appointmentDurationMinutes,
    buffer: contractors.appointmentBufferMinutes,
  })
    .from(contractors)
    .where(eq(contractors.id, tenantId))
    .limit(1);
  return {
    durationMinutes: row?.duration ?? SLOT_DURATION_MINUTES,
    bufferMinutes: row?.buffer ?? BUFFER_MINUTES,
  };
}

/**
 * Arrival window communicated to HCP when scheduling an estimate option.
 * A 60-minute window tells the customer the salesperson may arrive any time
 * within a one-hour band starting at the slot start time.
 */
export const ARRIVAL_WINDOW_MINUTES = 60;

/** Milliseconds in one day — used to advance the loop cursor by one calendar day. */
const DAY_MS = 24 * 60 * 60 * 1000;

export function parseWorkingHours(timeStr: string) { return parseWorkingHoursUtil(timeStr); }
export function createDateInTimezone(date: Date, hours: number, minutes: number, timezone: string) { return createDateInTimezoneUtil(date, hours, minutes, timezone); }
export function getDayOfWeekInTimezone(date: Date, timezone: string) { return getDayOfWeekInTimezoneUtil(date, timezone); }

/**
 * Expands a busy window by BUFFER_MINUTES on both start and end.
 * This ensures a 30-min separation before AND after any busy period.
 */
export function expandBusyWindowWithBuffer(
  start: Date | string,
  end: Date | string,
  bufferMinutes: number = BUFFER_MINUTES,
): BusyWindow {
  const startTime = new Date(start);
  const endTime = new Date(end);

  return {
    start: new Date(startTime.getTime() - bufferMinutes * 60 * 1000).toISOString(),
    end: new Date(endTime.getTime() + bufferMinutes * 60 * 1000).toISOString(),
  };
}

/**
 * Fetch a salesperson's busy windows from their connected Google Calendar
 * (task #858). Returns raw (unbuffered) windows in the same shape as
 * getBusyWindowsFromDb.
 *
 * Failure handling is deliberately non-fatal so a Google outage or a single
 * revoked token never blocks booking against local/HCP availability:
 *   - Revoked/expired token  → mark the user disconnected + return [].
 *   - Any other (transient)  → log + return []. The salesperson keeps their
 *                              local availability rather than being excluded.
 */
async function getGoogleBusyWindows(
  sp: SalespersonInfo,
  startDate: Date,
  endDate: Date,
): Promise<BusyWindow[]> {
  if (!sp.googleCalendarConnected || !sp.googleCalendarRefreshToken) {
    return [];
  }
  try {
    const windows = await googleCalendarService.getBusyWindows(
      sp.googleCalendarRefreshToken,
      startDate,
      endDate,
    );
    return windows.map(w => ({ start: w.start.toISOString(), end: w.end.toISOString() }));
  } catch (err) {
    if (err instanceof GoogleCalendarAuthError) {
      log.warn(`[scheduling] Google Calendar token invalid for ${sp.name} — marking disconnected so the UI prompts a reconnect`);
      try {
        await db.update(users)
          .set({ googleCalendarConnected: false })
          .where(eq(users.id, sp.userId));
        const { invalidateUserCache } = await import('../services/cache');
        invalidateUserCache(sp.userId);
      } catch (updateErr) {
        log.error('[scheduling] Failed to flag Google Calendar as disconnected:', updateErr);
      }
      return [];
    }
    log.error(`[scheduling] Google Calendar busy-window fetch failed for ${sp.name} (non-fatal, skipping Google source):`, err instanceof Error ? err.message : err);
    return [];
  }
}

export function isSlotBusy(slotStart: Date, slotEnd: Date, busyWindows: BusyWindow[]): boolean {
  for (const busy of busyWindows) {
    const busyStart = new Date(busy.start);
    const busyEnd = new Date(busy.end);

    if (slotStart < busyEnd && slotEnd > busyStart) {
      return true;
    }
  }
  return false;
}

/**
 * Build busy windows for a salesperson from local DB sources only.
 *
 * Three sources (all queried locally — no live HCP API calls):
 *   1. `estimates`           — HCP estimates synced via webhooks + daily poll
 *   2. `hcp_calendar_events` — manual blocks/PTO entered directly in HCP (synced daily)
 *   3. `scheduled_bookings`  — appointments made through our platform
 *
 * Returns an array of raw (unbuffered) BusyWindow objects; callers apply
 * expandBusyWindowWithBuffer() as needed.
 */
async function getBusyWindowsFromDb(
  tenantId: string,
  hcpEmployeeId: string | null,
  userId: string,
  expandedStart: Date,
  expandedEnd: Date,
): Promise<BusyWindow[]> {
  const busyWindows: BusyWindow[] = [];

  // 1. Estimates — filtered by scheduledEmployeeId (the HCP employee ID stored on the estimate).
  //    Only include estimates that have both start and end times to avoid open-ended busy periods.
  if (hcpEmployeeId) {
    const scheduledEstimates = await db.select({
      scheduledStart: estimates.scheduledStart,
      scheduledEnd: estimates.scheduledEnd,
    })
    .from(estimates)
    .where(and(
      eq(estimates.contractorId, tenantId),
      eq(estimates.scheduledEmployeeId, hcpEmployeeId),
      isNotNull(estimates.scheduledStart),
      isNotNull(estimates.scheduledEnd),
      lte(estimates.scheduledStart, expandedEnd),
      gte(estimates.scheduledEnd, expandedStart),
    ));

    for (const est of scheduledEstimates) {
      if (est.scheduledStart && est.scheduledEnd) {
        busyWindows.push({ start: est.scheduledStart.toISOString(), end: est.scheduledEnd.toISOString() });
      }
    }

    // 2. HCP calendar events (manual time blocks, PTO, etc.) — synced daily.
    const calendarEvts = await db.select({
      startTime: hcpCalendarEvents.startTime,
      endTime: hcpCalendarEvents.endTime,
    })
    .from(hcpCalendarEvents)
    .where(and(
      eq(hcpCalendarEvents.contractorId, tenantId),
      eq(hcpCalendarEvents.hcpEmployeeId, hcpEmployeeId),
      lte(hcpCalendarEvents.startTime, expandedEnd),
      gte(hcpCalendarEvents.endTime, expandedStart),
    ));

    for (const evt of calendarEvts) {
      busyWindows.push({ start: evt.startTime.toISOString(), end: evt.endTime.toISOString() });
    }
  }

  // 3. Local bookings (always by userId, not hcpEmployeeId).
  const bookings = await db.select({
    startTime: scheduledBookings.startTime,
    endTime: scheduledBookings.endTime,
  })
  .from(scheduledBookings)
  .where(and(
    eq(scheduledBookings.assignedSalespersonId, userId),
    eq(scheduledBookings.contractorId, tenantId),
    ne(scheduledBookings.status, 'cancelled'),
    lte(scheduledBookings.startTime, expandedEnd),
    gte(scheduledBookings.endTime, expandedStart),
  ));

  for (const b of bookings) {
    busyWindows.push({ start: b.startTime.toISOString(), end: b.endTime.toISOString() });
  }

  return busyWindows;
}

/**
 * Return available slots for a specific calendar date (YYYY-MM-DD) in the
 * contractor's timezone.  Uses noon of that TZ day as the iteration anchor
 * so UTC-midnight boundaries never cause the wrong day to be processed.
 *
 * Results are cached in memory with a configurable TTL (default 1 hour).
 * The cache is invalidated by webhook events and local booking mutations.
 */
export async function getAvailabilityForDate(
  tenantId: string,
  dateStr: string,
  timezone: string = 'America/New_York'
): Promise<AvailableSlot[]> {
  const cached = getCachedAvailability(tenantId, dateStr);
  if (cached !== null) {
    log.info(`[scheduling] Cache hit for tenant=${tenantId} date=${dateStr} (${cached.length} slots)`);
    return cached;
  }

  // Coalesce concurrent cold-cache requests for the same tenant+date so only
  // one DB computation runs even when multiple requests arrive simultaneously.
  return coalesceAvailabilityRequest(tenantId, dateStr, async () => {
    // Re-check the cache inside the coalesced computation: a previous in-flight
    // request for the same key may have already populated it while we waited.
    const cachedInner = getCachedAvailability(tenantId, dateStr);
    if (cachedInner !== null) {
      return cachedInner;
    }

    // Parse the YYYY-MM-DD string into year/month/day components
    const [year, month, day] = dateStr.split('-').map(Number);
    // month is 1-indexed from split; Date.UTC expects 0-indexed
    const noonAnchor = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));

    // dayStart = 00:00 on that calendar date in the contractor's TZ
    const dayStart = createDateInTimezone(noonAnchor, 0, 0, timezone);
    // dayEnd   = 00:00 the NEXT calendar date in the contractor's TZ
    const nextNoonAnchor = new Date(Date.UTC(year, month - 1, day + 1, 12, 0, 0));
    const dayEnd = createDateInTimezone(nextNoonAnchor, 0, 0, timezone);

    const slots = await getUnifiedAvailability(tenantId, dayStart, dayEnd, timezone);

    setCachedAvailability(tenantId, dateStr, slots);
    log.info(`[scheduling] Cache miss — computed and stored tenant=${tenantId} date=${dateStr} (${slots.length} slots)`);

    return slots;
  });
}

/**
 * A single candidate appointment time for the INTERNAL scheduling modal
 * (task #859). Unlike getUnifiedAvailability — which only returns free gaps —
 * this returns EVERY candidate start time across the salesperson's working
 * window and flags the ones that overlap an existing appointment so the UI can
 * render a soft "Booked" badge while still allowing the staff member to pick
 * that time (intentional double-booking is permitted internally).
 */
export interface DaySlotCandidate {
  start: Date;
  end: Date;
  /** True when this candidate overlaps an existing appointment for the salesperson. */
  conflict: boolean;
}

/**
 * Return every candidate appointment start time for a single salesperson on a
 * given calendar date (YYYY-MM-DD) in the contractor's timezone, each flagged
 * with whether it conflicts with an existing appointment.
 *
 * This powers the internal "flexible scheduling" experience (task #859): staff
 * can pick ANY time in the working window, and conflicting times are surfaced
 * with an inline badge rather than hidden.
 *
 * The conflict flag is computed against RAW (unbuffered) busy windows so the
 * badge means "something is actually booked here", not merely "inside the
 * travel-time buffer". Not cached — the internal modal is low-volume and needs
 * conflict info the public availability cache does not carry.
 */
export async function getSalespersonDaySlots(
  tenantId: string,
  dateStr: string,
  salespersonId: string,
  timezone: string = 'America/New_York',
): Promise<{ slots: DaySlotCandidate[]; durationMinutes: number; bufferMinutes: number }> {
  const { durationMinutes, bufferMinutes } = await getAppointmentSettings(tenantId);

  const salespeople = await getSalespeople(tenantId);
  const sp = salespeople.find(s => s.userId === salespersonId);
  if (!sp) {
    return { slots: [], durationMinutes, bufferMinutes };
  }

  const [year, month, day] = dateStr.split('-').map(Number);
  const noonAnchor = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));

  // Task #889: the INTERNAL calendar lets reps book ANY time after now — not
  // just within the salesperson's configured working days/hours. Generate
  // candidate start times across the WHOLE calendar day (00:00 → 24:00 in the
  // contractor's timezone) and filter to times at or after the current moment
  // below. Working-day / working-hour restrictions are deliberately NOT applied
  // here; they remain in force only on the public availability path.
  const dayStart = createDateInTimezone(noonAnchor, 0, 0, timezone);
  const nextNoonAnchor = new Date(Date.UTC(year, month - 1, day + 1, 12, 0, 0));
  const dayEnd = createDateInTimezone(nextNoonAnchor, 0, 0, timezone);

  // Widen the busy-window query so appointments starting just before the day
  // (whose buffer/tail could overlap early slots) are still fetched.
  const queryStart = new Date(dayStart.getTime() - bufferMinutes * 60 * 1000);
  const queryEnd = new Date(dayEnd.getTime() + bufferMinutes * 60 * 1000);

  const dbWindows = await getBusyWindowsFromDb(
    tenantId,
    sp.housecallProUserId ?? null,
    sp.userId,
    queryStart,
    queryEnd,
  );
  const googleWindows = await getGoogleBusyWindows(sp, queryStart, queryEnd);
  // RAW (unbuffered) windows — the "Booked" badge reflects an actual overlap.
  const busyWindows: BusyWindow[] = [...dbWindows, ...googleWindows];

  const now = new Date();
  const slots: DaySlotCandidate[] = [];
  let slotStart = new Date(dayStart);

  while (slotStart.getTime() + durationMinutes * 60 * 1000 <= dayEnd.getTime()) {
    const slotEnd = new Date(slotStart.getTime() + durationMinutes * 60 * 1000);

    // Don't offer times that have already started today.
    if (slotStart >= now) {
      slots.push({
        start: new Date(slotStart),
        end: slotEnd,
        conflict: isSlotBusy(slotStart, slotEnd, busyWindows),
      });
    }

    slotStart = new Date(slotStart.getTime() + SLOT_INTERVAL_MINUTES * 60 * 1000);
  }

  return { slots, durationMinutes, bufferMinutes };
}

export async function getUnifiedAvailability(
  tenantId: string,
  startDate: Date,
  endDate: Date,
  timezone: string = 'America/New_York'
): Promise<AvailableSlot[]> {
  const salespeople = await getSalespeople(tenantId);

  if (!salespeople.length) {
    log.info('[scheduling] No salespeople found for tenant:', tenantId);
    return [];
  }

  log.info(`[scheduling] Found ${salespeople.length} salespeople for availability calculation. Timezone: ${timezone}`);

  const { durationMinutes, bufferMinutes } = await getAppointmentSettings(tenantId);

  const salespersonBusyWindows = new Map<string, BusyWindow[]>();

  const expandedStart = new Date(startDate.getTime() - bufferMinutes * 60 * 1000);
  const expandedEnd = new Date(endDate.getTime() + bufferMinutes * 60 * 1000);

  // Query local DB sources + each connected Google Calendar concurrently —
  // one promise per salesperson. HCP data comes from the local DB (synced);
  // Google busy times are fetched live but fail soft (see getGoogleBusyWindows).
  const busyWindowResults = await Promise.all(
    salespeople.map(async sp => {
      const dbWindows = await getBusyWindowsFromDb(
        tenantId,
        sp.housecallProUserId ?? null,
        sp.userId,
        expandedStart,
        expandedEnd,
      ).catch(err => {
        log.error(`[scheduling] DB busy-window query failed for ${sp.name}, treating as unavailable:`, err);
        return null;
      });
      // A DB failure means we cannot trust this salesperson's availability at
      // all, so bail out (they'll be excluded). Google is additive and never
      // makes someone "more available", so its failure is non-fatal.
      if (dbWindows === null) return null;
      const googleWindows = await getGoogleBusyWindows(sp, expandedStart, expandedEnd);
      return [...dbWindows, ...googleWindows];
    })
  );

  for (let i = 0; i < salespeople.length; i++) {
    const sp = salespeople[i];
    const rawBusyWindows = busyWindowResults[i];

    if (rawBusyWindows === null) {
      // DB query failed — treat this salesperson as fully booked for the
      // entire requested range so they don't appear in available slots.
      log.info(`[scheduling] ${sp.name} excluded from availability (DB query error)`);
      salespersonBusyWindows.set(sp.userId, [{ start: startDate.toISOString(), end: endDate.toISOString() }]);
      continue;
    }

    const allBusyWindows = rawBusyWindows.map(bw => expandBusyWindowWithBuffer(bw.start, bw.end, bufferMinutes));

    salespersonBusyWindows.set(sp.userId, allBusyWindows);
    log.info(`[scheduling] Salesperson ${sp.name}: workingDays=${JSON.stringify(sp.workingDays)}, hours=${sp.workingHoursStart}-${sp.workingHoursEnd}, busyWindows=${allBusyWindows.length}`);
  }

  // Map<slotStartMs, AvailableSlot> for O(1) deduplication across salespeople.
  const slotMap = new Map<number, AvailableSlot>();
  const currentDate = new Date(startDate);

  // Compute "now" once before the outer loop so we're not constructing a new
  // Date object on every slot iteration (which can be thousands per request).
  const now = new Date();

  while (currentDate < endDate) {
    const dayOfWeek = getDayOfWeekInTimezone(currentDate, timezone);

    for (const sp of salespeople) {
      if (!sp.workingDays.includes(dayOfWeek)) {
        continue;
      }

      const workStart = parseWorkingHours(sp.workingHoursStart || "08:00");
      const workEnd = parseWorkingHours(sp.workingHoursEnd || "17:00");

      const dayStart = createDateInTimezone(currentDate, workStart.hours, workStart.minutes, timezone);
      const dayEnd = createDateInTimezone(currentDate, workEnd.hours, workEnd.minutes, timezone);

      // Sliding-window slot search for this salesperson on this day.
      //
      // We step through the working day in SLOT_INTERVAL_MINUTES increments (15 min),
      // testing candidate windows of SLOT_DURATION_MINUTES (60 min) each.
      // A slot is "available" when the salesperson has no overlapping busy windows
      // (local estimates + HCP calendar events + existing local bookings,
      //  pre-computed in salespersonBusyWindows).
      //
      // If another salesperson already opened the same time slot, we append this one's
      // ID to the existing map entry rather than creating a duplicate entry.
      let slotStart = new Date(dayStart);

      while (slotStart.getTime() + durationMinutes * 60 * 1000 <= dayEnd.getTime()) {
        const slotEnd = new Date(slotStart.getTime() + durationMinutes * 60 * 1000);

        // Skip slots that have already started (can't book in the past)
        if (slotStart < now) {
          slotStart = new Date(slotStart.getTime() + SLOT_INTERVAL_MINUTES * 60 * 1000);
          continue;
        }

        const busyWindows = salespersonBusyWindows.get(sp.userId) || [];
        const isAvailable = !isSlotBusy(slotStart, slotEnd, busyWindows);

        if (isAvailable) {
          const slotKey = slotStart.getTime();
          const existingSlot = slotMap.get(slotKey);

          if (existingSlot) {
            if (!existingSlot.availableSalespersonIds.includes(sp.userId)) {
              existingSlot.availableSalespersonIds.push(sp.userId);
            }
          } else {
            const newSlot: AvailableSlot = {
              start: new Date(slotStart),
              end: new Date(slotEnd),
              availableSalespersonIds: [sp.userId],
            };
            slotMap.set(slotKey, newSlot);
          }
        }

        slotStart = new Date(slotStart.getTime() + SLOT_INTERVAL_MINUTES * 60 * 1000);
      }
    }

    currentDate.setTime(currentDate.getTime() + DAY_MS);
  }

  const availableSlots: AvailableSlot[] = Array.from(slotMap.values());

  availableSlots.sort((a, b) => a.start.getTime() - b.start.getTime());

  log.info(`[scheduling] Generated ${availableSlots.length} available slots`);
  return availableSlots;
}

/**
 * Build the read-only unified day schedule (task #861): CRM-native bookings
 * merged with each connected salesperson's Google Calendar busy blocks so reps
 * can see external commitments (theirs and teammates') alongside CRM
 * appointments and spot double-booking at a glance.
 *
 * Guarantees:
 *   - Respects per-user connection status — reps who haven't connected Google
 *     contribute only their CRM bookings (no Google source).
 *   - Google fetch is fail-soft (see getGoogleBusyWindows) so an outage or a
 *     single revoked token never blocks the CRM data.
 *   - Google busy blocks that fall entirely inside a CRM booking for the same
 *     salesperson are suppressed to avoid showing the same appointment twice
 *     (task #858 mirrors CRM bookings into Google, which would otherwise echo).
 */
export async function getCalendarEvents(
  tenantId: string,
  startDate: Date,
  endDate: Date,
  salespersonId?: string,
): Promise<CalendarEvent[]> {
  const events: CalendarEvent[] = [];

  // 1. CRM-native bookings (exclude cancelled).
  const bookings = await getBookings(tenantId, startDate, endDate);
  const crmBySalesperson = new Map<string, { start: number; end: number }[]>();
  for (const b of bookings) {
    if (salespersonId && b.salespersonId !== salespersonId) continue;
    if (b.status === 'cancelled') continue;
    events.push({
      source: 'crm',
      id: b.id,
      title: b.title || b.customerName || 'Appointment',
      start: b.startTime.toISOString(),
      end: b.endTime.toISOString(),
      salespersonId: b.salespersonId,
      salespersonName: b.salespersonName,
      status: b.status,
      customerName: b.customerName,
    });
    const list = crmBySalesperson.get(b.salespersonId) ?? [];
    list.push({ start: b.startTime.getTime(), end: b.endTime.getTime() });
    crmBySalesperson.set(b.salespersonId, list);
  }

  // 2. External Google Calendar busy blocks for connected salespeople only.
  let salespeople = await getSalespeople(tenantId);
  if (salespersonId) salespeople = salespeople.filter(sp => sp.userId === salespersonId);
  const connected = salespeople.filter(sp => sp.googleCalendarConnected && sp.googleCalendarRefreshToken);

  const googleResults = await Promise.all(
    connected.map(async sp => {
      const windows = await getGoogleBusyWindows(sp, startDate, endDate);
      const crmWindows = crmBySalesperson.get(sp.userId) ?? [];
      return windows
        .filter(w => {
          const gStart = new Date(w.start).getTime();
          const gEnd = new Date(w.end).getTime();
          // Suppress Google echoes of CRM bookings (busy block fully covered
          // by a CRM appointment for the same salesperson).
          return !crmWindows.some(c => gStart >= c.start && gEnd <= c.end);
        })
        .map((w, idx): CalendarEvent => ({
          source: 'google',
          id: `google-${sp.userId}-${idx}-${w.start}`,
          title: 'Busy',
          start: w.start,
          end: w.end,
          salespersonId: sp.userId,
          salespersonName: sp.name,
        }));
    })
  );
  for (const list of googleResults) events.push(...list);

  events.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
  return events;
}

export async function selectNextAvailableSalesperson(
  tenantId: string,
  startTime: Date,
  timezoneParam?: string
): Promise<SalespersonInfo | null> {
  const { durationMinutes, bufferMinutes } = await getAppointmentSettings(tenantId);
  const endTime = new Date(startTime.getTime() + durationMinutes * 60 * 1000);

  // Get the contractor's timezone if not provided
  let timezone = timezoneParam;
  if (!timezone) {
    const [contractor] = await db.select({ timezone: contractors.timezone })
      .from(contractors)
      .where(eq(contractors.id, tenantId))
      .limit(1);
    timezone = contractor?.timezone || 'America/New_York';
  }

  // Expand search window to include buffer periods for accurate conflict detection
  const searchStart = new Date(startTime.getTime() - bufferMinutes * 60 * 1000);
  const searchEnd = new Date(endTime.getTime() + bufferMinutes * 60 * 1000);

  const salespeople = await getSalespeople(tenantId);

  if (!salespeople.length) {
    return null;
  }

  // Get day of week for the requested time in the correct timezone
  const dayOfWeek = getDayOfWeekInTimezone(startTime, timezone);

  // Filter to salespeople whose schedule could cover this slot before firing DB queries.
  const candidateSalespeople = salespeople.filter(sp => {
    if (!sp.workingDays.includes(dayOfWeek)) {
      log.info(`[scheduling] Skipping ${sp.name}: not working on day ${dayOfWeek} (works: ${JSON.stringify(sp.workingDays)})`);
      return false;
    }
    const workStart = parseWorkingHours(sp.workingHoursStart || "08:00");
    const workEnd = parseWorkingHours(sp.workingHoursEnd || "17:00");
    const dayWorkStart = createDateInTimezone(startTime, workStart.hours, workStart.minutes, timezone!);
    const dayWorkEnd = createDateInTimezone(startTime, workEnd.hours, workEnd.minutes, timezone!);
    if (startTime < dayWorkStart || endTime > dayWorkEnd) {
      log.info(`[scheduling] Skipping ${sp.name}: slot outside working hours (${sp.workingHoursStart}-${sp.workingHoursEnd})`);
      return false;
    }
    return true;
  });

  // Query local DB + connected Google Calendars concurrently. HCP data is
  // local (synced); Google busy times are fetched live but fail soft.
  const busyWindowResults = await Promise.all(
    candidateSalespeople.map(async sp => {
      const dbWindows = await getBusyWindowsFromDb(
        tenantId,
        sp.housecallProUserId ?? null,
        sp.userId,
        searchStart,
        searchEnd,
      ).catch(err => {
        log.error(`[scheduling] DB busy-window query failed for ${sp.name}, treating as unavailable:`, err);
        return null;
      });
      if (dbWindows === null) return null;
      const googleWindows = await getGoogleBusyWindows(sp, searchStart, searchEnd);
      return [...dbWindows, ...googleWindows];
    })
  );

  const availableSalespeople: SalespersonInfo[] = [];

  for (let i = 0; i < candidateSalespeople.length; i++) {
    const sp = candidateSalespeople[i];
    const rawBusyWindows = busyWindowResults[i];

    // null signals a DB query failure — treat as fully unavailable
    if (rawBusyWindows === null) continue;

    const allBusyWindows = rawBusyWindows.map(bw => expandBusyWindowWithBuffer(bw.start, bw.end, bufferMinutes));

    if (!isSlotBusy(startTime, endTime, allBusyWindows)) {
      availableSalespeople.push(sp);
    }
  }

  if (!availableSalespeople.length) {
    return null;
  }

  availableSalespeople.sort((a, b) => {
    if (!a.lastAssignmentAt && !b.lastAssignmentAt) {
      return a.name.localeCompare(b.name);
    }
    if (!a.lastAssignmentAt) return -1;
    if (!b.lastAssignmentAt) return 1;
    return a.lastAssignmentAt.getTime() - b.lastAssignmentAt.getTime();
  });

  return availableSalespeople[0];
}
