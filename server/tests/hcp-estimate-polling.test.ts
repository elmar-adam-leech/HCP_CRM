import { describe, it, expect, vi, beforeEach } from 'vitest';

interface FakeEstimate {
  id: string;
  status: 'sent' | 'scheduled' | 'in_progress' | 'approved' | 'rejected';
  statusManuallySet: boolean;
  housecallProEstimateId: string;
  housecallProCustomerId: string | null;
}
interface UpdatePayload {
  status?: FakeEstimate['status'];
  [key: string]: unknown;
}

const TENANT = 'tenant-1';

const updateEstimate = vi.fn<(id: string, data: UpdatePayload, c: string) => Promise<UpdatePayload & { id: string }>>();
const getEstimatesByHousecallProIds = vi.fn<(ids: string[], c: string) => Promise<Map<string, FakeEstimate>>>();
const getContactsByHousecallProCustomerIds = vi.fn().mockResolvedValue(new Map());
const getHousecallProSyncStartDate = vi.fn().mockResolvedValue(null);
const getEstimates = vi.fn();

vi.mock('../storage', () => ({
  storage: {
    getEstimatesByHousecallProIds: (ids: string[], c: string) => getEstimatesByHousecallProIds(ids, c),
    getContactsByHousecallProCustomerIds: (ids: string[], c: string) => getContactsByHousecallProCustomerIds(ids, c),
    getHousecallProSyncStartDate: (c: string) => getHousecallProSyncStartDate(c),
    updateEstimate: (id: string, d: UpdatePayload, c: string) => updateEstimate(id, d, c),
  },
}));
vi.mock('../db', () => ({ db: {} }));
vi.mock('../hcp/index', () => ({
  housecallProService: { getEstimates: (c: string, p: unknown) => getEstimates(c, p) },
}));
vi.mock('../sync/hcp-contact-helpers', () => ({
  resolveHcpContact: vi.fn().mockResolvedValue(null),
  convertEstimateToJob: vi.fn().mockResolvedValue(undefined),
  isExcludedResult: () => false,
}));
vi.mock('../utils/logger', () => ({ logger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }) }));
vi.mock('../utils/phone-normalizer', () => ({ normalizePhoneArrayForStorage: (p: unknown) => p }));
vi.mock('../utils/address', () => ({ buildFormattedAddress: () => '' }));
vi.mock('../utils/batch', () => ({ splitIntoBatches: <T,>(arr: T[]) => [arr] }));

import { syncHousecallProEstimates } from '../sync/hcp-estimates';

beforeEach(() => {
  vi.resetAllMocks();
  updateEstimate.mockImplementation(async (id, data) => ({ id, ...data }));
  getContactsByHousecallProCustomerIds.mockResolvedValue(new Map());
  getHousecallProSyncStartDate.mockResolvedValue(null);
});

function hcpPayload(id: string, work_status: string) {
  return {
    id,
    customer: { id: `cust-${id}` },
    work_status,
    description: '',
    options: [],
  };
}

describe('polling sync integration: status merge protections', () => {
  it('does not downgrade an existing approved estimate when HCP returns scheduled', async () => {
    getEstimates
      .mockResolvedValueOnce({ success: true, data: [hcpPayload('hcp-1', 'scheduled')] })
      .mockResolvedValueOnce({ success: true, data: [] });
    getEstimatesByHousecallProIds.mockResolvedValue(
      new Map([['hcp-1', { id: 'e1', status: 'approved', statusManuallySet: false, housecallProEstimateId: 'hcp-1', housecallProCustomerId: 'cust-hcp-1' }]]),
    );

    await syncHousecallProEstimates(TENANT);

    expect(updateEstimate).toHaveBeenCalledTimes(1);
    expect(updateEstimate.mock.calls[0][1].status).toBe('approved');
  });

  it('preserves a manually-set "in_progress" estimate when HCP returns scheduled', async () => {
    getEstimates
      .mockResolvedValueOnce({ success: true, data: [hcpPayload('hcp-2', 'scheduled')] })
      .mockResolvedValueOnce({ success: true, data: [] });
    getEstimatesByHousecallProIds.mockResolvedValue(
      new Map([['hcp-2', { id: 'e2', status: 'in_progress', statusManuallySet: true, housecallProEstimateId: 'hcp-2', housecallProCustomerId: 'cust-hcp-2' }]]),
    );

    await syncHousecallProEstimates(TENANT);

    expect(updateEstimate.mock.calls[0][1].status).toBe('in_progress');
  });

  it('still applies terminal "rejected" from HCP even when statusManuallySet=true', async () => {
    getEstimates
      .mockResolvedValueOnce({ success: true, data: [hcpPayload('hcp-3', 'cancelled')] })
      .mockResolvedValueOnce({ success: true, data: [] });
    getEstimatesByHousecallProIds.mockResolvedValue(
      new Map([['hcp-3', { id: 'e3', status: 'in_progress', statusManuallySet: true, housecallProEstimateId: 'hcp-3', housecallProCustomerId: 'cust-hcp-3' }]]),
    );

    await syncHousecallProEstimates(TENANT);

    expect(updateEstimate.mock.calls[0][1].status).toBe('rejected');
  });
});
