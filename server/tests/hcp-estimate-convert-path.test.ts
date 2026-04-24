import { describe, it, expect, vi, beforeEach } from 'vitest';

const { hcp, leadRows } = vi.hoisted(() => {
  return {
    hcp: {
      getEstimates: vi.fn(),
      getEstimate: vi.fn(),
      createEstimate: vi.fn(),
      updateEstimate: vi.fn(),
      updateEstimateOptionSchedule: vi.fn(),
      addEstimateNote: vi.fn(),
      getEstimateNotes: vi.fn(),
      getLead: vi.fn(),
      addLeadNote: vi.fn(),
      convertLead: vi.fn(),
    },
    leadRows: { rows: [] as Array<{ housecallProLeadId: string }> },
  };
});

vi.mock('../db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: () => Promise.resolve(leadRows.rows),
          }),
        }),
      }),
    }),
  },
}));

vi.mock('../hcp/index', () => ({
  housecallProService: hcp,
}));

vi.mock('@shared/schema', () => ({ estimates: {}, leads: {} }));
vi.mock('drizzle-orm', () => ({
  eq: () => ({}),
  and: () => ({}),
  desc: () => ({}),
  isNotNull: () => ({}),
}));

// The activity-feed breadcrumb hits the DB indirectly via createActivityAndBroadcast.
// Stub it so the convert-path tests stay focused on the HCP API contract.
vi.mock('../utils/activity', () => ({
  createActivityAndBroadcast: vi.fn().mockResolvedValue(undefined),
}));

import { createOrConvertHcpEstimate, BOOKER_NOTES_MISSING_TOKEN } from '../scheduling/hcp-estimate';
import type { BookingRequest, SalespersonInfo } from '../types/scheduling';

const TENANT = 'tenant-1';
const HCP_CUSTOMER = 'cus_1';
const HCP_LEAD = 'lead_1';
const HCP_EMPLOYEE = 'emp_1';
const NEW_ADDR_ID = 'adr_new';
const NEW_ESTIMATE_ID = 'csr_1';
const OPTION_ID = 'opt_1';

const SALESPERSON: SalespersonInfo = {
  userId: 'user-1',
  name: 'Sara Sales',
  email: 'sara@example.com',
  housecallProUserId: HCP_EMPLOYEE,
} as SalespersonInfo;

const REQUEST: BookingRequest = {
  contactId: 'contact-1',
  startTime: new Date('2026-01-01T15:00:00Z'),
  notes: 'Reached out about a tankless water heater. Currently has a tanked system.',
  customerAddressComponents: {
    street: '29 Far Corners Loop',
    city: 'Sparks Glencoe',
    state: 'MD',
    zip: '21152',
    country: 'US',
  },
} as BookingRequest;

const END_TIME = new Date('2026-01-01T16:00:00Z');

beforeEach(() => {
  Object.values(hcp).forEach((fn) => fn.mockReset());
  leadRows.rows = [{ housecallProLeadId: HCP_LEAD }];
});

describe('createOrConvertHcpEstimate (convert path)', () => {
  it('pre-stages booker notes onto the HCP lead BEFORE convertLead, then verifies the note landed on the estimate', async () => {
    hcp.getLead.mockResolvedValue({ success: true, data: { id: HCP_LEAD } });
    hcp.addLeadNote.mockResolvedValue({ success: true, data: {} });
    hcp.convertLead.mockResolvedValue({
      success: true,
      data: {
        id: NEW_ESTIMATE_ID,
        address_id: NEW_ADDR_ID,
        options: [{ id: OPTION_ID, message: '' }],
      },
    });
    hcp.updateEstimate.mockResolvedValue({ success: true, data: {} });
    hcp.getEstimate.mockResolvedValue({
      success: true,
      data: { id: NEW_ESTIMATE_ID, address_id: NEW_ADDR_ID, options: [{ id: OPTION_ID }] },
    });
    hcp.addEstimateNote.mockResolvedValue({ success: true, data: {} });
    // Verification fetch returns the booker note text — confirms it landed.
    hcp.getEstimateNotes.mockResolvedValue({
      success: true,
      data: [{ id: 'n1', content: REQUEST.notes! }],
    });
    hcp.updateEstimateOptionSchedule.mockResolvedValue({ success: true, data: {} });

    const result = await createOrConvertHcpEstimate(
      TENANT,
      HCP_CUSTOMER,
      SALESPERSON,
      REQUEST,
      END_TIME,
      null,
      null,
      NEW_ADDR_ID,
    );

    expect(result?.hcpEstimateId).toBe(NEW_ESTIMATE_ID);
    expect(result?.scheduleError).toBeUndefined();

    // Lead note pre-staged exactly once with the booker text.
    expect(hcp.addLeadNote).toHaveBeenCalledTimes(1);
    const leadNoteCall = hcp.addLeadNote.mock.calls[0];
    expect(leadNoteCall[0]).toBe(TENANT);
    expect(leadNoteCall[1]).toBe(HCP_LEAD);
    expect(leadNoteCall[2]).toContain(REQUEST.notes!);

    // Pre-staging happened BEFORE convertLead.
    const addLeadNoteOrder = hcp.addLeadNote.mock.invocationCallOrder[0];
    const convertOrder = hcp.convertLead.mock.invocationCallOrder[0];
    expect(addLeadNoteOrder).toBeLessThan(convertOrder);

    // Booker notes also sent verbatim post-convert via addEstimateNote (belt-and-suspenders).
    const noteContents = hcp.addEstimateNote.mock.calls.map((c) => c[2]);
    expect(noteContents).toContain(REQUEST.notes);

    // Service Address note also included.
    expect(noteContents.some((n) => typeof n === 'string' && n.startsWith('Service Address:'))).toBe(true);

    // Verification fetch was called.
    expect(hcp.getEstimateNotes).toHaveBeenCalledWith(TENANT, NEW_ESTIMATE_ID);

    // Update payload to back-fill message includes booker notes + address.
    const updateCall = hcp.updateEstimate.mock.calls[0];
    expect(updateCall[2].message).toContain(REQUEST.notes!);
    expect(updateCall[2].address_id).toBe(NEW_ADDR_ID);
    expect(updateCall[2].address?.street).toBe('29 Far Corners Loop');
  });

  it('retries addEstimateNote on transient failure and succeeds on a later attempt', async () => {
    hcp.getLead.mockResolvedValue({ success: true, data: { id: HCP_LEAD } });
    // Lead-note pre-staging failed — force the post-convert path to do all the work.
    hcp.addLeadNote.mockResolvedValue({ success: false, error: 'transient' });
    hcp.convertLead.mockResolvedValue({
      success: true,
      data: { id: NEW_ESTIMATE_ID, address_id: NEW_ADDR_ID, options: [{ id: OPTION_ID }] },
    });
    hcp.updateEstimate.mockResolvedValue({ success: true, data: {} });
    hcp.getEstimate.mockResolvedValue({
      success: true,
      data: { id: NEW_ESTIMATE_ID, address_id: NEW_ADDR_ID, options: [{ id: OPTION_ID }] },
    });

    // First booker-note POST fails; retry succeeds. (Service-address POST always succeeds.)
    let bookerCallCount = 0;
    hcp.addEstimateNote.mockImplementation(async (_t: string, _id: string, content: string) => {
      if (typeof content === 'string' && content.startsWith('Service Address:')) {
        return { success: true, data: {} };
      }
      bookerCallCount++;
      if (bookerCallCount === 1) return { success: false, error: 'transient' };
      return { success: true, data: {} };
    });
    hcp.getEstimateNotes.mockResolvedValue({
      success: true,
      data: [{ id: 'n1', content: REQUEST.notes! }],
    });
    hcp.updateEstimateOptionSchedule.mockResolvedValue({ success: true, data: {} });

    const result = await createOrConvertHcpEstimate(
      TENANT,
      HCP_CUSTOMER,
      SALESPERSON,
      REQUEST,
      END_TIME,
      null,
      null,
      NEW_ADDR_ID,
    );

    expect(result?.hcpEstimateId).toBe(NEW_ESTIMATE_ID);
    // Verification confirmed the note landed (via the retry), so no scheduleError about notes.
    expect(result?.scheduleError ?? '').not.toContain('booker notes');
    expect(bookerCallCount).toBeGreaterThanOrEqual(2);
  });

  it('surfaces full booker-notes failure via the scheduleError channel when every retry AND verification fails', async () => {
    hcp.getLead.mockResolvedValue({ success: true, data: { id: HCP_LEAD } });
    hcp.addLeadNote.mockResolvedValue({ success: false, error: 'lead note failed' });
    hcp.convertLead.mockResolvedValue({
      success: true,
      data: { id: NEW_ESTIMATE_ID, address_id: NEW_ADDR_ID, options: [{ id: OPTION_ID }] },
    });
    hcp.updateEstimate.mockResolvedValue({ success: true, data: {} });
    hcp.getEstimate.mockResolvedValue({
      success: true,
      data: { id: NEW_ESTIMATE_ID, address_id: NEW_ADDR_ID, options: [{ id: OPTION_ID }] },
    });
    hcp.addEstimateNote.mockResolvedValue({ success: false, error: 'rate limited' });
    // Verification finds nothing.
    hcp.getEstimateNotes.mockResolvedValue({ success: true, data: [] });
    hcp.updateEstimateOptionSchedule.mockResolvedValue({ success: true, data: {} });

    const result = await createOrConvertHcpEstimate(
      TENANT,
      HCP_CUSTOMER,
      SALESPERSON,
      REQUEST,
      END_TIME,
      null,
      null,
      NEW_ADDR_ID,
    );

    expect(result?.hcpEstimateId).toBe(NEW_ESTIMATE_ID);
    expect(result?.scheduleError).toContain('note');
    expect(result?.scheduleError).toContain('booker notes');
    expect(result?.scheduleError).toContain('service address');
    // Sentinel token MUST be present so the public route can reliably
    // distinguish booker-note failure from service-address-only failure.
    expect(result?.scheduleError).toContain(BOOKER_NOTES_MISSING_TOKEN);

    // Verification fetch must have been called even when every POST failed.
    expect(hcp.getEstimateNotes).toHaveBeenCalledWith(TENANT, NEW_ESTIMATE_ID);
    // Verify retry actually happened (>1 call for the booker-notes POST).
    const bookerCalls = hcp.addEstimateNote.mock.calls.filter(
      (c) => typeof c[2] === 'string' && !c[2].startsWith('Service Address:'),
    );
    expect(bookerCalls.length).toBeGreaterThanOrEqual(2);
  });
});
