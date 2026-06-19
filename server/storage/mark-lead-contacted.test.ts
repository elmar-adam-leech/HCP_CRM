import { describe, it, expect, vi, beforeEach } from 'vitest';

// Task #805 regression: contacting a lead (messaging / activity / ingestion
// auto-contact) must move the contact's most-recent OPEN lead out of the "New"
// tab. The derived effective stage (`effectiveStageSql`) reads the lead's
// STATUS, not `contacted_at`, so `markLeadContacted` must advance the lead
// status `new` -> `contacted` on the same row it stamps the timing onto.
//
// This drives the REAL drizzle SQL builder (only `../db` is mocked) and
// compiles the captured UPDATE ... SET payload, so a future refactor that
// drops the status transition fails loudly here.

const h = vi.hoisted(() => ({
  capturedSet: undefined as any,
  capturedWhere: undefined as any,
}));

vi.mock('../db', () => ({
  db: {
    update: () => ({
      set: (v: any) => {
        h.capturedSet = v;
        return {
          where: (w: any) => {
            h.capturedWhere = w;
            return Promise.resolve();
          },
        };
      },
    }),
  },
}));

vi.mock('../services/cache', () => ({ cacheInvalidation: { invalidateContact: vi.fn() } }));
vi.mock('../services/contact-deduper', () => ({ deduplicateContacts: vi.fn() }));
vi.mock('../services/dashboard-metrics', () => ({ getDashboardMetrics: vi.fn(), getMetricsAggregates: vi.fn() }));

import { PgDialect } from 'drizzle-orm/pg-core';
import { contactMethods } from './contacts';

const dialect = new PgDialect();
const TENANT = '11111111-1111-1111-1111-111111111111';
const CONTACT = '22222222-2222-2222-2222-222222222222';

function compile(fragment: unknown): { sql: string; params: unknown[] } {
  const q = dialect.sqlToQuery(fragment as any);
  return { sql: q.sql.toLowerCase(), params: q.params };
}

beforeEach(() => {
  h.capturedSet = undefined;
  h.capturedWhere = undefined;
});

describe('markLeadContacted (task #805)', () => {
  it('advances the lead status new -> contacted (so the derived stage leaves the New tab)', async () => {
    await contactMethods.markLeadContacted(CONTACT, TENANT, 'user-1');
    expect(h.capturedSet).toBeDefined();
    // status must be written (previously this helper only stamped timing)
    expect(h.capturedSet.status).toBeDefined();
    const { sql } = compile(h.capturedSet.status);
    expect(sql).toContain('case when');
    expect(sql).toContain("= 'new'");
    expect(sql).toContain("'contacted'");
  });

  it('stamps contacted_at as first-touch only (never overwrites an existing timestamp)', async () => {
    await contactMethods.markLeadContacted(CONTACT, TENANT, 'user-1');
    const { sql } = compile(h.capturedSet.contactedAt);
    // CASE WHEN contacted_at IS NULL THEN <new> ELSE contacted_at END
    expect(sql).toContain('case when');
    expect(sql).toContain('is null');
  });

  it('targets the contact\'s most-recent OPEN lead (new/contacted/qualified)', async () => {
    await contactMethods.markLeadContacted(CONTACT, TENANT, 'user-1');
    const { sql } = compile(h.capturedWhere);
    expect(sql).toContain("in ('new', 'contacted', 'qualified')");
    expect(sql).toContain('order by');
    expect(sql).toContain('limit 1');
    // open = not archived
    expect(sql).toContain('archived = false');
  });
});
