import { describe, it, expect, vi } from 'vitest';

// The helper under test only reads from `db` indirectly via the schema
// objects, so we can mock the db connection module.
vi.mock('../db', () => ({ db: {} }));
vi.mock('../services/cache', () => ({ cacheInvalidation: { invalidateContact: () => {} } }));
vi.mock('../services/contact-deduper', () => ({ deduplicateContacts: () => {} }));
vi.mock('../services/dashboard-metrics', () => ({
  getDashboardMetrics: () => ({}),
  getMetricsAggregates: () => ({}),
}));

import { PgDialect } from 'drizzle-orm/pg-core';
import { and } from 'drizzle-orm';
import { buildContactConditions } from '../storage/contacts';

const dialect = new PgDialect();

function compile(conditions: ReturnType<typeof buildContactConditions>): { sql: string; params: unknown[] } {
  const combined = and(...conditions)!;
  const q = dialect.sqlToQuery(combined);
  return { sql: q.sql, params: q.params };
}

function hasDisqualifiedExclusion(sql: string, params: unknown[]): boolean {
  return /"status" <> \$(\d+)/.test(sql)
    && (() => {
      const m = sql.match(/"status" <> \$(\d+)/);
      const idx = m ? Number(m[1]) - 1 : -1;
      return params[idx] === 'disqualified';
    })();
}

function hasDisqualifiedEquals(sql: string, params: unknown[]): boolean {
  return /"status" = \$(\d+)/.test(sql)
    && (() => {
      const m = sql.match(/"status" = \$(\d+)/);
      const idx = m ? Number(m[1]) - 1 : -1;
      return params[idx] === 'disqualified';
    })();
}

function hasAnonymizedFalse(sql: string, params: unknown[]): boolean {
  const m = sql.match(/"anonymized" = \$(\d+)/);
  if (!m) return false;
  const idx = Number(m[1]) - 1;
  return params[idx] === false;
}

const TENANT = '11111111-1111-1111-1111-111111111111';

describe('buildContactConditions — pipeline-gate bypass on text search', () => {
  it('default lead browse excludes disqualified contacts', () => {
    const { sql, params } = compile(buildContactConditions(TENANT, { type: 'lead' }));
    expect(hasDisqualifiedExclusion(sql, params)).toBe(true);
    // archived/aged exclusion still applied
    expect(sql).toContain('NOT EXISTS');
  });

  it('text search bypasses the disqualified exclusion', () => {
    const { sql, params } = compile(buildContactConditions(TENANT, { type: 'lead', search: 'Robin' }));
    expect(hasDisqualifiedExclusion(sql, params)).toBe(false);
    // archived/aged exclusion lifted in search mode
    expect(sql).not.toContain('NOT EXISTS');
    // search ILIKE clauses still applied
    expect(sql.toLowerCase()).toContain('ilike');
  });

  it('whitespace-only search does NOT trigger the bypass', () => {
    const { sql, params } = compile(buildContactConditions(TENANT, { type: 'lead', search: '   ' }));
    expect(hasDisqualifiedExclusion(sql, params)).toBe(true);
  });

  it('empty-string search does NOT trigger the bypass', () => {
    const { sql, params } = compile(buildContactConditions(TENANT, { type: 'lead', search: '' }));
    expect(hasDisqualifiedExclusion(sql, params)).toBe(true);
  });

  it('explicit status=disqualified is honored even with search bypass active', () => {
    const { sql, params } = compile(buildContactConditions(TENANT, {
      type: 'lead',
      search: 'Robin',
      status: 'disqualified',
    }));
    expect(hasDisqualifiedEquals(sql, params)).toBe(true);
    // never-disqualified guard must NOT also be present
    expect(hasDisqualifiedExclusion(sql, params)).toBe(false);
  });

  it('includeAll continues to bypass exclusions (regression)', () => {
    const { sql, params } = compile(buildContactConditions(TENANT, { type: 'lead', includeAll: true }));
    expect(hasDisqualifiedExclusion(sql, params)).toBe(false);
    expect(sql).not.toContain('NOT EXISTS');
  });

  it('GDPR-anonymized contacts remain excluded in search mode', () => {
    const { sql, params } = compile(buildContactConditions(TENANT, { type: 'lead', search: 'Robin' }));
    expect(hasAnonymizedFalse(sql, params)).toBe(true);
  });

  it('GDPR-anonymized contacts remain excluded with includeAll', () => {
    const { sql, params } = compile(buildContactConditions(TENANT, { type: 'lead', includeAll: true }));
    expect(hasAnonymizedFalse(sql, params)).toBe(true);
  });

  it('explicit archived=true filter still pins to archived-only on search', () => {
    const { sql } = compile(buildContactConditions(TENANT, {
      type: 'lead',
      search: 'Robin',
      archived: true,
    }));
    expect(sql).toContain('archived = true');
  });

  it('non-lead type (customer) without search does not apply disqualified exclusion (unchanged)', () => {
    const { sql, params } = compile(buildContactConditions(TENANT, { type: 'customer' }));
    expect(hasDisqualifiedExclusion(sql, params)).toBe(false);
  });
});
