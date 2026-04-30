import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => {
  const dbMock: any = {
    update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }) }),
  };
  return { db: dbMock };
});

vi.mock('../websocket', () => ({
  broadcastToContractor: vi.fn(),
}));

vi.mock('../workflow-engine', () => ({
  workflowEngine: {
    triggerWorkflowsForEvent: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../services/availability-cache', () => ({
  invalidateAndRecompute: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../scheduling/availability', () => ({
  getAvailabilityForDate: vi.fn().mockResolvedValue([]),
}));

vi.mock('../utils/workflow/entity-adapter', () => ({
  toWorkflowEvent: (x: any) => x,
}));

vi.mock('../sync/hcp-mappers', () => ({
  extractHcpJobTitle: () => 'Backfilled Job',
  buildHcpLineItems: () => null,
  resolveSalespersonForHcpEntity: vi.fn().mockResolvedValue(null),
}));

vi.mock('../sync/housecall-pro', () => ({
  mapHcpJobStatus: () => 'in_progress',
}));

vi.mock('../sync/hcp-contact-helpers', () => ({
  resolveHcpContact: vi.fn(),
  isExcludedResult: (v: any) => v === '__hcp_excluded__',
}));

vi.mock('../utils/address', () => ({
  buildFormattedAddress: () => '123 Main St',
}));

vi.mock('../hcp/index', () => ({
  housecallProService: {
    getEstimates: vi.fn(),
    getJobs: vi.fn(),
    getJob: vi.fn(),
  },
}));

vi.mock('../storage', () => ({
  storage: {
    getEstimateByHousecallProEstimateId: vi.fn(),
    getJobByHousecallProJobId: vi.fn(),
    getContact: vi.fn(),
    createJob: vi.fn(),
    createContact: vi.fn(),
    updateContact: vi.fn(),
    updateEstimate: vi.fn(),
    updateJob: vi.fn(),
    getContractor: vi.fn().mockResolvedValue({ id: 't1', timezone: 'America/New_York' }),
  },
}));

import { storage } from '../storage';
import { housecallProService } from '../hcp/index';
import { resolveHcpContact } from '../sync/hcp-contact-helpers';
import { runHcpWebhookBackfill } from '../sync/hcp-backfill';

describe('runHcpWebhookBackfill end-to-end: missing jobs are inserted via storage.createJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a brand-new local job when HCP returns a job we have never seen', async () => {
    // No estimates this round.
    (housecallProService.getEstimates as any).mockResolvedValueOnce({
      success: true,
      data: [],
    });
    // One brand-new HCP job in the modified-since window.
    (housecallProService.getJobs as any).mockResolvedValueOnce({
      success: true,
      data: [{ id: 'hcp_job_brand_new' }],
    });
    // Local lookup says: not in our DB.
    (storage.getJobByHousecallProJobId as any).mockResolvedValue(undefined);

    // The handler then fetches the full job from HCP for customer/title/etc.
    (housecallProService.getJob as any).mockResolvedValue({
      success: true,
      data: {
        id: 'hcp_job_brand_new',
        work_status: 'in_progress',
        total_amount: 12_345,
        customer: {
          id: 'cust_42',
          first_name: 'Jane',
          last_name: 'Doe',
          email: 'jane@example.com',
        },
        schedule: { scheduled_start: '2026-04-15T09:00:00Z' },
      },
    });

    // Resolve to an existing local contact (so we don't go through createContact).
    (resolveHcpContact as any).mockResolvedValue('local_contact_99');
    (storage.getContact as any).mockResolvedValue({ id: 'local_contact_99', type: 'customer' });
    (storage.createJob as any).mockImplementation(async (jobData: any) => ({
      id: 'newly_created_local_job',
      ...jobData,
    }));

    const summary = await runHcpWebhookBackfill('t1', new Date(Date.now() - 60_000));

    expect(storage.createJob).toHaveBeenCalledTimes(1);
    const [[jobInsertPayload, tenantArg]] = (storage.createJob as any).mock.calls;
    expect(tenantArg).toBe('t1');
    expect(jobInsertPayload.contactId).toBe('local_contact_99');
    expect(jobInsertPayload.externalId).toBe('hcp_job_brand_new');
    expect(jobInsertPayload.externalSource).toBe('housecall-pro');
    // 12345 cents -> $123.45
    expect(jobInsertPayload.value).toBe('123.45');
    expect(jobInsertPayload.scheduledDate).toBeInstanceOf(Date);

    // Backfill summary reflects the create.
    expect(summary.jobs).toBe(1);
    expect(summary.jobsCreated).toBe(1);
  });

  it('creates a contact then a job when no local contact exists for the customer', async () => {
    (housecallProService.getEstimates as any).mockResolvedValueOnce({
      success: true,
      data: [],
    });
    (housecallProService.getJobs as any).mockResolvedValueOnce({
      success: true,
      data: [{ id: 'hcp_job_no_contact' }],
    });
    (storage.getJobByHousecallProJobId as any).mockResolvedValue(undefined);
    (housecallProService.getJob as any).mockResolvedValue({
      success: true,
      data: {
        id: 'hcp_job_no_contact',
        work_status: 'scheduled',
        total_amount: 0,
        customer: {
          id: 'cust_unknown',
          first_name: 'Brand',
          last_name: 'New',
          email: 'brand.new@example.com',
          mobile_number: '5551234567',
        },
      },
    });
    (resolveHcpContact as any).mockResolvedValue(null);
    (storage.createContact as any).mockResolvedValue({ id: 'contact_brand_new', type: 'customer' });
    (storage.getContact as any).mockResolvedValue({ id: 'contact_brand_new', type: 'customer' });
    (storage.createJob as any).mockResolvedValue({ id: 'job_brand_new' });

    await runHcpWebhookBackfill('t1', new Date(Date.now() - 60_000));

    expect(storage.createContact).toHaveBeenCalledTimes(1);
    const [[contactInsertPayload]] = (storage.createContact as any).mock.calls;
    expect(contactInsertPayload.housecallProCustomerId).toBe('cust_unknown');
    expect(contactInsertPayload.emails).toEqual(['brand.new@example.com']);
    expect(contactInsertPayload.phones).toEqual(['5551234567']);

    expect(storage.createJob).toHaveBeenCalledTimes(1);
    const [[jobInsertPayload]] = (storage.createJob as any).mock.calls;
    expect(jobInsertPayload.contactId).toBe('contact_brand_new');
  });

  it('skips a missing-job dispatch when HCP customer is excluded by the user', async () => {
    (housecallProService.getEstimates as any).mockResolvedValueOnce({
      success: true,
      data: [],
    });
    (housecallProService.getJobs as any).mockResolvedValueOnce({
      success: true,
      data: [{ id: 'hcp_job_excluded' }],
    });
    (storage.getJobByHousecallProJobId as any).mockResolvedValue(undefined);
    (housecallProService.getJob as any).mockResolvedValue({
      success: true,
      data: {
        id: 'hcp_job_excluded',
        customer: { id: 'cust_blocked' },
      },
    });
    (resolveHcpContact as any).mockResolvedValue('__hcp_excluded__');

    await runHcpWebhookBackfill('t1', new Date(Date.now() - 60_000));

    expect(storage.createContact).not.toHaveBeenCalled();
    expect(storage.createJob).not.toHaveBeenCalled();
  });
});
