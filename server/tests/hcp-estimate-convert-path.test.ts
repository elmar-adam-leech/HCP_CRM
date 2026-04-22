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
      getLead: vi.fn(),
      patchLead: vi.fn(),
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

import { createOrConvertHcpEstimate } from '../scheduling/hcp-estimate';
import type { BookingRequest, SalespersonInfo } from '../types/scheduling';

const TENANT = 'tenant-1';
const HCP_CUSTOMER = 'cus_1';
const HCP_LEAD = 'lead_1';
const HCP_EMPLOYEE = 'emp_1';
const NEW_ADDR_ID = 'adr_new';
const LEGACY_ADDR_ID = 'adr_legacy';
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
  it('PATCHes the HCP lead address_id BEFORE convertLead, then sends booker notes via awaited addEstimateNote', async () => {
    // Lead currently bound to legacy address.
    hcp.getLead.mockResolvedValue({
      success: true,
      data: { id: HCP_LEAD, address_id: LEGACY_ADDR_ID },
    });
    hcp.patchLead.mockResolvedValue({ success: true, data: {} });
    hcp.convertLead.mockResolvedValue({
      success: true,
      data: {
        id: NEW_ESTIMATE_ID,
        address_id: NEW_ADDR_ID,
        options: [{ id: OPTION_ID, message: '' }],
      },
    });
    hcp.updateEstimate.mockResolvedValue({ success: true, data: {} });
    // Verify re-fetch after PATCH confirms new address pinned.
    hcp.getEstimate.mockResolvedValue({
      success: true,
      data: { id: NEW_ESTIMATE_ID, address_id: NEW_ADDR_ID, options: [{ id: OPTION_ID }] },
    });
    hcp.addEstimateNote.mockResolvedValue({ success: true, data: {} });
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

    // Lead PATCH happened with new address_id.
    expect(hcp.patchLead).toHaveBeenCalledTimes(1);
    expect(hcp.patchLead).toHaveBeenCalledWith(TENANT, HCP_LEAD, { address_id: NEW_ADDR_ID });

    // Lead PATCH happened BEFORE convertLead.
    const patchOrder = hcp.patchLead.mock.invocationCallOrder[0];
    const convertOrder = hcp.convertLead.mock.invocationCallOrder[0];
    expect(patchOrder).toBeLessThan(convertOrder);

    // Booker notes sent verbatim via addEstimateNote.
    const noteContents = hcp.addEstimateNote.mock.calls.map((c) => c[2]);
    expect(noteContents).toContain(REQUEST.notes);

    // Service Address note also included.
    expect(noteContents.some((n) => typeof n === 'string' && n.startsWith('Service Address:'))).toBe(true);

    // Update payload to back-fill message includes booker notes.
    const updateCall = hcp.updateEstimate.mock.calls[0];
    expect(updateCall[2].message).toContain(REQUEST.notes!);
    expect(updateCall[2].address_id).toBe(NEW_ADDR_ID);
    expect(updateCall[2].address?.street).toBe('29 Far Corners Loop');
  });

  it('skips lead PATCH when the lead is already bound to the right address', async () => {
    hcp.getLead.mockResolvedValue({
      success: true,
      data: { id: HCP_LEAD, address_id: NEW_ADDR_ID },
    });
    hcp.convertLead.mockResolvedValue({
      success: true,
      data: { id: NEW_ESTIMATE_ID, address_id: NEW_ADDR_ID, options: [{ id: OPTION_ID }] },
    });
    hcp.updateEstimate.mockResolvedValue({ success: true, data: {} });
    hcp.getEstimate.mockResolvedValue({
      success: true,
      data: { id: NEW_ESTIMATE_ID, address_id: NEW_ADDR_ID, options: [{ id: OPTION_ID }] },
    });
    hcp.addEstimateNote.mockResolvedValue({ success: true, data: {} });
    hcp.updateEstimateOptionSchedule.mockResolvedValue({ success: true, data: {} });

    await createOrConvertHcpEstimate(
      TENANT,
      HCP_CUSTOMER,
      SALESPERSON,
      REQUEST,
      END_TIME,
      null,
      null,
      NEW_ADDR_ID,
    );

    expect(hcp.patchLead).not.toHaveBeenCalled();
    expect(hcp.convertLead).toHaveBeenCalledTimes(1);
  });

  it('surfaces note-add failures via the scheduleError channel', async () => {
    hcp.getLead.mockResolvedValue({ success: true, data: { id: HCP_LEAD } });
    hcp.patchLead.mockResolvedValue({ success: true, data: {} });
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
  });
});
