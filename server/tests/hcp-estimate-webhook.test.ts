import { describe, it, expect, vi, beforeEach } from 'vitest';

interface FakeEstimate {
  id: string;
  status: 'sent' | 'scheduled' | 'in_progress' | 'approved' | 'rejected';
  statusManuallySet: boolean;
}
interface UpdatePayload {
  status?: FakeEstimate['status'];
  [key: string]: unknown;
}
interface HcpFetchResult {
  success: boolean;
  data?: Record<string, unknown>;
}

const updateEstimate = vi.fn<(id: string, data: UpdatePayload, contractorId: string) => Promise<UpdatePayload & { id: string }>>();
const getEstimateByHousecallProEstimateId = vi.fn<(hcpId: string, contractorId: string) => Promise<FakeEstimate | undefined>>();
const getEstimate = vi.fn<(contractorId: string, hcpId: string) => Promise<HcpFetchResult>>();
const broadcastToContractor = vi.fn();
const triggerWorkflowsForEvent = vi.fn().mockResolvedValue(undefined);

vi.mock('../storage', () => ({
  storage: {
    getEstimateByHousecallProEstimateId: (id: string, c: string) => getEstimateByHousecallProEstimateId(id, c),
    updateEstimate: (id: string, d: UpdatePayload, c: string) => updateEstimate(id, d, c),
    getJobByHousecallProJobId: vi.fn(),
    isHcpCustomerExcluded: vi.fn().mockResolvedValue(false),
  },
}));
vi.mock('../db', () => ({ db: { update: () => ({ set: () => ({ where: vi.fn() }) }) } }));
vi.mock('../websocket', () => ({ broadcastToContractor: (cid: string, msg: unknown) => broadcastToContractor(cid, msg) }));
vi.mock('../workflow-engine', () => ({
  workflowEngine: { triggerWorkflowsForEvent: (e: string, ev: unknown, c: string) => triggerWorkflowsForEvent(e, ev, c) },
}));
vi.mock('../hcp/index', () => ({
  housecallProService: { getEstimate: (c: string, id: string) => getEstimate(c, id) },
}));
vi.mock('../utils/workflow/entity-adapter', () => ({ toWorkflowEvent: (e: unknown) => e }));
vi.mock('../utils/logger', () => ({ logger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }) }));

import { handleEstimateEvent } from '../routes/webhooks/housecall-pro/handlers/estimates';

const CONTRACTOR = 'tenant-1';

beforeEach(() => {
  vi.clearAllMocks();
  updateEstimate.mockImplementation(async (id, data) => ({ id, ...data }));
});

describe('webhook merge with manual override', () => {
  it('estimate.updated: preserves manually-set status when HCP reports scheduled', async () => {
    getEstimateByHousecallProEstimateId.mockResolvedValue({
      id: 'e1', status: 'in_progress', statusManuallySet: true,
    });
    getEstimate.mockResolvedValue({ success: true, data: { id: 'hcp1', work_status: 'scheduled' } });

    await handleEstimateEvent(CONTRACTOR, 'estimate.updated', { id: 'hcp1' }, undefined);

    expect(updateEstimate).toHaveBeenCalledTimes(1);
    expect(updateEstimate.mock.calls[0][1].status).toBe('in_progress');
  });

  it('estimate.updated: terminal rejected from HCP overrides a manual override', async () => {
    getEstimateByHousecallProEstimateId.mockResolvedValue({
      id: 'e1', status: 'approved', statusManuallySet: true,
    });
    getEstimate.mockResolvedValue({ success: true, data: { id: 'hcp1', work_status: 'cancelled' } });

    await handleEstimateEvent(CONTRACTOR, 'estimate.updated', { id: 'hcp1' }, undefined);

    expect(updateEstimate.mock.calls[0][1].status).toBe('rejected');
  });

  it('estimate.scheduled: does not downgrade an advanced status', async () => {
    getEstimateByHousecallProEstimateId.mockResolvedValue({
      id: 'e1', status: 'sent', statusManuallySet: false,
    });
    getEstimate.mockResolvedValue({ success: false });

    await handleEstimateEvent(CONTRACTOR, 'estimate.scheduled', { id: 'hcp1' }, undefined);

    expect(updateEstimate.mock.calls[0][1].status).toBe('sent');
  });

  it('estimate.option.approval_status_changed: approved goes through resolver and respects manual flag', async () => {
    getEstimateByHousecallProEstimateId.mockResolvedValue({
      id: 'e1', status: 'in_progress', statusManuallySet: true,
    });
    getEstimate.mockResolvedValue({ success: true, data: { id: 'hcp1', options: [{ approval_status: 'approved' }] } });

    await handleEstimateEvent(
      CONTRACTOR,
      'estimate.option.approval_status_changed',
      { estimate_id: 'hcp1', approval_status: 'approved' },
      undefined,
    );

    expect(updateEstimate.mock.calls[0][1].status).toBe('in_progress');
  });

  it('estimate.option.approval_status_changed: "pro declined" payload flips to rejected', async () => {
    getEstimateByHousecallProEstimateId.mockResolvedValue({
      id: 'e1', status: 'scheduled', statusManuallySet: false,
    });
    // Fetched estimate has the same "pro declined" option HCP just told us about.
    getEstimate.mockResolvedValue({ success: true, data: { id: 'hcp1', options: [{ approval_status: 'pro declined' }] } });

    await handleEstimateEvent(
      CONTRACTOR,
      'estimate.option.approval_status_changed',
      { estimate_id: 'hcp1', approval_status: 'pro declined' },
      undefined,
    );

    expect(updateEstimate.mock.calls[0][1].status).toBe('rejected');
  });

  it('estimate.option.approval_status_changed: "pro declined" wins even when local status is manually set', async () => {
    getEstimateByHousecallProEstimateId.mockResolvedValue({
      id: 'e1', status: 'in_progress', statusManuallySet: true,
    });
    getEstimate.mockResolvedValue({ success: true, data: { id: 'hcp1', options: [{ approval_status: 'pro declined' }] } });

    await handleEstimateEvent(
      CONTRACTOR,
      'estimate.option.approval_status_changed',
      { estimate_id: 'hcp1', approval_status: 'pro declined' },
      undefined,
    );

    expect(updateEstimate.mock.calls[0][1].status).toBe('rejected');
  });

  it('estimate.option.approval_status_changed: rejected always wins, even with manual flag', async () => {
    getEstimateByHousecallProEstimateId.mockResolvedValue({
      id: 'e1', status: 'in_progress', statusManuallySet: true,
    });
    getEstimate.mockResolvedValue({ success: true, data: { id: 'hcp1', options: [{ approval_status: 'rejected' }] } });

    await handleEstimateEvent(
      CONTRACTOR,
      'estimate.option.approval_status_changed',
      { estimate_id: 'hcp1', approval_status: 'rejected' },
      undefined,
    );

    expect(updateEstimate.mock.calls[0][1].status).toBe('rejected');
  });

  it('estimate.option.approval_status_changed without fetched data: rejected wins, approved respects manual', async () => {
    getEstimateByHousecallProEstimateId.mockResolvedValue({
      id: 'e1', status: 'in_progress', statusManuallySet: true,
    });
    getEstimate.mockResolvedValue({ success: false });

    await handleEstimateEvent(
      CONTRACTOR,
      'estimate.option.approval_status_changed',
      { estimate_id: 'hcp1', approval_status: 'approved' },
      undefined,
    );
    expect(updateEstimate.mock.calls[0][1].status).toBe('in_progress');

    updateEstimate.mockClear();
    await handleEstimateEvent(
      CONTRACTOR,
      'estimate.option.approval_status_changed',
      { estimate_id: 'hcp1', approval_status: 'rejected' },
      undefined,
    );
    expect(updateEstimate.mock.calls[0][1].status).toBe('rejected');
  });

  it('estimate.on_my_way: respects manual override (does not flip to in_progress)', async () => {
    getEstimateByHousecallProEstimateId.mockResolvedValue({
      id: 'e1', status: 'sent', statusManuallySet: true,
    });

    await handleEstimateEvent(CONTRACTOR, 'estimate.on_my_way', { id: 'hcp1' }, undefined);

    expect(updateEstimate.mock.calls[0][1].status).toBe('sent');
  });
});
