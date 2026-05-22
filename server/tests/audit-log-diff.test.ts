import { describe, it, expect } from 'vitest';

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const aKeys = Object.keys(ao);
  if (aKeys.length !== Object.keys(bo).length) return false;
  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bo, k)) return false;
    if (!deepEqual(ao[k], bo[k])) return false;
  }
  return true;
}

function pickKeys(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
  }
  return out;
}

function computeDiff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
) {
  const allKeys = Array.from(new Set([...Object.keys(before), ...Object.keys(after)]));
  const changedKeys = allKeys.filter((k) => !deepEqual(before[k], after[k]));
  if (changedKeys.length === 0) return null;
  return {
    before: pickKeys(before, changedKeys),
    after: pickKeys(after, changedKeys),
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
