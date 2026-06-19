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

// Task #805: lead-only scope now filters on the derived "effective stage"
// CASE expression instead of raw contacts.status. The default active browse
// pins the derived stage to the active tabs (new/contacted/scheduled), which
// implicitly excludes disqualified/lost.
function hasActiveStageGate(sql: string): boolean {
  return /in \('new', 'contacted', 'scheduled'\)/i.test(sql);
}

// An explicit status filter compares the effective-stage CASE expression to the
// requested status param: `(CASE ... END) = $N`. Find any `= $N` whose param
// value matches the requested status.
function hasStageEquals(sql: string, params: unknown[], value: string): boolean {
  const re = /= \$(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    const idx = Number(m[1]) - 1;
    if (params[idx] === value) return true;
  }
  return false;
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
    const { sql } = compile(buildContactConditions(TENANT, { type: 'lead' }));
    // Lead-only scope pins the derived effective stage to the active tabs,
    // which excludes disqualified/lost.
    expect(hasActiveStageGate(sql)).toBe(true);
    // archived/aged exclusion still applied
    expect(sql).toContain('NOT EXISTS');
  });

  it('text search bypasses the disqualified exclusion', () => {
    const { sql } = compile(buildContactConditions(TENANT, { type: 'lead', search: 'Robin' }));
    expect(hasActiveStageGate(sql)).toBe(false);
    // archived/aged exclusion lifted in search mode
    expect(sql).not.toContain('NOT EXISTS');
    // search ILIKE clauses still applied
    expect(sql.toLowerCase()).toContain('ilike');
  });

  it('whitespace-only search does NOT trigger the bypass', () => {
    const { sql } = compile(buildContactConditions(TENANT, { type: 'lead', search: '   ' }));
    expect(hasActiveStageGate(sql)).toBe(true);
  });

  it('empty-string search does NOT trigger the bypass', () => {
    const { sql } = compile(buildContactConditions(TENANT, { type: 'lead', search: '' }));
    expect(hasActiveStageGate(sql)).toBe(true);
  });

  it('explicit status=disqualified is honored even with search bypass active', () => {
    const { sql, params } = compile(buildContactConditions(TENANT, {
      type: 'lead',
      search: 'Robin',
      status: 'disqualified',
    }));
    // Explicit status pins the derived effective stage to 'disqualified'.
    expect(hasStageEquals(sql, params, 'disqualified')).toBe(true);
    // the default active-stage gate must NOT also be present
    expect(hasActiveStageGate(sql)).toBe(false);
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

  it('multi-type (customer + inactive) emits a single IN predicate, not separate equality checks', () => {
    const { sql, params } = compile(buildContactConditions(TENANT, {
      types: ['customer', 'inactive'],
      search: 'Robin',
    }));
    expect(sql).toMatch(/"type" in \(/i);
    expect(params).toContain('customer');
    expect(params).toContain('inactive');
    // not a lead-only scope, so the lead-only disqualified guard must NOT appear
    expect(hasDisqualifiedExclusion(sql, params)).toBe(false);
  });

  it('multi-type that includes lead still applies the lead-scope disqualified guard', () => {
    const { sql, params } = compile(buildContactConditions(TENANT, {
      types: ['lead', 'customer'],
    }));
    expect(hasDisqualifiedExclusion(sql, params)).toBe(true);
  });

  it('single-element types array collapses to an equality predicate', () => {
    const { sql, params } = compile(buildContactConditions(TENANT, {
      types: ['customer'],
    }));
    expect(sql).toMatch(/"type" = \$/);
    expect(params).toContain('customer');
  });

  it('types takes precedence over the legacy single `type` field', () => {
    const { sql, params } = compile(buildContactConditions(TENANT, {
      type: 'lead',
      types: ['customer', 'inactive'],
    }));
    // legacy `type=lead` must be ignored when `types` is present
    expect(params).not.toContain('lead');
    expect(params).toContain('customer');
    expect(params).toContain('inactive');
  });
});
