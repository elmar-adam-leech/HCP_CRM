/**
 * Unit tests for `bookAppointment` activity attribution (Task #698).
 *
 * Two flows differ only by `request.scheduleSource`:
 *   - 'public_booking' (customer self-scheduled): the auto-assigned salesperson
 *     is the assignee, NOT the actor. The status_change activity must carry
 *     `activityUserId: undefined` and `activityExternalSource: 'public_booking'`
 *     so the frontend renders "Online Booking" as the author.
 *   - undefined / 'in_app_booking' (a rep scheduled from the in-app booker):
 *     the salesperson IS the actor. The activity must carry the salesperson
 *     id as `activityUserId` and no externalSource override.
 *
 * The persisted `scheduled_bookings.source` column also follows scheduleSource
 * and drives the Self-Scheduled vs Sales-Scheduled report.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  selectMock,
  insertReturningMock,
  insertValuesSpy,
  updateMock,
  getSalespeopleMock,
  selectNextAvailableSalespersonMock,
  resolveHcpCustomerMock,
  createOrConvertHcpEstimateMock,
  createCrmEstimateMock,
  markContactScheduledMock,
  invalidateAndRecomputeMock,
} = vi.hoisted(() => ({
  selectMock: vi.fn(),
  insertReturningMock: vi.fn(),
  // Captures the values passed to db.insert(...).values(...) so tests can
  // assert the persisted scheduled_bookings.source.
  insertValuesSpy: vi.fn(),
  updateMock: vi.fn(),
  getSalespeopleMock: vi.fn(),
  selectNextAvailableSalespersonMock: vi.fn(),
  resolveHcpCustomerMock: vi.fn(),
  createOrConvertHcpEstimateMock: vi.fn(),
  createCrmEstimateMock: vi.fn(),
  markContactScheduledMock: vi.fn().mockResolvedValue(undefined),
  invalidateAndRecomputeMock: vi.fn(),
}));

// Minimal Drizzle mock: chained builders return self until terminal awaitable.
function chain(result: unknown, opts?: { isInsert?: boolean }) {
  const p: any = Promise.resolve(result);
  p.from = () => p;
  p.where = () => p;
  p.limit = () => p;
  p.set = () => p;
  p.values = (vals: unknown) => {
    if (opts?.isInsert) insertValuesSpy(vals);
    return p;
  };
  p.returning = () => insertReturningMock();
  return p;
}

vi.mock('../db', () => ({
  db: {
    select: (...args: unknown[]) => chain(selectMock(...args)),
    insert: () => chain(undefined, { isInsert: true }),
    update: () => {
      updateMock();
      return chain(undefined);
    },
  },
}));

vi.mock('./queries', () => ({
  getSalespeople: (...args: unknown[]) => getSalespeopleMock(...args),
}));
vi.mock('./availability', () => ({
  selectNextAvailableSalesperson: (...args: unknown[]) => selectNextAvailableSalespersonMock(...args),
  getAvailabilityForDate: vi.fn(),
  getAppointmentSettings: vi.fn(async () => ({ durationMinutes: 60, bufferMinutes: 30 })),
}));
vi.mock('../services/availability-cache', () => ({
  invalidateAndRecompute: (...args: unknown[]) => invalidateAndRecomputeMock(...args),
  utcToLocalDateStr: () => '2026-05-15',
}));
vi.mock('./hcp-customer', () => ({
  resolveHcpCustomer: (...args: unknown[]) => resolveHcpCustomerMock(...args),
}));
vi.mock('./hcp-estimate', () => ({
  createOrConvertHcpEstimate: (...args: unknown[]) => createOrConvertHcpEstimateMock(...args),
}));
vi.mock('./crm-estimate', () => ({
  createCrmEstimate: (...args: unknown[]) => createCrmEstimateMock(...args),
}));
vi.mock('../services/contact-status', () => ({
  markContactScheduled: (...args: unknown[]) => markContactScheduledMock(...args),
}));

import { bookAppointment } from './booking';

const TENANT = 'tenant-1';
const CONTACT_ID = 'contact-1';
const SALESPERSON = {
  userId: 'sp-1',
  name: 'Pat Salesperson',
  email: 'pat@example.com',
  housecallProUserId: null, // skips HCP estimate path
  lastAssignmentAt: null,
  calendarColor: null,
  isSalesperson: true,
  workingDays: [1, 2, 3, 4, 5],
  workingHoursStart: '09:00',
  workingHoursEnd: '17:00',
  hasCustomSchedule: false,
  displayOrder: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  // No address writeback — return an empty stored-contact row.
  selectMock.mockResolvedValue([{ address: null, street: null, city: null, state: null, zip: null }]);
  insertReturningMock.mockResolvedValue([{ id: 'booking-1' }]);
  selectNextAvailableSalespersonMock.mockResolvedValue(SALESPERSON);
  getSalespeopleMock.mockResolvedValue([SALESPERSON]);
  resolveHcpCustomerMock.mockResolvedValue(null);
  createOrConvertHcpEstimateMock.mockResolvedValue(null);
  createCrmEstimateMock.mockResolvedValue(undefined);
});

describe('bookAppointment — activity attribution by scheduleSource', () => {
  it('public_booking: leaves status_change activity unattributed, tags external_source, and persists scheduled_bookings.source = public_booking', async () => {
    const result = await bookAppointment(TENANT, {
      startTime: new Date('2026-05-15T15:00:00Z'),
      title: 'Public booking',
      customerName: 'Reema Saeed',
      contactId: CONTACT_ID,
      scheduleSource: 'public_booking',
      bookingPayload: { source: 'public_booking' },
      timezone: 'America/New_York',
    });
    expect(result.success).toBe(true);

    expect(markContactScheduledMock).toHaveBeenCalledTimes(1);
    const [contactArg, tenantArg, opts] = markContactScheduledMock.mock.calls[0];
    expect(contactArg).toBe(CONTACT_ID);
    expect(tenantArg).toBe(TENANT);
    expect(opts.source).toBe('public_booking');
    // The fix: actor is unset so the activity feed renders "Online Booking".
    expect(opts.activityUserId).toBeUndefined();
    expect(opts.activityExternalSource).toBe('public_booking');
    // The salesperson is still recorded as the scheduling owner — they remain
    // the assignee, just not the actor.
    expect(opts.scheduledByUserId).toBe(SALESPERSON.userId);

    // The scheduled_bookings row itself must persist source=public_booking so
    // the Self-Scheduled vs Sales-Scheduled report counts it correctly.
    expect(insertValuesSpy).toHaveBeenCalledTimes(1);
    const inserted = insertValuesSpy.mock.calls[0][0];
    expect(inserted.source).toBe('public_booking');
    expect(inserted.assignedSalespersonId).toBe(SALESPERSON.userId);
    expect(inserted.bookingPayload).toEqual({ source: 'public_booking' });
  });

  it('in-app booking (no scheduleSource): attributes status_change activity to the salesperson and persists in_app_booking source', async () => {
    const result = await bookAppointment(TENANT, {
      startTime: new Date('2026-05-15T15:00:00Z'),
      title: 'In-app booking',
      customerName: 'Reema Saeed',
      contactId: CONTACT_ID,
      timezone: 'America/New_York',
    });
    expect(result.success).toBe(true);

    expect(markContactScheduledMock).toHaveBeenCalledTimes(1);
    const [, , opts] = markContactScheduledMock.mock.calls[0];
    expect(opts.source).toBe('in_app_booking');
    // In-app: the rep IS the actor, so attribution is required.
    expect(opts.activityUserId).toBe(SALESPERSON.userId);
    // No external_source override — keeps the activity row as a regular
    // in-app status change, no "Online Booking" label.
    expect(opts.activityExternalSource).toBeUndefined();

    // And the persisted scheduled_bookings row defaults to in_app_booking.
    expect(insertValuesSpy).toHaveBeenCalledTimes(1);
    const inserted = insertValuesSpy.mock.calls[0][0];
    expect(inserted.source).toBe('in_app_booking');
  });

  it('in-app booking with explicit scheduleSource = in_app_booking behaves identically', async () => {
    await bookAppointment(TENANT, {
      startTime: new Date('2026-05-15T15:00:00Z'),
      title: 'In-app booking',
      customerName: 'Reema Saeed',
      contactId: CONTACT_ID,
      scheduleSource: 'in_app_booking',
      timezone: 'America/New_York',
    });
    const [, , opts] = markContactScheduledMock.mock.calls[0];
    expect(opts.activityUserId).toBe(SALESPERSON.userId);
    expect(opts.activityExternalSource).toBeUndefined();
    const inserted = insertValuesSpy.mock.calls[0][0];
    expect(inserted.source).toBe('in_app_booking');
  });
});
