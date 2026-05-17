import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({ db: { select: vi.fn() } }));

vi.mock('../storage', () => ({
  storage: {
    getEstimateByHousecallProEstimateId: vi.fn(),
    getJobByHousecallProJobId: vi.fn(),
  },
}));

vi.mock('../hcp/index', () => ({
  housecallProService: {
    getEstimates: vi.fn(),
    getJobs: vi.fn(),
  },
}));

vi.mock('../routes/webhooks/housecall-pro/dispatch', () => ({
  processHcpEvent: vi.fn().mockResolvedValue(undefined),
}));

import { storage } from '../storage';
import { housecallProService } from '../hcp/index';
import { processHcpEvent } from '../routes/webhooks/housecall-pro/dispatch';
import { runHcpWebhookBackfill, summarizeBackfill } from '../sync/hcp-backfill';

describe('runHcpWebhookBackfill detects local existence and emits *.created vs *.updated', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('replays a brand-new HCP estimate as estimate.created (not updated)', async () => {
    // HCP returns one estimate that we have never seen locally.
    (housecallProService.getEstimates as any).mockResolvedValueOnce({
      success: true,
      data: [{ id: 'hcp_est_new_1' }],
    });
    (housecallProService.getJobs as any).mockResolvedValueOnce({
      success: true,
      data: [],
    });
    (storage.getEstimateByHousecallProEstimateId as any).mockResolvedValue(undefined);

    const summary = await runHcpWebhookBackfill('t1', new Date(Date.now() - 60_000));

    expect(processHcpEvent).toHaveBeenCalledTimes(1);
    expect(processHcpEvent).toHaveBeenCalledWith(
      't1',
      'estimate.created',
      { id: 'hcp_est_new_1' },
      undefined,
      undefined,
    );
    expect(summary.estimates).toBe(1);
    expect(summary.estimatesCreated).toBe(1);
  });

  it('replays an existing HCP estimate as estimate.updated', async () => {
    (housecallProService.getEstimates as any).mockResolvedValueOnce({
      success: true,
      data: [{ id: 'hcp_est_existing' }],
    });
    (housecallProService.getJobs as any).mockResolvedValueOnce({
      success: true,
      data: [],
    });
    (storage.getEstimateByHousecallProEstimateId as any).mockResolvedValue({ id: 'local_est_1' });

    const summary = await runHcpWebhookBackfill('t1', new Date(Date.now() - 60_000));

    expect(processHcpEvent).toHaveBeenCalledWith(
      't1',
      'estimate.updated',
      { id: 'hcp_est_existing' },
      undefined,
      undefined,
    );
    expect(summary.estimates).toBe(1);
    expect(summary.estimatesCreated).toBe(0);
  });

  it('mixes created vs updated correctly within a single page', async () => {
    (housecallProService.getEstimates as any).mockResolvedValueOnce({
      success: true,
      data: [
        { id: 'hcp_est_known' },
        { id: 'hcp_est_new' },
        { id: 'hcp_est_other_new' },
      ],
    });
    (housecallProService.getJobs as any).mockResolvedValueOnce({
      success: true,
      data: [{ id: 'hcp_job_new' }],
    });
    (storage.getEstimateByHousecallProEstimateId as any).mockImplementation(
      async (hcpId: string) => (hcpId === 'hcp_est_known' ? { id: 'local_known' } : undefined),
    );
    (storage.getJobByHousecallProJobId as any).mockResolvedValue(undefined);

    const summary = await runHcpWebhookBackfill('t1', new Date(Date.now() - 60_000));

    const calls = (processHcpEvent as any).mock.calls.map((c: any[]) => ({
      type: c[1],
      id: c[2].id,
    }));
    expect(calls).toEqual(
      expect.arrayContaining([
        { type: 'estimate.updated', id: 'hcp_est_known' },
        { type: 'estimate.created', id: 'hcp_est_new' },
        { type: 'estimate.created', id: 'hcp_est_other_new' },
        { type: 'job.created', id: 'hcp_job_new' },
      ]),
    );
    expect(summary.estimates).toBe(3);
    expect(summary.estimatesCreated).toBe(2);
    expect(summary.jobs).toBe(1);
    expect(summary.jobsCreated).toBe(1);
  });

  it('summarizeBackfill surfaces the "X new" counts when present', async () => {
    const summary = {
      estimates: 5,
      estimatesCreated: 2,
      jobs: 3,
      jobsCreated: 0,
      errors: [],
      since: '2025-01-01T00:00:00.000Z',
      truncated: false,
    };
    const text = summarizeBackfill(summary);
    expect(text).toContain('5 estimate(s), 2 new');
    expect(text).toContain('3 job(s)');
    expect(text).not.toContain('3 job(s), 0 new');
  });

  it("trigger='manual' honors a far-past since (no 7-day clamp); trigger='webhook-recovery' clamps to MAX_LOOKBACK_MS", async () => {
    // Stub two empty pages for each trigger run.
    (housecallProService.getEstimates as any).mockResolvedValue({ success: true, data: [] });
    (housecallProService.getJobs as any).mockResolvedValue({ success: true, data: [] });

    const farPast = new Date('2024-01-01T00:00:00.000Z');

    const manual = await runHcpWebhookBackfill('t1', farPast, 'manual');
    expect(manual.since).toBe(farPast.toISOString());

    const recovery = await runHcpWebhookBackfill('t1', farPast, 'webhook-recovery');
    const recoverySince = new Date(recovery.since).getTime();
    // Should be clamped to within ~7 days of "now" — well after 2024-01-01.
    expect(recoverySince).toBeGreaterThan(farPast.getTime());
    expect(Date.now() - recoverySince).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1000 + 5_000);
  });

  it("trigger='manual' with null since falls back to epoch (no clamp)", async () => {
    (housecallProService.getEstimates as any).mockResolvedValue({ success: true, data: [] });
    (housecallProService.getJobs as any).mockResolvedValue({ success: true, data: [] });

    const manual = await runHcpWebhookBackfill('t1', null, 'manual');
    expect(manual.since).toBe(new Date(0).toISOString());
  });

  it('tracks oldest updated_at across pages into summary.fetchedThroughAt', async () => {
    (housecallProService.getEstimates as any).mockResolvedValueOnce({
      success: true,
      data: [
        { id: 'e1', updated_at: '2026-04-10T00:00:00.000Z' },
        { id: 'e2', updated_at: '2026-03-15T00:00:00.000Z' },
      ],
    });
    (housecallProService.getJobs as any).mockResolvedValueOnce({
      success: true,
      data: [{ id: 'j1', updated_at: '2026-02-01T00:00:00.000Z' }],
    });
    (storage.getEstimateByHousecallProEstimateId as any).mockResolvedValue(undefined);
    (storage.getJobByHousecallProJobId as any).mockResolvedValue(undefined);

    const summary = await runHcpWebhookBackfill('t1', new Date('2026-01-01T00:00:00.000Z'), 'manual');
    expect(summary.fetchedThroughAt).toBe('2026-02-01T00:00:00.000Z');
  });

  it('items missing an HCP id are skipped without throwing', async () => {
    (housecallProService.getEstimates as any).mockResolvedValueOnce({
      success: true,
      data: [{ id: 'hcp_est_ok' }, {} /* no id */],
    });
    (housecallProService.getJobs as any).mockResolvedValueOnce({
      success: true,
      data: [],
    });
    (storage.getEstimateByHousecallProEstimateId as any).mockResolvedValue(undefined);

    const summary = await runHcpWebhookBackfill('t1', new Date(Date.now() - 60_000));

    expect(processHcpEvent).toHaveBeenCalledTimes(1);
    expect(summary.estimates).toBe(1);
    expect(summary.errors.length).toBe(1);
    expect(summary.errors[0]).toMatch(/missing HCP id/);
  });
});
