/**
 * Task #699 — Surface public booking notes in the CRM.
 *
 * Verifies that `bookAppointment` writes the customer's actual booking note
 * text to the activity feed as a `type: 'note'` row (so it shows up in the
 * Lead Notes panel), linked to BOTH the contact and the local CRM estimate,
 * and that retries of the same booking do NOT produce duplicate note rows.
 *
 * The HCP path is intentionally exercised with `housecallProUserId: null` so
 * `createOrConvertHcpEstimate` is skipped — this isolates the new behavior
 * from the convert-path tests in `hcp-estimate-convert-path.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  storageMock,
  createActivityMock,
  broadcastMock,
  markScheduledMock,
  invalidateMock,
  selectChainMock,
  insertReturning,
  updateChainMock,
  bookingRowRef,
  contactRowRef,
  contractorRowRef,
  existingActivitiesRef,
  createCrmEstimateMock,
  createOrConvertHcpEstimateMock,
} = vi.hoisted(() => {
  const bookingRowRef = { current: { id: 'booking-1' } };
  const contactRowRef = {
    current: { address: null, street: null, city: null, state: null, zip: null },
  };
  const contractorRowRef = { current: { timezone: 'America/New_York' } };
  const existingActivitiesRef = { current: [] as Array<{ externalSource: string; externalId: string }> };

  return {
    storageMock: {
      getActivities: vi.fn(async () => existingActivitiesRef.current),
    },
    createActivityMock: vi.fn(async () => ({ id: 'activity-1' })),
    broadcastMock: vi.fn(),
    markScheduledMock: vi.fn(async () => undefined),
    invalidateMock: vi.fn(),
    selectChainMock: vi.fn(),
    insertReturning: vi.fn(),
    updateChainMock: vi.fn(),
    bookingRowRef,
    contactRowRef,
    contractorRowRef,
    existingActivitiesRef,
    createCrmEstimateMock: vi.fn(async () => 'crm-estimate-99'),
    createOrConvertHcpEstimateMock: vi.fn(),
  };
});

vi.mock('../db', () => {
  return {
    db: {
      // Drizzle's chained select() — returns whatever the test set up for the
      // current call sequence. The booking flow does three selects in order:
      //   (1) contacts row (storedContactAddress)
      //   (2) … none in this test (HCP path skipped)
      //   (3) contractors row (timezone)
      // We dispatch by .from() target so order is irrelevant.
      select: () => ({
        from: (tbl: any) => ({
          where: () => ({
            limit: () => {
              const name = (tbl?.[Symbol.for('drizzle:Name')] || '') as string;
              if (name === 'contractors') return Promise.resolve([contractorRowRef.current]);
              return Promise.resolve([contactRowRef.current]);
            },
          }),
        }),
      }),
      insert: () => ({
        values: () => ({
          returning: () => Promise.resolve([bookingRowRef.current]),
        }),
      }),
      update: () => ({
        set: () => ({
          where: () => Promise.resolve(undefined),
        }),
      }),
    },
  };
});

vi.mock('@shared/schema', () => ({
  contacts: { [Symbol.for('drizzle:Name')]: 'contacts', address: {}, street: {}, city: {}, state: {}, zip: {}, id: {} },
  scheduledBookings: { [Symbol.for('drizzle:Name')]: 'scheduledBookings', id: {} },
  userContractors: { [Symbol.for('drizzle:Name')]: 'userContractors', userId: {}, contractorId: {} },
  contractors: { [Symbol.for('drizzle:Name')]: 'contractors', id: {}, timezone: {} },
}));

vi.mock('drizzle-orm', () => ({
  eq: () => ({}),
  and: () => ({}),
}));

vi.mock('../scheduling/queries', () => ({
  getSalespeople: vi.fn(),
}));

vi.mock('../scheduling/availability', () => ({
  selectNextAvailableSalesperson: vi.fn(),
  getAvailabilityForDate: vi.fn(),
}));

vi.mock('../services/availability-cache', () => ({
  invalidateAndRecompute: (...args: unknown[]) => invalidateMock(...args),
  utcToLocalDateStr: () => '2026-01-01',
}));

vi.mock('../scheduling/hcp-customer', () => ({
  resolveHcpCustomer: vi.fn(),
}));

vi.mock('../scheduling/hcp-estimate', () => ({
  createOrConvertHcpEstimate: (...args: unknown[]) => createOrConvertHcpEstimateMock(...args),
}));

vi.mock('../scheduling/crm-estimate', () => ({
  createCrmEstimate: (...args: unknown[]) => createCrmEstimateMock(...args),
}));

vi.mock('../services/contact-status', () => ({
  markContactScheduled: (...args: unknown[]) => markScheduledMock(...args),
}));

vi.mock('../utils/activity', () => ({
  createActivityAndBroadcast: (...args: unknown[]) => createActivityMock(...args),
}));

vi.mock('../websocket', () => ({
  broadcastToContractor: (...args: unknown[]) => broadcastMock(...args),
}));

vi.mock('../storage', () => ({ storage: storageMock }));

import { bookAppointment } from '../scheduling/booking';
import type { BookingRequest, SalespersonInfo } from '../types/scheduling';

const TENANT = 'tenant-1';
const CONTACT_ID = 'contact-77';
const START = new Date('2026-02-01T15:00:00Z');

const SALESPERSON_NO_HCP: SalespersonInfo = {
  userId: 'user-1',
  name: 'Sara Sales',
  email: 'sara@example.com',
  housecallProUserId: null, // skips the HCP-estimate path
} as SalespersonInfo;

function makeRequest(overrides: Partial<BookingRequest> = {}): BookingRequest {
  return {
    contactId: CONTACT_ID,
    startTime: START,
    title: 'Estimate',
    customerName: 'Pat Customer',
    notes: 'Tankless install — 50 gal currently. Has a noisy boiler too.',
    salespersonId: SALESPERSON_NO_HCP.userId,
    scheduleSource: 'public_booking',
    ...overrides,
  } as BookingRequest;
}

beforeEach(async () => {
  vi.clearAllMocks();
  existingActivitiesRef.current = [];
  bookingRowRef.current = { id: 'booking-1' };
  createCrmEstimateMock.mockResolvedValue('crm-estimate-99');
  storageMock.getActivities.mockImplementation(async () => existingActivitiesRef.current);
  // Re-stub the salesperson lookup since vi.clearAllMocks resets it.
  const { getSalespeople } = await import('../scheduling/queries');
  (getSalespeople as ReturnType<typeof vi.fn>).mockResolvedValue([SALESPERSON_NO_HCP]);
});

describe('bookAppointment — public booking notes activity (Task #699)', () => {
  it('writes the actual customer note text to the activity feed as a note row, linked to contact + local CRM estimate', async () => {
    const result = await bookAppointment(TENANT, makeRequest());

    expect(result.success).toBe(true);
    expect(createActivityMock).toHaveBeenCalledTimes(1);

    const [tenantArg, payload, broadcast] = createActivityMock.mock.calls[0];
    expect(tenantArg).toBe(TENANT);
    expect(payload.type).toBe('note');
    expect(payload.contactId).toBe(CONTACT_ID);
    // Linked to the local CRM estimate so it surfaces on the estimate detail too.
    expect(payload.estimateId).toBe('crm-estimate-99');
    // Actual customer note text is present (not the old generic breadcrumb).
    expect(payload.content).toContain('Tankless install — 50 gal currently');
    expect(payload.content).toContain('Booking note from customer');
    expect(payload.content).not.toMatch(/Booking notes attached to HCP estimate/);
    // Source attribution + deterministic external id for retry-dedup.
    expect(payload.externalSource).toBe('public_booking');
    expect(payload.externalId).toBe(`booking-note-${CONTACT_ID}-${START.getTime()}`);
    // Broadcast payload mirrors the activity_created shape used elsewhere.
    expect(broadcast).toMatchObject({ type: 'activity_created', contactId: CONTACT_ID });
  });

  it('skips the duplicate write when the same booking note activity already exists (retry dedup guard)', async () => {
    existingActivitiesRef.current = [
      {
        externalSource: 'public_booking',
        externalId: `booking-note-${CONTACT_ID}-${START.getTime()}`,
      },
    ];

    const result = await bookAppointment(TENANT, makeRequest());

    expect(result.success).toBe(true);
    expect(createActivityMock).not.toHaveBeenCalled();
  });

  it('uses an "in_app_booking" source label and "Booking note:" prefix when scheduleSource is in-app', async () => {
    await bookAppointment(TENANT, makeRequest({ scheduleSource: 'in_app_booking' }));

    expect(createActivityMock).toHaveBeenCalledTimes(1);
    const payload = createActivityMock.mock.calls[0][1];
    expect(payload.externalSource).toBe('in_app_booking');
    expect(payload.content.startsWith('Booking note:\n')).toBe(true);
  });

  it('does not write a note activity when the customer left the notes field blank', async () => {
    await bookAppointment(TENANT, makeRequest({ notes: '   ' }));

    expect(createActivityMock).not.toHaveBeenCalled();
  });

  it('still writes the customer note to the CRM activity feed when the HCP push fails with [booker_notes_missing]', async () => {
    // Wire up an HCP-capable salesperson so the booking flow takes the HCP
    // branch — and have createOrConvertHcpEstimate return the same shape it
    // would after every booker-note POST + verification failed: the estimate
    // exists in HCP but the note did not land, signalled via the
    // [booker_notes_missing] sentinel inside scheduleError.
    const SALESPERSON_WITH_HCP: SalespersonInfo = {
      ...SALESPERSON_NO_HCP,
      housecallProUserId: 'hcp_emp_1',
    } as SalespersonInfo;
    const { getSalespeople } = await import('../scheduling/queries');
    (getSalespeople as ReturnType<typeof vi.fn>).mockResolvedValue([SALESPERSON_WITH_HCP]);

    const { resolveHcpCustomer } = await import('../scheduling/hcp-customer');
    (resolveHcpCustomer as ReturnType<typeof vi.fn>).mockResolvedValue({
      customerId: 'hcp_cus_1',
      serviceAddressId: 'hcp_addr_1',
      serviceAddressRecreated: false,
    });

    createOrConvertHcpEstimateMock.mockResolvedValue({
      hcpEstimateId: 'csr_failed_notes',
      scheduleError:
        'Estimate was created in HousecallPro but the following note(s) could not be added automatically: booker notes. Please open HousecallPro to add them manually. [booker_notes_missing]',
    });

    const req = makeRequest({ salespersonId: SALESPERSON_WITH_HCP.userId });
    const result = await bookAppointment(TENANT, req);

    // The booking call still succeeds (the failure surfaces via scheduleError,
    // not via the success flag) — and crucially, the customer's note still
    // landed in the CRM activity feed even though the HCP push failed.
    expect(result.success).toBe(true);
    expect(result.scheduleError).toContain('[booker_notes_missing]');
    expect(createActivityMock).toHaveBeenCalledTimes(1);
    const payload = createActivityMock.mock.calls[0][1];
    expect(payload.type).toBe('note');
    expect(payload.contactId).toBe(CONTACT_ID);
    expect(payload.content).toContain('Tankless install — 50 gal currently');
    expect(payload.externalSource).toBe('public_booking');
  });
});
