/**
 * Task #690 step 5: when the customer's HCP service-address record had to be
 * delete-and-recreated during sync (`serviceAddressRecreated=true`), any
 * existing HCP estimate may be dangling — it points at the now-deleted
 * `address_id`.
 *
 * The repin behavior is intentionally NARROW:
 *   - Reuse selection is governed by the normal 5-minute retry-dedup window
 *     ONLY. We do NOT widen reuse on the recreated flag, because that would
 *     mutate potentially old (approved/rejected/archived) estimates whenever
 *     a downstream booking happened to recreate a service-address record.
 *   - When an estimate IS already selected for reuse via the dedupe window,
 *     `serviceAddressRecreated=true` forces the `address_id` PATCH onto the
 *     new id even when HCP echoes the new id back already (defensive).
 *   - With the flag set but the estimate OUTSIDE the dedupe window, we fall
 *     through to creating a brand-new estimate (which gets the correct
 *     `serviceAddressId` on creation) and we DO NOT touch the old one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { hcp, dbState } = vi.hoisted(() => {
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
    // The `db.select().from(table).where(...).orderBy(...).limit(...)` chain in
    // hcp-estimate.ts hits two tables in sequence: `leads` first, then
    // `estimates`. Because `@shared/schema` is mocked to plain {} sentinels we
    // cannot distinguish them by reference — instead we count calls to
    // `from()` and return rows from the matching slot.
    dbState: {
      fromCallCount: 0,
      leadRows: [] as Array<Record<string, unknown>>,
      estimateRows: [] as Array<Record<string, unknown>>,
    },
  };
});

vi.mock('../db', () => ({
  db: {
    select: () => {
      return {
        from: () => {
          dbState.fromCallCount += 1;
          const isLeadCall = dbState.fromCallCount === 1;
          return {
            where: () => ({
              orderBy: () => ({
                limit: () =>
                  Promise.resolve(isLeadCall ? dbState.leadRows : dbState.estimateRows),
              }),
            }),
          };
        },
      };
    },
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

vi.mock('../utils/activity', () => ({
  createActivityAndBroadcast: vi.fn().mockResolvedValue(undefined),
}));

import { createOrConvertHcpEstimate } from '../scheduling/hcp-estimate';
import type { BookingRequest, SalespersonInfo } from '../types/scheduling';

const TENANT = 'tenant-1';
const HCP_CUSTOMER = 'cus_1';
const HCP_EMPLOYEE = 'emp_1';
const NEW_ADDR_ID = 'adr_new';
const EXISTING_ESTIMATE_ID = 'csr_existing';
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
  notes: 'New address for this booking',
  customerAddressComponents: {
    street: '123 New St',
    city: 'Salem',
    state: 'NH',
    zip: '03079',
    country: 'US',
  },
} as BookingRequest;

const END_TIME = new Date('2026-01-01T16:00:00Z');

beforeEach(() => {
  Object.values(hcp).forEach((fn) => fn.mockReset());
  dbState.fromCallCount = 0;
  dbState.leadRows = [];
  dbState.estimateRows = [];
});

describe('createOrConvertHcpEstimate — service-address recreated repin', () => {
  it('within dedup window + recreated=true: reuses + PATCHes the existing estimate with the new address_id', async () => {
    // Estimate created 1 minute ago — INSIDE the 5-minute dedup window, so
    // the normal reuse path fires. The recreated flag boosts the PATCH so
    // address_id is updated to the live record.
    const oneMinuteAgo = new Date(Date.now() - 60 * 1000);
    dbState.estimateRows = [
      {
        housecallProEstimateId: EXISTING_ESTIMATE_ID,
        createdAt: oneMinuteAgo,
      },
    ];

    // The estimate currently still references the OLD address id.
    hcp.getEstimate.mockResolvedValue({
      success: true,
      data: {
        id: EXISTING_ESTIMATE_ID,
        address_id: 'adr_OLD_DANGLING',
        address: { street: '100 Old Way', city: 'Boston', state: 'MA', zip: '02101' },
        options: [{ id: OPTION_ID, message: '' }],
      },
    });
    hcp.updateEstimate.mockResolvedValue({ success: true, data: {} });
    hcp.addEstimateNote.mockResolvedValue({ success: true, data: {} });
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
      '100 Old Way, Boston, MA 02101',
      { street: '100 Old Way', city: 'Boston', state: 'MA', zip: '02101' },
      NEW_ADDR_ID,
      true, // serviceAddressRecreated
    );

    expect(result?.hcpEstimateId).toBe(EXISTING_ESTIMATE_ID);
    expect(hcp.createEstimate).not.toHaveBeenCalled();
    expect(hcp.convertLead).not.toHaveBeenCalled();

    expect(hcp.updateEstimate).toHaveBeenCalled();
    const patchPayload = hcp.updateEstimate.mock.calls[0][2];
    expect(patchPayload.address_id).toBe(NEW_ADDR_ID);
    expect(patchPayload.address?.street).toBe('123 New St');
    expect(patchPayload.address?.city).toBe('Salem');
    expect(patchPayload.address?.state).toBe('NH');
    expect(patchPayload.address?.zip).toBe('03079');
  });

  it('within dedup window + recreated=true: FORCES the address_id PATCH even when HCP echoes the new id back (defensive)', async () => {
    // Edge case: HCP's getEstimate returns the new address_id already (HCP
    // may have eagerly updated some pointer, or another in-flight write
    // might have raced ahead). The estimate could still be pinned to the
    // deleted record server-side. When recreated=true, we must force the
    // PATCH to ensure HCP's estimate is unambiguously pinned to the live row.
    const oneMinuteAgo = new Date(Date.now() - 60 * 1000);
    dbState.estimateRows = [
      {
        housecallProEstimateId: EXISTING_ESTIMATE_ID,
        createdAt: oneMinuteAgo,
      },
    ];

    hcp.getEstimate.mockResolvedValue({
      success: true,
      data: {
        id: EXISTING_ESTIMATE_ID,
        // HCP already shows the new id — but we don't trust this state.
        address_id: NEW_ADDR_ID,
        options: [{ id: OPTION_ID, message: '' }],
      },
    });
    hcp.updateEstimate.mockResolvedValue({ success: true, data: {} });
    hcp.addEstimateNote.mockResolvedValue({ success: true, data: {} });
    hcp.getEstimateNotes.mockResolvedValue({
      success: true,
      data: [{ id: 'n1', content: REQUEST.notes! }],
    });
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
      true, // serviceAddressRecreated
    );

    expect(hcp.updateEstimate).toHaveBeenCalled();
    const patchPayload = hcp.updateEstimate.mock.calls[0][2];
    // Forced even though the read showed an already-matching id.
    expect(patchPayload.address_id).toBe(NEW_ADDR_ID);
  });

  it('OUTSIDE dedup window + recreated=true: creates a brand-new estimate and does NOT mutate the old one (regression guard)', async () => {
    // Estimate created an hour ago — OUTSIDE the 5-minute retry-dedup window.
    // Even with the recreated flag set, we MUST NOT reuse + mutate this old
    // estimate (it could be approved, rejected, archived). Instead, fall
    // through to creating a fresh estimate that will be pinned to the new
    // serviceAddressId on creation. The old estimate stays untouched.
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    dbState.estimateRows = [
      {
        housecallProEstimateId: EXISTING_ESTIMATE_ID,
        createdAt: oneHourAgo,
      },
    ];

    hcp.createEstimate.mockResolvedValue({
      success: true,
      data: { id: 'csr_brand_new', address_id: NEW_ADDR_ID, options: [{ id: OPTION_ID }] },
    });
    hcp.getEstimate.mockResolvedValue({
      success: true,
      data: { id: 'csr_brand_new', address_id: NEW_ADDR_ID, options: [{ id: OPTION_ID }] },
    });
    hcp.addEstimateNote.mockResolvedValue({ success: true, data: {} });
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
      true, // serviceAddressRecreated — must NOT trigger reuse outside the window
    );

    expect(result?.hcpEstimateId).toBe('csr_brand_new');
    expect(hcp.createEstimate).toHaveBeenCalledTimes(1);
    // The old (potentially approved/rejected/archived) estimate must NOT
    // have been mutated.
    expect(hcp.updateEstimate).not.toHaveBeenCalled();
  });

  it('OUTSIDE dedup window + recreated=false: also creates a brand-new estimate (baseline)', async () => {
    // Pin the no-flag baseline so the recreated-flag fix doesn't accidentally
    // change the no-flag case.
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    dbState.estimateRows = [
      {
        housecallProEstimateId: EXISTING_ESTIMATE_ID,
        createdAt: oneHourAgo,
      },
    ];

    hcp.createEstimate.mockResolvedValue({
      success: true,
      data: { id: 'csr_brand_new', address_id: NEW_ADDR_ID, options: [{ id: OPTION_ID }] },
    });
    hcp.getEstimate.mockResolvedValue({
      success: true,
      data: { id: 'csr_brand_new', address_id: NEW_ADDR_ID, options: [{ id: OPTION_ID }] },
    });
    hcp.addEstimateNote.mockResolvedValue({ success: true, data: {} });
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
      false, // serviceAddressRecreated
    );

    expect(result?.hcpEstimateId).toBe('csr_brand_new');
    expect(hcp.createEstimate).toHaveBeenCalledTimes(1);
    expect(hcp.updateEstimate).not.toHaveBeenCalled();
  });
});
