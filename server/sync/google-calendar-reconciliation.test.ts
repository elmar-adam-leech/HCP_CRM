/**
 * Unit tests for reconcileGoogleCalendarBookings (task #862).
 *
 * The reverse-sync pass correlates each active booking to its linked Google
 * Calendar event via the stored googleCalendarEventId and:
 *   - cancels the booking when the event was deleted or cancelled, and
 *   - updates startTime/endTime when the event was moved.
 * Each affected date has its availability cache invalidated + recomputed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  selectMock,
  updateSetSpy,
  getEventMock,
  invalidateAndRecomputeMock,
} = vi.hoisted(() => ({
  selectMock: vi.fn(),
  updateSetSpy: vi.fn(),
  getEventMock: vi.fn(),
  invalidateAndRecomputeMock: vi.fn(),
}));

// Minimal Drizzle mock: chained builders return self until terminal awaitable.
function chain(result: unknown) {
  const p: any = Promise.resolve(result);
  p.from = () => p;
  p.innerJoin = () => p;
  p.where = () => p;
  p.limit = () => p;
  p.set = (vals: unknown) => {
    updateSetSpy(vals);
    return p;
  };
  return p;
}

vi.mock('../db', () => ({
  db: {
    select: (...args: unknown[]) => chain(selectMock(...args)),
    update: () => chain(undefined),
  },
}));

vi.mock('../google-calendar-service', () => {
  class GoogleCalendarAuthError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'GoogleCalendarAuthError';
    }
  }
  return {
    GoogleCalendarAuthError,
    googleCalendarService: {
      getEvent: (...args: unknown[]) => getEventMock(...args),
    },
  };
});

vi.mock('../services/availability-cache', () => ({
  invalidateAndRecompute: (...args: unknown[]) => invalidateAndRecomputeMock(...args),
  utcToLocalDateStr: (ts: Date) => ts.toISOString().slice(0, 10),
}));

vi.mock('../scheduling/availability', () => ({
  getAvailabilityForDate: vi.fn(),
}));

import { reconcileGoogleCalendarBookings } from './google-calendar-reconciliation';
import { GoogleCalendarAuthError } from '../google-calendar-service';

const BOOKING = {
  id: 'booking-1',
  contractorId: 'tenant-1',
  salespersonId: 'sp-1',
  eventId: 'gcal-event-1',
  startTime: new Date('2026-08-01T15:00:00Z'),
  endTime: new Date('2026-08-01T16:00:00Z'),
  refreshToken: 'enc-token',
};

beforeEach(() => {
  vi.clearAllMocks();
  // First select() call returns the bookings; contractor-timezone lookups
  // (subsequent selects) return a row with a timezone.
  selectMock
    .mockReturnValueOnce([BOOKING])
    .mockReturnValue([{ timezone: 'America/New_York' }]);
});

describe('reconcileGoogleCalendarBookings', () => {
  it('cancels the booking when the Google event was deleted', async () => {
    getEventMock.mockResolvedValue({ status: 'deleted' });

    const summary = await reconcileGoogleCalendarBookings();

    expect(summary.cancelled).toBe(1);
    expect(summary.rescheduled).toBe(0);
    expect(updateSetSpy).toHaveBeenCalledTimes(1);
    expect(updateSetSpy.mock.calls[0][0]).toMatchObject({ status: 'cancelled' });
    expect(invalidateAndRecomputeMock).toHaveBeenCalledTimes(1);
  });

  it('cancels the booking when the Google event was cancelled', async () => {
    getEventMock.mockResolvedValue({ status: 'cancelled' });

    const summary = await reconcileGoogleCalendarBookings();

    expect(summary.cancelled).toBe(1);
    expect(updateSetSpy.mock.calls[0][0]).toMatchObject({ status: 'cancelled' });
  });

  it('updates start/end times when the Google event was moved', async () => {
    const newStart = new Date('2026-08-02T18:00:00Z');
    const newEnd = new Date('2026-08-02T19:00:00Z');
    getEventMock.mockResolvedValue({ status: 'confirmed', startTime: newStart, endTime: newEnd });

    const summary = await reconcileGoogleCalendarBookings();

    expect(summary.rescheduled).toBe(1);
    expect(summary.cancelled).toBe(0);
    const setArg = updateSetSpy.mock.calls[0][0];
    expect(setArg.startTime).toEqual(newStart);
    expect(setArg.endTime).toEqual(newEnd);
    // Both the old and the new date get their cache invalidated.
    expect(invalidateAndRecomputeMock).toHaveBeenCalledTimes(1);
    const dates = invalidateAndRecomputeMock.mock.calls[0][3] as string[];
    expect(dates).toHaveLength(2);
  });

  it('leaves the booking untouched when the event is unchanged', async () => {
    getEventMock.mockResolvedValue({
      status: 'confirmed',
      startTime: BOOKING.startTime,
      endTime: BOOKING.endTime,
    });

    const summary = await reconcileGoogleCalendarBookings();

    expect(summary.checked).toBe(1);
    expect(summary.rescheduled).toBe(0);
    expect(summary.cancelled).toBe(0);
    expect(updateSetSpy).not.toHaveBeenCalled();
    expect(invalidateAndRecomputeMock).not.toHaveBeenCalled();
  });

  it('skips all-day (date-only) events with no dateTime', async () => {
    getEventMock.mockResolvedValue({ status: 'confirmed' });

    const summary = await reconcileGoogleCalendarBookings();

    expect(summary.checked).toBe(1);
    expect(summary.rescheduled).toBe(0);
    expect(updateSetSpy).not.toHaveBeenCalled();
  });

  it('marks the salesperson disconnected on an auth error and stops checking their bookings', async () => {
    // Two bookings for the same salesperson; the first getEvent throws auth.
    selectMock
      .mockReset()
      .mockReturnValueOnce([BOOKING, { ...BOOKING, id: 'booking-2', eventId: 'gcal-event-2' }])
      .mockReturnValue([{ timezone: 'America/New_York' }]);
    getEventMock.mockRejectedValue(new GoogleCalendarAuthError('token revoked'));

    const summary = await reconcileGoogleCalendarBookings();

    // getEvent called only once — the second booking is skipped because the
    // salesperson was flagged disconnected.
    expect(getEventMock).toHaveBeenCalledTimes(1);
    expect(summary.cancelled).toBe(0);
    expect(summary.rescheduled).toBe(0);
    // One update: flipping users.googleCalendarConnected = false.
    expect(updateSetSpy).toHaveBeenCalledWith({ googleCalendarConnected: false });
  });

  it('counts transient errors without cancelling the booking', async () => {
    getEventMock.mockRejectedValue(new Error('network blip'));

    const summary = await reconcileGoogleCalendarBookings();

    expect(summary.errors).toBe(1);
    expect(summary.cancelled).toBe(0);
    expect(updateSetSpy).not.toHaveBeenCalled();
  });

  it('no-ops when there are no connected bookings', async () => {
    selectMock.mockReset().mockReturnValue([]);

    const summary = await reconcileGoogleCalendarBookings();

    expect(summary).toEqual({ checked: 0, rescheduled: 0, cancelled: 0, errors: 0 });
    expect(getEventMock).not.toHaveBeenCalled();
  });
});
