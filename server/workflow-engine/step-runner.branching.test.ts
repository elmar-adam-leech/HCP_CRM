import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkflowStep } from '@shared/schema';

vi.mock('../storage', () => ({
  storage: {
    getWorkflowExecution: vi.fn(async () => ({ status: 'running' })),
    updateWorkflowExecution: vi.fn(async () => undefined),
  },
}));

vi.mock('../utils/logger', () => ({
  logger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

import { runStepGroups, parseStepGraph, computeReachableNodeIds } from './step-runner';
import type { ExecutionContext, StepLog } from './types';
import * as executor from './step-executor';

function step(opts: {
  id: string;
  order: number;
  actionType: string;
  nodeId?: string;
  edges?: Array<{ source: string; target: string; sourceHandle?: string }>;
}): WorkflowStep {
  return {
    id: opts.id,
    workflowId: 'wf1',
    stepOrder: opts.order,
    actionType: opts.actionType as WorkflowStep['actionType'],
    actionConfig: JSON.stringify({
      nodeId: opts.nodeId ?? opts.id,
      edges: opts.edges ?? [],
      data: {},
    }),
    parentStepId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function ctx(triggerData: Record<string, unknown> = {}): ExecutionContext {
  return {
    workflowId: 'wf1',
    executionId: 'ex1',
    contractorId: 'c1',
    workflowCreatorId: 'u1',
    triggerEntityType: 'lead',
    triggerData,
    variables: { lead: triggerData },
  };
}

describe('runStepGroups conditional gating', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('runs only the false-branch step when condition evaluates false (tag missing)', async () => {
    // Edges: trigger -> cond ; cond --true--> sms ; cond --false--> email
    const baseEdges = [
      { source: 'trigger', target: 'cond' },
      { source: 'cond', target: 'sms', sourceHandle: 'true' },
      { source: 'cond', target: 'email', sourceHandle: 'false' },
    ];
    const steps = [
      step({ id: 'cond', order: 0, actionType: 'conditional_branch', edges: baseEdges }),
      step({ id: 'sms', order: 1, actionType: 'send_sms', edges: baseEdges }),
      step({ id: 'email', order: 1, actionType: 'send_email', edges: baseEdges }),
    ];

    const spy = vi.spyOn(executor, 'executeStep').mockImplementation(async (s) => {
      if (s.actionType === 'conditional_branch') {
        return { success: true, data: { result: false, field: 'lead.tags', operator: 'contains' } };
      }
      return { success: true, data: { sent: true } };
    });

    const stepLogs: StepLog[] = [];
    const outcome = await runStepGroups(steps, stepLogs, ctx({ tags: ['Other'] }), 'ex1', 'c1');

    expect(outcome).toEqual({ kind: 'completed' });
    const called = spy.mock.calls.map(([s]) => s.id);
    expect(called).toContain('cond');
    expect(called).toContain('email');
    expect(called).not.toContain('sms');

    const smsLog = stepLogs.find(l => l.stepId === 'sms');
    expect(smsLog?.status).toBe('skipped');
    const emailLog = stepLogs.find(l => l.stepId === 'email');
    expect(emailLog?.status).toBe('success');
  });

  it('runs only the true-branch step when condition evaluates true (tag present)', async () => {
    const baseEdges = [
      { source: 'trigger', target: 'cond' },
      { source: 'cond', target: 'sms', sourceHandle: 'true' },
      { source: 'cond', target: 'email', sourceHandle: 'false' },
    ];
    const steps = [
      step({ id: 'cond', order: 0, actionType: 'conditional_branch', edges: baseEdges }),
      step({ id: 'sms', order: 1, actionType: 'send_sms', edges: baseEdges }),
      step({ id: 'email', order: 1, actionType: 'send_email', edges: baseEdges }),
    ];

    const spy = vi.spyOn(executor, 'executeStep').mockImplementation(async (s) => {
      if (s.actionType === 'conditional_branch') {
        return { success: true, data: { result: true } };
      }
      return { success: true, data: { sent: true } };
    });

    const stepLogs: StepLog[] = [];
    await runStepGroups(steps, stepLogs, ctx({ tags: ['Employment'] }), 'ex1', 'c1');

    const called = spy.mock.calls.map(([s]) => s.id);
    expect(called).toContain('sms');
    expect(called).not.toContain('email');
    expect(stepLogs.find(l => l.stepId === 'email')?.status).toBe('skipped');
    expect(stepLogs.find(l => l.stepId === 'sms')?.status).toBe('success');
  });

  it('still runs every step in a workflow with no conditional node (legacy behavior)', async () => {
    const steps = [
      step({ id: 'a', order: 0, actionType: 'send_sms', edges: [{ source: 'trigger', target: 'a' }, { source: 'a', target: 'b' }] }),
      step({ id: 'b', order: 1, actionType: 'send_email', edges: [{ source: 'a', target: 'b' }] }),
    ];
    const spy = vi.spyOn(executor, 'executeStep').mockResolvedValue({ success: true, data: {} });

    const stepLogs: StepLog[] = [];
    await runStepGroups(steps, stepLogs, ctx(), 'ex1', 'c1');

    expect(spy.mock.calls.map(([s]) => s.id)).toEqual(['a', 'b']);
    expect(stepLogs.every(l => l.status === 'success')).toBe(true);
  });

  it('runs unrelated parallel steps in the same group concurrently when reachable', async () => {
    // cond -> a (true) ; cond -> b (true) ; cond -> c (false)
    const baseEdges = [
      { source: 'trigger', target: 'cond' },
      { source: 'cond', target: 'a', sourceHandle: 'true' },
      { source: 'cond', target: 'b', sourceHandle: 'true' },
      { source: 'cond', target: 'c', sourceHandle: 'false' },
    ];
    const steps = [
      step({ id: 'cond', order: 0, actionType: 'conditional_branch', edges: baseEdges }),
      step({ id: 'a', order: 1, actionType: 'send_sms', edges: baseEdges }),
      step({ id: 'b', order: 1, actionType: 'send_email', edges: baseEdges }),
      step({ id: 'c', order: 1, actionType: 'create_notification', edges: baseEdges }),
    ];

    let inFlight = 0;
    let maxInFlight = 0;
    vi.spyOn(executor, 'executeStep').mockImplementation(async (s) => {
      if (s.actionType === 'conditional_branch') {
        return { success: true, data: { result: true } };
      }
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(r => setTimeout(r, 10));
      inFlight--;
      return { success: true, data: {} };
    });

    const stepLogs: StepLog[] = [];
    await runStepGroups(steps, stepLogs, ctx(), 'ex1', 'c1');

    // 'a' and 'b' are both true-branch reachable and at the same stepOrder, so
    // they should overlap. 'c' should be skipped.
    expect(maxInFlight).toBeGreaterThanOrEqual(2);
    expect(stepLogs.find(l => l.stepId === 'c')?.status).toBe('skipped');
    expect(stepLogs.find(l => l.stepId === 'a')?.status).toBe('success');
    expect(stepLogs.find(l => l.stepId === 'b')?.status).toBe('success');
  });
});

describe('runStepGroups gating across suspend/resume', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('honors a prior conditional result on resume even when the conditional step is no longer in the slice', async () => {
    // Graph: trigger -> cond -> (true: sms-then-wait-then-followup-true)
    //                        -> (false: wait-then-followup-false)
    // We split it as:
    //   cond (order 0)
    //   delay (order 1, on the false branch)
    //   followupTrue (order 2, true branch)
    //   followupFalse (order 2, false branch)
    const edges = [
      { source: 'trigger', target: 'cond' },
      { source: 'cond', target: 'delay', sourceHandle: 'false' },
      { source: 'cond', target: 'followupTrue', sourceHandle: 'true' },
      { source: 'delay', target: 'followupFalse' },
    ];
    const allSteps = [
      step({ id: 'cond', order: 0, actionType: 'conditional_branch', edges }),
      step({ id: 'delay', order: 1, actionType: 'delay', edges }),
      step({ id: 'followupTrue', order: 2, actionType: 'send_sms', edges }),
      step({ id: 'followupFalse', order: 2, actionType: 'send_email', edges }),
    ];

    // First pass: cond evaluates false, then delay suspends.
    const spy1 = vi.spyOn(executor, 'executeStep').mockImplementation(async (s) => {
      if (s.actionType === 'conditional_branch') {
        return { success: true, data: { result: false } };
      }
      if (s.actionType === 'delay') {
        return { success: true, suspend: true, resumeAt: new Date(Date.now() + 1000) };
      }
      return { success: true, data: {} };
    });

    const stepLogs: StepLog[] = [];
    const outcome1 = await runStepGroups(allSteps, stepLogs, ctx(), 'ex1', 'c1');
    expect(outcome1.kind).toBe('suspended');

    const called1 = spy1.mock.calls.map(([s]) => s.id);
    expect(called1).toContain('cond');
    expect(called1).toContain('delay');

    const condLog = stepLogs.find(l => l.stepId === 'cond');
    expect(condLog?.nodeId).toBe('cond');
    expect((condLog?.result as { result: boolean }).result).toBe(false);

    spy1.mockRestore();

    // Resume pass: `remainingSteps` is just the order >= 2 slice. The
    // conditional step row is NOT in this slice. Without resume-aware gating,
    // both `followupTrue` and `followupFalse` would run — that's the original
    // production bug. With the fix, gating must still know cond=false (from
    // the persisted log) and `cond` must still be recognized as a branch gate
    // (from the true/false handles on its outgoing edges).
    const remainingSteps = allSteps.filter(s => s.stepOrder >= 2);
    const spy2 = vi.spyOn(executor, 'executeStep').mockResolvedValue({ success: true, data: {} });

    const outcome2 = await runStepGroups(remainingSteps, stepLogs, ctx(), 'ex1', 'c1');
    expect(outcome2.kind).toBe('completed');

    const called2 = spy2.mock.calls.map(([s]) => s.id);
    expect(called2).toContain('followupFalse');
    expect(called2).not.toContain('followupTrue');
    expect(stepLogs.filter(l => l.stepId === 'followupTrue').pop()?.status).toBe('skipped');
    expect(stepLogs.filter(l => l.stepId === 'followupFalse').pop()?.status).toBe('success');
  });
});

describe('parseStepGraph + computeReachableNodeIds', () => {
  it('matches tags-contains semantics: false result skips true-branch steps', () => {
    const baseEdges = [
      { source: 'trigger', target: 'cond' },
      { source: 'cond', target: 'sms', sourceHandle: 'true' },
      { source: 'cond', target: 'email', sourceHandle: 'false' },
    ];
    const steps = [
      step({ id: 'cond', order: 0, actionType: 'conditional_branch', edges: baseEdges }),
      step({ id: 'sms', order: 1, actionType: 'send_sms', edges: baseEdges }),
      step({ id: 'email', order: 1, actionType: 'send_email', edges: baseEdges }),
    ];
    const graph = parseStepGraph(steps);

    const reachableFalse = computeReachableNodeIds(graph, new Map([['cond', false]]), new Set(['cond']));
    expect(reachableFalse.has('email')).toBe(true);
    expect(reachableFalse.has('sms')).toBe(false);

    const reachableTrue = computeReachableNodeIds(graph, new Map([['cond', true]]), new Set(['cond']));
    expect(reachableTrue.has('sms')).toBe(true);
    expect(reachableTrue.has('email')).toBe(false);
  });
});
