/**
 * Regression coverage for internal flexible scheduling (task #859 → #871).
 *
 * `getSalespersonDaySlots` powers the in-app booker's time picker. Unlike the
 * public availability path (which returns only free gaps), it must return EVERY
 * candidate start time across the salesperson's working window and FLAG the ones
 * that overlap an existing appointment with `conflict: true` — WITHOUT omitting
 * them. Staff are intentionally allowed to double-book a busy time.
 *
 * These tests pin that contract so a future change cannot quietly re-hide or
 * drop conflicting times.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { selectMock, getSalespeopleMock } = vi.hoisted(() => ({
  selectMock: vi.fn(),
  getSalespeopleMock: vi.fn(),
}));

// Minimal Drizzle mock: chained builders return a thenable that resolves to
// whatever selectMock() returned for this call.
function chain(result: unknown) {
  const p: any = Promise.resolve(result);
  p.from = () => p;
  p.where = () => p;
  p.limit = () => p;
  return p;
}

vi.mock('../db', () => ({
  db: { select: (...args: unknown[]) => chain(selectMock(...args)) },
}));

vi.mock('./queries', () => ({
  getSalespeople: (...args: unknown[]) => getSalespeopleMock(...args),
}));

// Availability cache is imported at module load; getSalespersonDaySlots does not
// use it (it is deliberately uncached), but the import must resolve.
vi.mock('../services/availability-cache', () => ({
  getCachedAvailability: vi.fn(),
  setCachedAvailability: vi.fn(),
  coalesceAvailabilityRequest: vi.fn(),
}));

vi.mock('../google-calendar-service', () => ({
  googleCalendarService: { getBusyWindows: vi.fn() },
  GoogleCalendarAuthError: class GoogleCalendarAuthError extends Error {},
}));

import { getSalespersonDaySlots } from './availability';

const TENANT = 'tenant-1';
const SALESPERSON_ID = 'sp-1';
// A weekday well into the future so the "don't offer past times" filter never
// trims any slots (the suite runs in 2026).
const DATE = '2027-07-08'; // Thursday
const TZ = 'America/New_York'; // EDT (UTC-4) in July

// Salesperson with no HCP link (skips the estimates + HCP-calendar queries, so
// the only DB busy source is scheduled_bookings) and no Google Calendar
// (getGoogleBusyWindows short-circuits to []).
const SALESPERSON = {
  userId: SALESPERSON_ID,
  name: 'Pat Salesperson',
  email: 'pat@example.com',
  housecallProUserId: null,
  googleCalendarConnected: false,
  googleCalendarRefreshToken: null,
  workingDays: [1, 2, 3, 4, 5],
  workingHoursStart: '08:00',
  workingHoursEnd: '17:00',
};

beforeEach(() => {
  vi.clearAllMocks();
  getSalespeopleMock.mockResolvedValue([SALESPERSON]);
});

describe('getSalespersonDaySlots — conflict flagging (task #871)', () => {
  it('returns EVERY candidate time and flags overlaps with conflict:true without omitting them', async () => {
    // 1st select = getAppointmentSettings (contractors row).
    // 2nd select = getBusyWindowsFromDb bookings — one 10:00–11:00 EDT booking
    //              (14:00–15:00 UTC).
    selectMock
      .mockReturnValueOnce([{ duration: 60, buffer: 30 }])
      .mockReturnValueOnce([
        {
          startTime: new Date('2027-07-08T14:00:00.000Z'),
          endTime: new Date('2027-07-08T15:00:00.000Z'),
        },
      ]);

    const { slots, durationMinutes, bufferMinutes } = await getSalespersonDaySlots(
      TENANT,
      DATE,
      SALESPERSON_ID,
      TZ,
    );

    expect(durationMinutes).toBe(60);
    expect(bufferMinutes).toBe(30);

    // 08:00–17:00 working window, 60-min slots stepped every 15 min: the last
    // slot that still fits is 16:00–17:00. That is 33 candidate times, none of
    // which are omitted regardless of conflict.
    expect(slots.length).toBe(33);

    // The list must contain BOTH conflicting and free candidate times.
    const conflicting = slots.filter(s => s.conflict);
    const free = slots.filter(s => !s.conflict);
    expect(conflicting.length).toBeGreaterThan(0);
    expect(free.length).toBeGreaterThan(0);

    // The 10:00 EDT slot (14:00 UTC) overlaps the booking → conflict:true, and
    // it is STILL present (selectable), never hidden.
    const tenAm = slots.find(s => s.start.toISOString() === '2027-07-08T14:00:00.000Z');
    expect(tenAm).toBeDefined();
    expect(tenAm!.conflict).toBe(true);

    // The 08:00 EDT slot (12:00 UTC) does not overlap → conflict:false.
    const eightAm = slots.find(s => s.start.toISOString() === '2027-07-08T12:00:00.000Z');
    expect(eightAm).toBeDefined();
    expect(eightAm!.conflict).toBe(false);

    // Every candidate is a well-formed 60-minute window.
    for (const s of slots) {
      expect(s.end.getTime() - s.start.getTime()).toBe(60 * 60 * 1000);
    }
  });

  it('flags no conflicts when the salesperson has no bookings, but still returns the full candidate list', async () => {
    selectMock
      .mockReturnValueOnce([{ duration: 60, buffer: 30 }])
      .mockReturnValueOnce([]); // no bookings

    const { slots } = await getSalespersonDaySlots(TENANT, DATE, SALESPERSON_ID, TZ);

    expect(slots.length).toBe(33);
    expect(slots.every(s => s.conflict === false)).toBe(true);
  });

  it('returns an empty list (never throws) when the salesperson does not exist for the tenant', async () => {
    selectMock.mockReturnValueOnce([{ duration: 60, buffer: 30 }]);
    getSalespeopleMock.mockResolvedValue([]); // no matching salesperson

    const { slots } = await getSalespersonDaySlots(TENANT, DATE, 'unknown-sp', TZ);
    expect(slots).toEqual([]);
  });
});
