import { describe, it, expect, vi, beforeEach } from 'vitest';

interface FakeJob {
  id: string;
  status: 'scheduled' | 'in_progress' | 'completed' | 'cancelled';
  contactId: string;
}

interface UpdatePayload {
  status?: FakeJob['status'];
  paidAmount?: string | null;
  paymentMethod?: string | null;
  paidAt?: Date | null;
  isDeposit?: boolean | null;
  [key: string]: unknown;
}

interface HcpJobFetchResult {
  success: boolean;
  data?: Record<string, unknown>;
}

const updateJob = vi.fn<(id: string, data: UpdatePayload, contractorId: string) => Promise<UpdatePayload & { id: string; contactId: string }>>();
const getJobByHousecallProJobId = vi.fn<(hcpId: string, contractorId: string) => Promise<FakeJob | undefined>>();
const getJob = vi.fn<(hcpId: string, contractorId: string) => Promise<HcpJobFetchResult>>();
const getContact = vi.fn();
const updateContact = vi.fn();
const broadcastToContractor = vi.fn();
const triggerWorkflowsForEvent = vi.fn().mockResolvedValue(undefined);

vi.mock('../storage', () => ({
  storage: {
    getJobByHousecallProJobId: (id: string, c: string) => getJobByHousecallProJobId(id, c),
    updateJob: (id: string, d: UpdatePayload, c: string) => updateJob(id, d, c),
    getContact: (...a: any[]) => getContact(...a),
    updateContact: (...a: any[]) => updateContact(...a),
  },
}));
vi.mock('../db', () => ({ db: {} }));
vi.mock('../websocket', () => ({ broadcastToContractor: (cid: string, msg: unknown) => broadcastToContractor(cid, msg) }));
vi.mock('../workflow-engine', () => ({
  workflowEngine: { triggerWorkflowsForEvent: (e: string, ev: unknown, c: string) => triggerWorkflowsForEvent(e, ev, c) },
}));
vi.mock('../hcp/index', () => ({
  housecallProService: { getJob: (id: string, c: string) => getJob(id, c) },
}));
vi.mock('../utils/workflow/entity-adapter', () => ({ toWorkflowEvent: (e: unknown) => e }));
vi.mock('../utils/logger', () => ({ logger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }) }));
// resolveSalespersonForHcpEntity reads from db; stub it out so the handler
// flow doesn't need a real database connection in this integration test.
vi.mock('../sync/hcp-mappers', async (orig) => {
  const actual: any = await orig();
  return { ...actual, resolveSalespersonForHcpEntity: vi.fn().mockResolvedValue(null) };
});

import { handleJobEvent } from '../routes/webhooks/housecall-pro/handlers/jobs';

const CONTRACTOR = 'tenant-1';

beforeEach(() => {
  vi.clearAllMocks();
  updateJob.mockImplementation(async (id, data) => ({ id, contactId: 'c1', ...data }));
  getJobByHousecallProJobId.mockResolvedValue({ id: 'job1', status: 'in_progress', contactId: 'c1' });
});

describe('job.paid webhook integration', () => {
  it('writes the latest payment from a multi-payment array onto the job row', async () => {
    getJob.mockResolvedValue({
      success: true,
      data: {
        id: 'hcp1',
        work_status: 'completed',
        total_amount: 50000,
        payments: [
          { id: 'p1', amount: 10000, payment_method: 'card', is_deposit: true, created_at: '2026-04-01T00:00:00.000Z' },
          { id: 'p2', amount: 40000, payment_method: 'check', is_deposit: false, created_at: '2026-04-15T00:00:00.000Z' },
        ],
      },
    });

    await handleJobEvent(CONTRACTOR, 'job.paid', { id: 'hcp1' }, undefined);

    expect(updateJob).toHaveBeenCalledTimes(1);
    const update = updateJob.mock.calls[0][1];
    expect(update.paidAmount).toBe('400.00');
    expect(update.paymentMethod).toBe('check');
    expect(update.isDeposit).toBe(false);
    expect((update.paidAt as Date).toISOString()).toBe('2026-04-15T00:00:00.000Z');
  });

  it('a later (balance) job.paid webhook overwrites the earlier (deposit) row', async () => {
    // Deposit first
    getJob.mockResolvedValueOnce({
      success: true,
      data: {
        id: 'hcp1',
        work_status: 'in_progress',
        total_amount: 50000,
        payments: [
          { id: 'p1', amount: 10000, payment_method: 'card', is_deposit: true, created_at: '2026-04-01T00:00:00.000Z' },
        ],
      },
    });
    await handleJobEvent(CONTRACTOR, 'job.paid', { id: 'hcp1' }, undefined);
    const first = updateJob.mock.calls[0][1];
    expect(first.paidAmount).toBe('100.00');
    expect(first.isDeposit).toBe(true);

    // Balance afterwards — both payments now in the array, latest by created_at wins
    getJob.mockResolvedValueOnce({
      success: true,
      data: {
        id: 'hcp1',
        work_status: 'completed',
        total_amount: 50000,
        payments: [
          { id: 'p1', amount: 10000, payment_method: 'card', is_deposit: true, created_at: '2026-04-01T00:00:00.000Z' },
          { id: 'p2', amount: 40000, payment_method: 'ach', is_deposit: false, created_at: '2026-04-20T00:00:00.000Z' },
        ],
      },
    });
    await handleJobEvent(CONTRACTOR, 'job.paid', { id: 'hcp1' }, undefined);
    const second = updateJob.mock.calls[1][1];
    expect(second.paidAmount).toBe('400.00');
    expect(second.paymentMethod).toBe('ach');
    expect(second.isDeposit).toBe(false);
  });

  it('skips payment fields entirely when the payments array is empty', async () => {
    getJob.mockResolvedValue({
      success: true,
      data: { id: 'hcp1', work_status: 'in_progress', total_amount: 0, payments: [] },
    });
    await handleJobEvent(CONTRACTOR, 'job.paid', { id: 'hcp1' }, undefined);
    const update = updateJob.mock.calls[0][1];
    expect(update.paidAmount).toBeUndefined();
    expect(update.paymentMethod).toBeUndefined();
    expect(update.paidAt).toBeUndefined();
    expect(update.isDeposit).toBeUndefined();
  });
});
