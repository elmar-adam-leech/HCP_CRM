/**
 * Unit tests for `getCalendarEvents` (Task #861) — the read-only unified day
 * schedule that merges CRM-native bookings with connected reps' Google Calendar
 * busy blocks.
 *
 * Behavior pinned here:
 *   - CRM bookings surface as `source: 'crm'`; cancelled bookings are excluded.
 *   - Only salespeople with `googleCalendarConnected` + a refresh token
 *     contribute Google busy blocks (per-user connection status is respected).
 *   - Google busy blocks fully contained inside a CRM booking for the SAME
 *     salesperson are suppressed (dedup of the task #858 Google echo).
 *   - Results are sorted by start time.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  getBookingsMock,
  getSalespeopleMock,
  getBusyWindowsMock,
} = vi.hoisted(() => ({
  getBookingsMock: vi.fn(),
  getSalespeopleMock: vi.fn(),
  getBusyWindowsMock: vi.fn(),
}));

vi.mock('./queries', () => ({
  getBookings: getBookingsMock,
  getSalespeople: getSalespeopleMock,
}));

vi.mock('../google-calendar-service', () => ({
  googleCalendarService: { getBusyWindows: getBusyWindowsMock },
  GoogleCalendarAuthError: class GoogleCalendarAuthError extends Error {},
}));

vi.mock('../services/availability-cache', () => ({
  getCachedAvailability: vi.fn(),
  setCachedAvailability: vi.fn(),
  coalesceAvailabilityRequest: vi.fn(),
}));

vi.mock('../db', () => ({ db: {} }));

import { getCalendarEvents } from './availability';

const DAY_START = new Date('2026-07-10T00:00:00.000Z');
const DAY_END = new Date('2026-07-10T23:59:59.999Z');

function booking(overrides: Record<string, unknown> = {}) {
  return {
    id: 'b1',
    title: 'AC Install',
    startTime: new Date('2026-07-10T15:00:00.000Z'),
    endTime: new Date('2026-07-10T16:00:00.000Z'),
    customerName: 'Jane Doe',
    status: 'scheduled',
    salespersonId: 'user-1',
    salespersonName: 'Rep One',
    ...overrides,
  };
}

function salesperson(overrides: Record<string, unknown> = {}) {
  return {
    userId: 'user-1',
    name: 'Rep One',
    googleCalendarConnected: true,
    googleCalendarRefreshToken: 'token-1',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getBookingsMock.mockResolvedValue([]);
  getSalespeopleMock.mockResolvedValue([]);
  getBusyWindowsMock.mockResolvedValue([]);
});

describe('getCalendarEvents', () => {
  it('returns CRM bookings as source "crm" and excludes cancelled', async () => {
    getBookingsMock.mockResolvedValue([
      booking(),
      booking({ id: 'b2', status: 'cancelled', title: 'Cancelled job' }),
    ]);

    const events = await getCalendarEvents('tenant-1', DAY_START, DAY_END);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ source: 'crm', id: 'b1', title: 'AC Install' });
  });

  it('includes Google busy blocks only for connected salespeople', async () => {
    getSalespeopleMock.mockResolvedValue([
      salesperson({ userId: 'user-1' }),
      salesperson({ userId: 'user-2', name: 'Rep Two', googleCalendarConnected: false, googleCalendarRefreshToken: null }),
    ]);
    getBusyWindowsMock.mockResolvedValue([
      { start: new Date('2026-07-10T18:00:00.000Z'), end: new Date('2026-07-10T19:00:00.000Z') },
    ]);

    const events = await getCalendarEvents('tenant-1', DAY_START, DAY_END);

    // Only user-1 is connected, so getBusyWindows is invoked once.
    expect(getBusyWindowsMock).toHaveBeenCalledTimes(1);
    const google = events.filter(e => e.source === 'google');
    expect(google).toHaveLength(1);
    expect(google[0]).toMatchObject({ source: 'google', salespersonId: 'user-1', title: 'Busy' });
  });

  it('suppresses a Google busy block fully covered by a CRM booking for the same rep', async () => {
    getBookingsMock.mockResolvedValue([booking()]); // 15:00–16:00 for user-1
    getSalespeopleMock.mockResolvedValue([salesperson()]);
    getBusyWindowsMock.mockResolvedValue([
      // Echo of the CRM booking (contained) — should be dropped.
      { start: new Date('2026-07-10T15:00:00.000Z'), end: new Date('2026-07-10T16:00:00.000Z') },
      // A genuinely separate external commitment — should be kept.
      { start: new Date('2026-07-10T20:00:00.000Z'), end: new Date('2026-07-10T21:00:00.000Z') },
    ]);

    const events = await getCalendarEvents('tenant-1', DAY_START, DAY_END);

    const google = events.filter(e => e.source === 'google');
    expect(google).toHaveLength(1);
    expect(google[0].start).toBe(new Date('2026-07-10T20:00:00.000Z').toISOString());
  });

  it('sorts merged events by start time', async () => {
    getBookingsMock.mockResolvedValue([
      booking({ id: 'b1', startTime: new Date('2026-07-10T17:00:00.000Z'), endTime: new Date('2026-07-10T18:00:00.000Z') }),
    ]);
    getSalespeopleMock.mockResolvedValue([salesperson()]);
    getBusyWindowsMock.mockResolvedValue([
      { start: new Date('2026-07-10T09:00:00.000Z'), end: new Date('2026-07-10T10:00:00.000Z') },
    ]);

    const events = await getCalendarEvents('tenant-1', DAY_START, DAY_END);

    expect(events.map(e => e.source)).toEqual(['google', 'crm']);
  });

  it('filters to a single salesperson when salespersonId is provided', async () => {
    getBookingsMock.mockResolvedValue([
      booking({ id: 'b1', salespersonId: 'user-1' }),
      booking({ id: 'b2', salespersonId: 'user-2', salespersonName: 'Rep Two' }),
    ]);
    getSalespeopleMock.mockResolvedValue([
      salesperson({ userId: 'user-1' }),
      salesperson({ userId: 'user-2', name: 'Rep Two' }),
    ]);

    const events = await getCalendarEvents('tenant-1', DAY_START, DAY_END, 'user-1');

    expect(events.every(e => e.salespersonId === 'user-1')).toBe(true);
    // Google fetched only for the filtered rep.
    expect(getBusyWindowsMock).toHaveBeenCalledTimes(1);
  });
});
