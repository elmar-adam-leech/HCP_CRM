import { describe, it, expect } from 'vitest';
import _ from 'lodash';

function computeDiff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
) {
  const changedKeys = _.union(Object.keys(before), Object.keys(after)).filter(
    (k) => !_.isEqual(before[k], after[k]),
  );
  if (changedKeys.length === 0) return null;
  return {
    before: _.pick(before, changedKeys),
    after: _.pick(after, changedKeys),
  };
}

describe('audit log diff computation', () => {
  it('returns null when objects are identical', () => {
    const obj = { name: 'Alice', role: 'admin' };
    expect(computeDiff(obj, { ...obj })).toBeNull();
  });

  it('detects a single changed field', () => {
    const before = { name: 'Alice', role: 'admin' };
    const after = { name: 'Alice', role: 'manager' };
    const diff = computeDiff(before, after);
    expect(diff).not.toBeNull();
    expect(diff!.before).toEqual({ role: 'admin' });
    expect(diff!.after).toEqual({ role: 'manager' });
  });

  it('detects an added field (present in after, missing in before)', () => {
    const before = { name: 'Bob' };
    const after = { name: 'Bob', email: 'bob@example.com' };
    const diff = computeDiff(before, after);
    expect(diff!.after).toHaveProperty('email', 'bob@example.com');
    expect(diff!.before.email).toBeUndefined();
  });

  it('detects a removed field (present in before, missing in after)', () => {
    const before = { name: 'Carol', phone: '555-0100' };
    const after = { name: 'Carol' };
    const diff = computeDiff(before, after);
    expect(diff!.before).toHaveProperty('phone', '555-0100');
    expect(diff!.after.phone).toBeUndefined();
  });

  it('omits unchanged fields from the diff', () => {
    const before = { name: 'Dave', role: 'admin', email: 'dave@example.com' };
    const after = { name: 'Dave', role: 'user', email: 'dave@example.com' };
    const diff = computeDiff(before, after);
    expect(diff!.before).not.toHaveProperty('name');
    expect(diff!.after).not.toHaveProperty('name');
    expect(diff!.before).not.toHaveProperty('email');
    expect(diff!.after).not.toHaveProperty('email');
  });

  it('handles nested object changes correctly', () => {
    const before = { settings: { theme: 'light', lang: 'en' } };
    const after = { settings: { theme: 'dark', lang: 'en' } };
    const diff = computeDiff(before, after);
    expect(diff!.before.settings).toEqual({ theme: 'light', lang: 'en' });
    expect(diff!.after.settings).toEqual({ theme: 'dark', lang: 'en' });
  });
});
