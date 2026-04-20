import { describe, it, expect } from 'vitest';
import { handleEvaluateCondition } from './condition';
import type { ExecutionContext } from './types';

function ctx(triggerData: Record<string, unknown>, entityType = 'lead'): ExecutionContext {
  return {
    workflowId: 'wf1',
    executionId: 'ex1',
    contractorId: 'c1',
    workflowCreatorId: 'u1',
    triggerEntityType: entityType,
    triggerData,
    variables: { [entityType]: triggerData },
  };
}

describe('handleEvaluateCondition diagnostic struct', () => {
  it('returns field/operator/target/resolvedValue for an array tag check', async () => {
    const r = await handleEvaluateCondition(
      {} as never,
      { conditionField: 'lead.tags', conditionOperator: 'contains', conditionValue: 'No Text' },
      ctx({ tags: ['VIP', 'Repeat'] }),
    );
    expect(r.success).toBe(true);
    expect(r.data).toMatchObject({
      result: false,
      field: 'lead.tags',
      operator: 'contains',
      target: 'No Text',
      resolvedValue: ['VIP', 'Repeat'],
      resolvedValueType: 'array',
    });
    // Note only set when the resolved value is undefined.
    expect((r.data as { note?: string }).note).toBeUndefined();
  });

  it('matches an array tag when present', async () => {
    const r = await handleEvaluateCondition(
      {} as never,
      { conditionField: 'lead.tags', conditionOperator: 'contains', conditionValue: 'no text' },
      ctx({ tags: ['VIP', 'No Text'] }),
    );
    expect(r.data).toMatchObject({ result: true, resolvedValue: ['VIP', 'No Text'] });
  });

  it('flags undefined resolved value with a hint note', async () => {
    const r = await handleEvaluateCondition(
      {} as never,
      { conditionField: 'lead.tags', conditionOperator: 'contains', conditionValue: 'No Text' },
      ctx({}), // no tags
    );
    expect(r.data).toMatchObject({
      result: false,
      resolvedValue: undefined,
      resolvedValueType: 'undefined',
    });
    expect((r.data as { note?: string }).note).toMatch(/undefined/);
  });

  it('classifies scalar resolved value types correctly', async () => {
    const r = await handleEvaluateCondition(
      {} as never,
      { conditionField: 'lead.status', conditionOperator: 'equals', conditionValue: 'new' },
      ctx({ status: 'new' }),
    );
    expect(r.data).toMatchObject({
      result: true,
      resolvedValue: 'new',
      resolvedValueType: 'string',
    });
  });

  it('returns the diagnostic struct even on unknown-operator failure', async () => {
    const r = await handleEvaluateCondition(
      {} as never,
      { conditionField: 'lead.status', conditionOperator: 'who_knows', conditionValue: 'x' },
      ctx({ status: 'new' }),
    );
    expect(r.success).toBe(false);
    expect(r.data).toMatchObject({
      field: 'lead.status',
      operator: 'who_knows',
      resolvedValue: 'new',
    });
  });
});
