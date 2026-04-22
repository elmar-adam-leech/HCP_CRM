import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../storage', () => {
  const storage: any = {
    getSalesProcessWithSteps: vi.fn(),
    listCadences: vi.fn(),
    getCadenceWithSteps: vi.fn(),
    getSalesProcessSteps: vi.fn(),
    countTaskInstancesForEntity: vi.fn(),
    bulkInsertTaskInstances: vi.fn(),
    getOpenLeadsForBackfill: vi.fn(),
    skipPendingTasksForLead: vi.fn(),
    getLead: vi.fn(),
    getEstimate: vi.fn(),
    getLeadsByContact: vi.fn(),
    getEstimatesByContact: vi.fn(),
    listTaskInstances: vi.fn(),
    markTaskCompleted: vi.fn(),
  };
  return { storage };
});
vi.mock('../db', () => ({ db: { transaction: vi.fn() } }));

import { storage } from '../storage';
import {
  isTerminalLeadStatus,
  materializeForLead,
  backfillOpenLeads,
  onLeadStatusChanged,
  onEstimateStatusChanged,
  onActivityCreated,
} from './sales-process';
import { backoffMinutesAfterAttempt } from './sales-process-cron';

const tenantId = 'tenant-1';
const baseProcess = { id: 'p1', contractorId: tenantId, name: 'Default', active: true, triggerType: 'lead_created', targetStatus: null, entityType: 'lead' } as any;
const steps = [
  { id: 's1', processId: 'p1', dayOffset: 1, actionType: 'call', mode: 'manual' },
  { id: 's2', processId: 'p1', dayOffset: 4, actionType: 'text', mode: 'auto' },
  { id: 's3', processId: 'p1', dayOffset: 7, actionType: 'email', mode: 'auto' },
] as any[];

function makeLead(overrides: Partial<any> = {}) {
  return {
    id: 'lead-1',
    contractorId: tenantId,
    status: 'new',
    createdAt: new Date('2026-04-01T14:30:00Z'),
    ...overrides,
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: no estimates for any contact. Specific tests override.
  (storage.getEstimatesByContact as any).mockResolvedValue([]);
});

describe('isTerminalLeadStatus', () => {
  it('treats converted/disqualified/lost as terminal', () => {
    expect(isTerminalLeadStatus('converted')).toBe(true);
    expect(isTerminalLeadStatus('disqualified')).toBe(true);
    expect(isTerminalLeadStatus('lost')).toBe(true);
  });
  it('treats other statuses as non-terminal', () => {
    expect(isTerminalLeadStatus('new')).toBe(false);
    expect(isTerminalLeadStatus('contacted')).toBe(false);
    expect(isTerminalLeadStatus(null)).toBe(false);
    expect(isTerminalLeadStatus(undefined)).toBe(false);
  });
});

describe('materializeForLead', () => {
  beforeEach(() => {
    (storage.listCadences as any).mockResolvedValue([baseProcess]);
    (storage.getSalesProcessSteps as any).mockResolvedValue(steps);
  });
  it('materializes one instance per step at lead.createdAt + dayOffset preserving time-of-day', async () => {
    (storage.countTaskInstancesForEntity as any).mockResolvedValue(0);
    (storage.bulkInsertTaskInstances as any).mockImplementation((rows: any[]) =>
      Promise.resolve(rows.map((r, i) => ({ id: `i${i}`, ...r }))),
    );
    const lead = makeLead();
    const n = await materializeForLead(lead);
    expect(n).toBe(3);
    const rows = (storage.bulkInsertTaskInstances as any).mock.calls[0][0];
    expect(rows[0].dueAt.toISOString()).toBe('2026-04-02T14:30:00.000Z');
    expect(rows[1].dueAt.toISOString()).toBe('2026-04-05T14:30:00.000Z');
    expect(rows[2].dueAt.toISOString()).toBe('2026-04-08T14:30:00.000Z');
    expect(rows.map((r: any) => r.actionType)).toEqual(['call', 'text', 'email']);
  });

  it('no-ops when process is inactive', async () => {
    (storage.listCadences as any).mockResolvedValue([{ ...baseProcess, active: false }]);
    expect(await materializeForLead(makeLead())).toBe(0);
    expect(storage.bulkInsertTaskInstances).not.toHaveBeenCalled();
  });

  it('no-ops when lead is in a terminal status', async () => {
    (storage.countTaskInstancesForEntity as any).mockResolvedValue(0);
    expect(await materializeForLead(makeLead({ status: 'converted' }))).toBe(0);
    expect(await materializeForLead(makeLead({ status: 'disqualified' }))).toBe(0);
    expect(await materializeForLead(makeLead({ status: 'lost' }))).toBe(0);
    expect(storage.bulkInsertTaskInstances).not.toHaveBeenCalled();
  });

  it('no-ops if instances already exist (idempotent against duplicate hooks)', async () => {
    (storage.countTaskInstancesForEntity as any).mockResolvedValue(3);
    expect(await materializeForLead(makeLead())).toBe(0);
    expect(storage.bulkInsertTaskInstances).not.toHaveBeenCalled();
  });
});

describe('backfillOpenLeads', () => {
  it('only inserts for leads with zero existing instances', async () => {
    (storage.getSalesProcessWithSteps as any).mockResolvedValue({ process: baseProcess, steps });
    const leadA = makeLead({ id: 'A' });
    const leadB = makeLead({ id: 'B' });
    (storage.getOpenLeadsForBackfill as any).mockResolvedValue([leadA, leadB]);
    (storage.countTaskInstancesForEntity as any)
      .mockResolvedValueOnce(0)  // A
      .mockResolvedValueOnce(2); // B already has rows
    (storage.bulkInsertTaskInstances as any).mockImplementation((rows: any[]) =>
      Promise.resolve(rows.map((r, i) => ({ id: `i${i}`, ...r }))),
    );
    const r = await backfillOpenLeads(tenantId);
    expect(r).toEqual({ leadsTouched: 1, tasksCreated: 3 });
    expect(storage.bulkInsertTaskInstances).toHaveBeenCalledTimes(1);
  });

  it('returns zero when no active process', async () => {
    (storage.getSalesProcessWithSteps as any).mockResolvedValue({
      process: { ...baseProcess, active: false }, steps,
    });
    expect(await backfillOpenLeads(tenantId)).toEqual({ leadsTouched: 0, tasksCreated: 0 });
    expect(storage.getOpenLeadsForBackfill).not.toHaveBeenCalled();
  });
});

describe('onLeadStatusChanged', () => {
  beforeEach(() => {
    // Default: no matching status-changed cadences, so non-terminal
    // transitions are no-ops.
    (storage.listCadences as any).mockResolvedValue([]);
    (storage.getLead as any).mockResolvedValue({
      id: 'lead-1', contractorId: tenantId, status: 'contacted',
      createdAt: new Date('2026-04-01T00:00:00Z'),
    });
  });
  it('skips pending tasks when transitioning into a terminal status', async () => {
    await onLeadStatusChanged('lead-1', tenantId, 'converted', 'contacted');
    expect(storage.skipPendingTasksForLead).toHaveBeenCalledWith(
      'lead-1', tenantId, 'lead_status_changed',
    );
  });
  it('skips pending tasks when transitioning into the lost status', async () => {
    await onLeadStatusChanged('lead-1', tenantId, 'lost', 'contacted');
    expect(storage.skipPendingTasksForLead).toHaveBeenCalledWith(
      'lead-1', tenantId, 'lead_status_changed',
    );
  });
  it('does nothing when status did not actually change', async () => {
    await onLeadStatusChanged('lead-1', tenantId, 'converted', 'converted');
    expect(storage.skipPendingTasksForLead).not.toHaveBeenCalled();
  });
  it('does nothing when transitioning into a non-terminal status with no matching cadence', async () => {
    await onLeadStatusChanged('lead-1', tenantId, 'contacted', 'new');
    expect(storage.skipPendingTasksForLead).not.toHaveBeenCalled();
    expect(storage.bulkInsertTaskInstances).not.toHaveBeenCalled();
  });
  it('enrolls the lead into a matching lead_status_changed cadence', async () => {
    (storage.listCadences as any).mockResolvedValue([
      { id: 'p2', contractorId: tenantId, name: 'Post-qualified', active: true,
        triggerType: 'lead_status_changed', targetStatus: 'qualified', entityType: 'lead' },
    ]);
    (storage.getSalesProcessSteps as any).mockResolvedValue([
      { id: 's-q1', dayOffset: 1, actionType: 'call', mode: 'manual' },
    ]);
    (storage.countTaskInstancesForEntity as any).mockResolvedValue(0);
    (storage.bulkInsertTaskInstances as any).mockImplementation((rows: any[]) =>
      Promise.resolve(rows.map((r, i) => ({ id: `i${i}`, ...r }))));
    (storage.getLead as any).mockResolvedValue({
      id: 'lead-1', contractorId: tenantId, status: 'qualified',
      createdAt: new Date('2026-04-01T00:00:00Z'),
    });
    await onLeadStatusChanged('lead-1', tenantId, 'qualified', 'contacted');
    expect(storage.bulkInsertTaskInstances).toHaveBeenCalledTimes(1);
    const rows = (storage.bulkInsertTaskInstances as any).mock.calls[0][0];
    expect(rows[0].leadId).toBe('lead-1');
    expect(rows[0].estimateId).toBeNull();
  });
});

describe('onEstimateStatusChanged', () => {
  const estimateCadence = {
    id: 'p-est', contractorId: tenantId, name: 'Approved estimates', active: true,
    triggerType: 'estimate_status_changed', targetStatus: 'approved', entityType: 'estimate',
  } as any;
  const estimateSteps = [
    { id: 'es1', dayOffset: 1, actionType: 'call', mode: 'manual' },
    { id: 'es2', dayOffset: 3, actionType: 'email', mode: 'auto', messageTemplate: 'Thanks!' },
  ] as any[];

  beforeEach(() => {
    (storage.listCadences as any).mockResolvedValue([estimateCadence]);
    (storage.getSalesProcessSteps as any).mockResolvedValue(estimateSteps);
    (storage.getEstimate as any).mockResolvedValue({
      id: 'est-1', contractorId: tenantId, status: 'approved', contactId: 'c1',
    });
    (storage.countTaskInstancesForEntity as any).mockResolvedValue(0);
    (storage.bulkInsertTaskInstances as any).mockImplementation((rows: any[]) =>
      Promise.resolve(rows.map((r, i) => ({ id: `i${i}`, ...r }))),
    );
  });

  it('enrolls the estimate when status matches an active cadence', async () => {
    await onEstimateStatusChanged('est-1', tenantId, 'approved', 'sent');
    expect(storage.bulkInsertTaskInstances).toHaveBeenCalledTimes(1);
    const rows = (storage.bulkInsertTaskInstances as any).mock.calls[0][0];
    expect(rows).toHaveLength(2);
    expect(rows[0].estimateId).toBe('est-1');
    expect(rows[0].leadId).toBeNull();
  });

  it('is a no-op when the new status does not match any cadence target', async () => {
    await onEstimateStatusChanged('est-1', tenantId, 'in_progress', 'sent');
    expect(storage.bulkInsertTaskInstances).not.toHaveBeenCalled();
  });

  it('does nothing when status did not actually change', async () => {
    await onEstimateStatusChanged('est-1', tenantId, 'approved', 'approved');
    expect(storage.bulkInsertTaskInstances).not.toHaveBeenCalled();
    expect(storage.getEstimate).not.toHaveBeenCalled();
  });

  it('refuses to enroll a terminal estimate', async () => {
    (storage.getEstimate as any).mockResolvedValue({
      id: 'est-1', contractorId: tenantId, status: 'rejected', contactId: 'c1',
    });
    (storage.listCadences as any).mockResolvedValue([
      { ...estimateCadence, targetStatus: 'rejected' },
    ]);
    await onEstimateStatusChanged('est-1', tenantId, 'rejected', 'in_progress');
    expect(storage.bulkInsertTaskInstances).not.toHaveBeenCalled();
  });

  it('suppresses duplicate enrollment when instances already exist for this cadence/estimate', async () => {
    (storage.countTaskInstancesForEntity as any).mockResolvedValue(2);
    await onEstimateStatusChanged('est-1', tenantId, 'approved', 'sent');
    expect(storage.bulkInsertTaskInstances).not.toHaveBeenCalled();
  });
});

describe('onActivityCreated activity-match window', () => {
  const dueAt = new Date('2026-04-05T12:00:00Z');
  const lead = makeLead();
  const pendingCall = { id: 't1', actionType: 'call', dueAt } as any;

  it('completes the matching task when activity is within ±2 days', async () => {
    (storage.getLeadsByContact as any).mockResolvedValue([lead]);
    (storage.listTaskInstances as any).mockResolvedValue([pendingCall]);
    await onActivityCreated({
      type: 'call',
      contactId: 'c1',
      contractorId: tenantId,
      userId: 'u1',
      createdAt: new Date('2026-04-04T12:00:00Z'),
    } as any);
    expect(storage.markTaskCompleted).toHaveBeenCalledWith(
      't1', tenantId, 'activity_logged', 'u1',
    );
  });

  it('does NOT complete when activity is more than 2 days off (e.g. historical import)', async () => {
    (storage.getLeadsByContact as any).mockResolvedValue([lead]);
    (storage.listTaskInstances as any).mockResolvedValue([pendingCall]);
    await onActivityCreated({
      type: 'call',
      contactId: 'c1',
      contractorId: tenantId,
      userId: 'u1',
      createdAt: new Date('2026-04-10T12:00:00Z'),
    } as any);
    expect(storage.markTaskCompleted).not.toHaveBeenCalled();
  });

  it('skips sales-process auto-send activities (metadata.source=sales_process)', async () => {
    (storage.getLeadsByContact as any).mockResolvedValue([lead]);
    (storage.listTaskInstances as any).mockResolvedValue([
      { id: 't-email', actionType: 'email', dueAt } as any,
    ]);
    await onActivityCreated({
      type: 'email', contactId: 'c1', contractorId: tenantId, userId: null,
      createdAt: dueAt,
      metadata: { source: 'sales_process' },
    } as any);
    expect(storage.markTaskCompleted).not.toHaveBeenCalled();
    // contact lookup is short-circuited before fetching leads
    expect(storage.getLeadsByContact).not.toHaveBeenCalled();
  });

  it('is lead-scoped: only considers tasks for the most recently created non-terminal lead', async () => {
    const oldLead = makeLead({ id: 'old', createdAt: new Date('2026-01-01T00:00:00Z') });
    const newLead = makeLead({ id: 'new', createdAt: new Date('2026-04-01T00:00:00Z') });
    (storage.getLeadsByContact as any).mockResolvedValue([oldLead, newLead]);
    (storage.listTaskInstances as any).mockImplementation((_t: string, opts: any) => {
      if (opts.leadId === 'new') {
        return Promise.resolve([
          { id: 'new-task', actionType: 'call', dueAt: new Date('2026-04-04T12:00:00Z') } as any,
        ]);
      }
      // Old lead has an older task — must NOT be matched, even if dueAt
      // were closer to the activity. Lead-scoping prevents cross-lead
      // contamination on multi-lead contacts.
      return Promise.resolve([
        { id: 'old-task', actionType: 'call', dueAt: new Date('2026-04-04T17:00:00Z') } as any,
      ]);
    });
    await onActivityCreated({
      type: 'call', contactId: 'c1', contractorId: tenantId, userId: 'u1',
      createdAt: new Date('2026-04-04T17:00:00Z'),
    } as any);
    expect(storage.markTaskCompleted).toHaveBeenCalledTimes(1);
    expect(storage.markTaskCompleted).toHaveBeenCalledWith('new-task', tenantId, 'activity_logged', 'u1');
    expect((storage.listTaskInstances as any).mock.calls.every((c: any[]) => c[1].leadId === 'new')).toBe(true);
  });

  it('skips terminal leads when picking the target lead', async () => {
    const wonLead = makeLead({ id: 'won', status: 'converted', createdAt: new Date('2026-04-02T00:00:00Z') });
    const openLead = makeLead({ id: 'open', status: 'new', createdAt: new Date('2026-04-01T00:00:00Z') });
    (storage.getLeadsByContact as any).mockResolvedValue([wonLead, openLead]);
    (storage.listTaskInstances as any).mockResolvedValue([
      { id: 'open-task', actionType: 'call', dueAt: new Date('2026-04-04T12:00:00Z') } as any,
    ]);
    await onActivityCreated({
      type: 'call', contactId: 'c1', contractorId: tenantId, userId: 'u1',
      createdAt: new Date('2026-04-04T12:00:00Z'),
    } as any);
    expect((storage.listTaskInstances as any).mock.calls[0][1].leadId).toBe('open');
    expect(storage.markTaskCompleted).toHaveBeenCalledWith('open-task', tenantId, 'activity_logged', 'u1');
  });

  it('maps sms→text and email→email; ignores other activity types', async () => {
    (storage.getLeadsByContact as any).mockResolvedValue([lead]);
    (storage.listTaskInstances as any).mockResolvedValue([
      { id: 't-text', actionType: 'text', dueAt } as any,
      { id: 't-email', actionType: 'email', dueAt } as any,
    ]);
    await onActivityCreated({
      type: 'sms', contactId: 'c1', contractorId: tenantId, userId: null,
      createdAt: dueAt,
    } as any);
    expect(storage.markTaskCompleted).toHaveBeenCalledWith('t-text', tenantId, 'activity_logged', null);

    (storage.markTaskCompleted as any).mockClear();
    await onActivityCreated({
      type: 'note', contactId: 'c1', contractorId: tenantId, userId: null,
      createdAt: dueAt,
    } as any);
    expect(storage.markTaskCompleted).not.toHaveBeenCalled();
  });
});

describe('runDueAutoTasksOnce retry & lock semantics', () => {
  let cronStorage: any;
  let runDueAutoTasksOnce: typeof import('./sales-process-cron').runDueAutoTasksOnce;

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock('../storage', () => {
      cronStorage = {
        claimDueAutoTasks: vi.fn(),
        getSalesProcessWithSteps: vi.fn(),
        getLead: vi.fn(),
        getContact: vi.fn(),
        markTaskCompleted: vi.fn(),
        markTaskFailed: vi.fn(),
        rescheduleTaskForRetry: vi.fn(),
        createMessage: vi.fn(),
        createActivity: vi.fn(),
        getSharedEmailAccount: vi.fn(),
      };
      return { storage: cronStorage };
    });
    vi.doMock('../providers/provider-service', () => ({
      providerService: { sendSms: vi.fn().mockResolvedValue({ success: false, error: 'provider down' }) },
    }));
    vi.doMock('../gmail-service', () => ({ gmailService: { sendEmail: vi.fn() } }));
    vi.doMock('./background-job', () => ({ BackgroundJob: class {} }));
    runDueAutoTasksOnce = (await import('./sales-process-cron')).runDueAutoTasksOnce;
  });

  it('reschedules with exponential backoff when send fails and attempt < MAX_ATTEMPTS', async () => {
    cronStorage.claimDueAutoTasks.mockResolvedValue([
      {
        id: 'inst-1', contractorId: tenantId, leadId: 'lead-1', stepId: 's2',
        actionType: 'text', mode: 'auto', status: 'pending',
        dueAt: new Date('2026-04-05T12:00:00Z'),
        attemptCount: 2, // post-increment, so liveAttempt=2
      },
    ]);
    cronStorage.getSalesProcessWithSteps.mockResolvedValue({
      process: { active: true },
      steps: [{ id: 's2', mode: 'auto', actionType: 'text', messageTemplate: 'hi' }],
    });
    cronStorage.getLead.mockResolvedValue({ contactId: 'c1', source: 'web' });
    cronStorage.getContact.mockResolvedValue({ id: 'c1', name: 'Bob', emails: [], phones: ['+15551234567'] });
    const now = new Date('2026-04-05T12:00:00Z');
    const summary = await runDueAutoTasksOnce({ now, contractorId: tenantId });
    expect(summary).toMatchObject({ claimed: 1, sent: 0, failed: 0, skipped: 1 });
    expect(cronStorage.rescheduleTaskForRetry).toHaveBeenCalledTimes(1);
    expect(cronStorage.markTaskFailed).not.toHaveBeenCalled();
    // attempt=2 → backoff 2 min → next due = now + 2*60_000
    const [, , nextDue] = cronStorage.rescheduleTaskForRetry.mock.calls[0];
    expect((nextDue as Date).getTime()).toBe(now.getTime() + 2 * 60_000);
  });

  it('marks the instance failed permanently when liveAttempt reaches MAX_ATTEMPTS (5)', async () => {
    cronStorage.claimDueAutoTasks.mockResolvedValue([
      {
        id: 'inst-2', contractorId: tenantId, leadId: 'lead-1', stepId: 's2',
        actionType: 'text', mode: 'auto', status: 'pending',
        dueAt: new Date('2026-04-05T12:00:00Z'),
        attemptCount: 5,
      },
    ]);
    cronStorage.getSalesProcessWithSteps.mockResolvedValue({
      process: { active: true },
      steps: [{ id: 's2', mode: 'auto', actionType: 'text', messageTemplate: 'hi' }],
    });
    cronStorage.getLead.mockResolvedValue({ contactId: 'c1', source: 'web' });
    cronStorage.getContact.mockResolvedValue({ id: 'c1', name: 'Bob', phones: ['+15550000000'], emails: [] });
    const summary = await runDueAutoTasksOnce({ contractorId: tenantId });
    expect(summary).toMatchObject({ claimed: 1, sent: 0, failed: 1, skipped: 0 });
    expect(cronStorage.markTaskFailed).toHaveBeenCalledTimes(1);
    expect(cronStorage.rescheduleTaskForRetry).not.toHaveBeenCalled();
  });

  it('claim is tenant-scoped when contractorId is supplied (manager run-now)', async () => {
    cronStorage.claimDueAutoTasks.mockResolvedValue([]);
    await runDueAutoTasksOnce({ contractorId: tenantId, limit: 7 });
    expect(cronStorage.claimDueAutoTasks).toHaveBeenCalledWith(expect.any(Date), 7, tenantId);
  });
});

describe('backoffMinutesAfterAttempt', () => {
  it('produces 1, 2, 4, 8, 16 minute delays after attempts 1..5', () => {
    expect(backoffMinutesAfterAttempt(1)).toBe(1);
    expect(backoffMinutesAfterAttempt(2)).toBe(2);
    expect(backoffMinutesAfterAttempt(3)).toBe(4);
    expect(backoffMinutesAfterAttempt(4)).toBe(8);
    expect(backoffMinutesAfterAttempt(5)).toBe(16);
  });
  it('caps at 60 minutes for very large attempt counts', () => {
    expect(backoffMinutesAfterAttempt(20)).toBe(60);
  });
});
