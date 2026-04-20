import { describe, it, expect } from 'vitest';
import { truncateConditionDiagnostic } from './step-runner';

describe('truncateConditionDiagnostic', () => {
  it('passes through small diagnostic blobs unchanged', () => {
    const data = {
      result: true,
      field: 'lead.tags',
      operator: 'contains',
      target: 'No Text',
      resolvedValue: ['VIP', 'Repeat'],
      resolvedValueType: 'array',
    };
    expect(truncateConditionDiagnostic(data)).toEqual(data);
  });

  it('truncates oversized resolvedValue and sets truncated flag', () => {
    // Create a payload whose JSON is well over the 2 KB cap.
    const huge = Array.from({ length: 500 }, (_, i) => `tag-${i}`);
    const data = {
      result: false,
      resolvedValue: huge,
    };
    const out = truncateConditionDiagnostic(data) as Record<string, unknown>;
    expect(out.truncated).toBe(true);
    expect(typeof out.resolvedValue).toBe('string');
    expect((out.resolvedValue as string).length).toBeLessThanOrEqual(2049 + 1);
    expect((out.resolvedValue as string).endsWith('…')).toBe(true);
  });

  it('returns input as-is when there is no resolvedValue key', () => {
    const data = { result: true, field: 'x' };
    expect(truncateConditionDiagnostic(data)).toBe(data);
  });

  it('handles undefined input gracefully', () => {
    expect(truncateConditionDiagnostic(undefined)).toBeUndefined();
  });
});
