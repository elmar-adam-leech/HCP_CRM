import { describe, it, expect, vi, beforeEach } from 'vitest';

interface FakeEstimate {
  id: string;
  status: 'sent' | 'scheduled' | 'in_progress' | 'approved' | 'rejected';
  statusManuallySet: boolean;
  documentSentAt?: Date | null;
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

  it('estimate.option.approval_status_changed: ALL declined → parent flips to rejected', async () => {
    getEstimateByHousecallProEstimateId.mockResolvedValue({
      id: 'e1', status: 'scheduled', statusManuallySet: false,
    });
    // Every option on the freshly fetched estimate is declined → parent rejected.
    getEstimate.mockResolvedValue({ success: true, data: { id: 'hcp1', options: [
      { approval_status: 'pro declined' },
      { approval_status: 'customer declined' },
    ] } });

    await handleEstimateEvent(
      CONTRACTOR,
      'estimate.option.approval_status_changed',
      { estimate_id: 'hcp1', approval_status: 'pro declined' },
      undefined,
    );

    expect(updateEstimate.mock.calls[0][1].status).toBe('rejected');
  });

  it('estimate.option.approval_status_changed: declined option but ANOTHER option approved → parent stays approved (not rejected)', async () => {
    // Task #484 regression: previously the inbound 'pro declined' single-option
    // signal would force the parent to 'rejected' even though the freshly
    // fetched estimate still had an approved option. Now we re-derive parent
    // from the full options array, so 'any approved wins' correctly applies.
    getEstimateByHousecallProEstimateId.mockResolvedValue({
      id: 'e1', status: 'approved', statusManuallySet: false,
    });
    getEstimate.mockResolvedValue({ success: true, data: { id: 'hcp1', options: [
      { approval_status: 'pro declined' },
      { approval_status: 'approved' },
    ] } });

    await handleEstimateEvent(
      CONTRACTOR,
      'estimate.option.approval_status_changed',
      { estimate_id: 'hcp1', approval_status: 'pro declined' },
      undefined,
    );

    expect(updateEstimate.mock.calls[0][1].status).toBe('approved');
  });

  it('estimate.option.approval_status_changed: declined option + others awaiting → parent stays at active status, NOT rejected', async () => {
    getEstimateByHousecallProEstimateId.mockResolvedValue({
      id: 'e1', status: 'sent', statusManuallySet: false,
    });
    // Top-level work_status='sent' so the mapper falls through to 'sent';
    // crucially it does NOT return 'rejected' just because one option declined.
    getEstimate.mockResolvedValue({ success: true, data: { id: 'hcp1', work_status: 'sent', options: [
      { approval_status: 'pro declined' },
      { approval_status: 'awaiting response' },
      { approval_status: 'awaiting response' },
      { approval_status: 'awaiting response' },
    ] } });

    await handleEstimateEvent(
      CONTRACTOR,
      'estimate.option.approval_status_changed',
      { estimate_id: 'hcp1', approval_status: 'pro declined' },
      undefined,
    );

    expect(updateEstimate.mock.calls[0][1].status).toBe('sent');
  });

  it('estimate.option.approval_status_changed: manual override + mixed declined+approved → manual value wins (mapper returns approved, manual respected)', async () => {
    getEstimateByHousecallProEstimateId.mockResolvedValue({
      id: 'e1', status: 'in_progress', statusManuallySet: true,
    });
    getEstimate.mockResolvedValue({ success: true, data: { id: 'hcp1', options: [
      { approval_status: 'pro declined' },
      { approval_status: 'approved' },
    ] } });

    await handleEstimateEvent(
      CONTRACTOR,
      'estimate.option.approval_status_changed',
      { estimate_id: 'hcp1', approval_status: 'pro declined' },
      undefined,
    );

    // Mapped is 'approved' (not 'rejected'), so the manual flag preserves the
    // local in_progress value per resolveHcpEstimateStatus rule 2.
    expect(updateEstimate.mock.calls[0][1].status).toBe('in_progress');
  });

  it('estimate.option.approval_status_changed: ALL declined wins even with manual flag (rejected is terminal)', async () => {
    getEstimateByHousecallProEstimateId.mockResolvedValue({
      id: 'e1', status: 'in_progress', statusManuallySet: true,
    });
    getEstimate.mockResolvedValue({ success: true, data: { id: 'hcp1', options: [
      { approval_status: 'pro declined' },
      { approval_status: 'customer declined' },
    ] } });

    await handleEstimateEvent(
      CONTRACTOR,
      'estimate.option.approval_status_changed',
      { estimate_id: 'hcp1', approval_status: 'pro declined' },
      undefined,
    );

    expect(updateEstimate.mock.calls[0][1].status).toBe('rejected');
  });

  it('estimate.option.approval_status_changed without fetched data: parent status untouched', async () => {
    // No way to safely infer parent state from a single-option signal alone.
    // We only persist syncedAt; the per-option workflow trigger still fires
    // separately so workflow authors aren't blocked.
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
    // updateEstimate is gated on updateData.status — without it the row is not
    // updated at all. Verify nothing was written.
    expect(updateEstimate).not.toHaveBeenCalled();

    updateEstimate.mockClear();
    await handleEstimateEvent(
      CONTRACTOR,
      'estimate.option.approval_status_changed',
      { estimate_id: 'hcp1', approval_status: 'rejected' },
      undefined,
    );
    expect(updateEstimate).not.toHaveBeenCalled();
  });

  // ---- Task #721: documentSentAt (document-sent lifecycle) ----

  it('estimate.sent: stamps documentSentAt when previously null', async () => {
    getEstimateByHousecallProEstimateId.mockResolvedValue({
      id: 'e1', status: 'in_progress', statusManuallySet: false, documentSentAt: null,
    });
    getEstimate.mockResolvedValue({ success: true, data: { id: 'hcp1', work_status: 'unscheduled' } });

    const occurredAt = new Date('2025-06-01T12:00:00Z');
    await handleEstimateEvent(CONTRACTOR, 'estimate.sent', { id: 'hcp1' }, occurredAt);

    expect(updateEstimate.mock.calls[0][1].documentSentAt).toBeInstanceOf(Date);
  });

  it('estimate.sent: does NOT overwrite an existing documentSentAt (sticky)', async () => {
    const original = new Date('2025-01-01T00:00:00Z');
    getEstimateByHousecallProEstimateId.mockResolvedValue({
      id: 'e1', status: 'in_progress', statusManuallySet: false, documentSentAt: original,
    });
    getEstimate.mockResolvedValue({ success: true, data: { id: 'hcp1', work_status: 'unscheduled' } });

    await handleEstimateEvent(CONTRACTOR, 'estimate.sent', { id: 'hcp1' }, new Date('2025-06-01T12:00:00Z'));

    expect(updateEstimate.mock.calls[0][1].documentSentAt).toBeUndefined();
  });

  it('estimate.updated: stamps documentSentAt when source carries sent_at and stamp was null', async () => {
    getEstimateByHousecallProEstimateId.mockResolvedValue({
      id: 'e1', status: 'sent', statusManuallySet: false, documentSentAt: null,
    });
    getEstimate.mockResolvedValue({ success: true, data: { id: 'hcp1', work_status: 'unscheduled', sent_at: '2025-05-15T08:00:00Z' } });

    await handleEstimateEvent(CONTRACTOR, 'estimate.updated', { id: 'hcp1' }, undefined);

    const stamped = updateEstimate.mock.calls[0][1].documentSentAt as Date;
    expect(stamped).toBeInstanceOf(Date);
    expect(stamped.toISOString()).toBe('2025-05-15T08:00:00.000Z');
  });

  it('estimate.updated: does NOT touch documentSentAt once set (sticky across later transitions)', async () => {
    const original = new Date('2025-01-01T00:00:00Z');
    getEstimateByHousecallProEstimateId.mockResolvedValue({
      id: 'e1', status: 'sent', statusManuallySet: false, documentSentAt: original,
    });
    // Source no longer reports sent state — but stamp must remain.
    getEstimate.mockResolvedValue({ success: true, data: { id: 'hcp1', work_status: 'in progress' } });

    await handleEstimateEvent(CONTRACTOR, 'estimate.updated', { id: 'hcp1' }, undefined);

    expect(updateEstimate.mock.calls[0][1].documentSentAt).toBeUndefined();
  });

  it('estimate.on_my_way: respects manual override (does not flip to in_progress)', async () => {
    getEstimateByHousecallProEstimateId.mockResolvedValue({
      id: 'e1', status: 'sent', statusManuallySet: true,
    });

    await handleEstimateEvent(CONTRACTOR, 'estimate.on_my_way', { id: 'hcp1' }, undefined);

    expect(updateEstimate.mock.calls[0][1].status).toBe('sent');
  });
});
