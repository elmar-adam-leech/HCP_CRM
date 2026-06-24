import { describe, it, expect, vi, beforeEach } from 'vitest';

// Task #814: the Leads page is a derived projection that lists lead-type
// contacts which may have NO backing row in the `leads` table. The
// age/unage/archive/restore actions UPDATE `leads` by contact_id; when no row
// matches the UPDATE affects nothing and the route used to 404. These actions
// must now create a minimal backing lead row carrying the requested flag, but
// only when the contact actually exists for the contractor.
//
// These tests drive the REAL fallback logic by mocking only the database layer
// and capturing what would have been written.

const h = vi.hoisted(() => ({
  updateReturning: [] as any[],
  selectRows: [] as any[],
  insertValues: vi.fn(),
  updateSet: vi.fn(),
}));

vi.mock('../db', () => ({
  db: {
    insert: () => ({
      values: (v: any) => {
        h.insertValues(v);
        return { returning: () => Promise.resolve([{ id: 'created-lead-id', ...v }]) };
      },
    }),
    update: () => ({
      set: (v: any) => {
        h.updateSet(v);
        return { where: () => ({ returning: () => Promise.resolve(h.updateReturning) }) };
      },
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(h.selectRows),
        }),
      }),
    }),
  },
}));

vi.mock('@shared/schema', () => {
  const table = () => new Proxy({}, { get: (_t, p) => ({ _col: String(p) }) });
  return {
    contacts: table(),
    leads: table(),
    messages: table(),
    activities: table(),
    estimates: table(),
    jobs: table(),
    hcpExcludedCustomers: table(),
    contactStatusEnum: { enumValues: ['new', 'contacted', 'scheduled', 'active', 'disqualified', 'inactive', 'lost'] },
  };
});

vi.mock('drizzle-orm', () => {
  const fn = () => ({});
  const sql = Object.assign((..._a: any[]) => ({}), { raw: () => ({}) });
  return {
    eq: fn, and: fn, or: fn, asc: fn, desc: fn, ne: fn, lt: fn, lte: fn, gte: fn,
    ilike: fn, isNotNull: fn, notInArray: fn, inArray: fn, sql, count: fn,
  };
});

vi.mock('../utils/booking-token', () => ({ generateBookingCode: () => 'BOOK-TEST' }));
vi.mock('../utils/phone-normalizer', () => ({ normalizePhoneArrayForStorage: (a: string[]) => a }));
vi.mock('../services/contact-deduper', () => ({ deduplicateContacts: vi.fn() }));
vi.mock('../services/dashboard-metrics', () => ({ getDashboardMetrics: vi.fn(), getMetricsAggregates: vi.fn() }));
vi.mock('../services/cache', () => ({ cacheInvalidation: { invalidateContact: vi.fn() } }));
vi.mock('../services/report-cache', () => ({ invalidateReportsCache: vi.fn() }));

import { contactMethods } from './contacts';

const TENANT = 'tenant-1';

beforeEach(() => {
  vi.clearAllMocks();
  h.updateReturning = [];
  h.selectRows = [];
});

describe('ageLead with no backing lead row (task #814)', () => {
  it('creates a minimal aged lead row when the contact has no lead row', async () => {
    h.updateReturning = []; // UPDATE matched nothing
    h.selectRows = [{ id: 'c1', status: 'new', source: 'instagram' }];

    const result = await contactMethods.ageLead('c1', TENANT);

    expect(h.insertValues).toHaveBeenCalledTimes(1);
    const inserted = h.insertValues.mock.calls[0][0];
    expect(inserted.contactId).toBe('c1');
    expect(inserted.contractorId).toBe(TENANT);
    expect(inserted.aged).toBe(true);
    expect(inserted.archived).toBe(false);
    expect(inserted.status).toBe('new');
    expect(inserted.source).toBe('instagram');
    expect(result).toBeTruthy();
  });

  it('returns undefined (→404) for a missing / cross-tenant contact', async () => {
    h.updateReturning = [];
    h.selectRows = []; // contact not found

    const result = await contactMethods.ageLead('missing', TENANT);

    expect(result).toBeUndefined();
    expect(h.insertValues).not.toHaveBeenCalled();
  });

  it('updates the existing lead row in place without inserting when one exists', async () => {
    h.updateReturning = [{ id: 'existing-lead', aged: true }];

    const result = await contactMethods.ageLead('c1', TENANT);

    expect(h.updateSet).toHaveBeenCalledTimes(1);
    expect(h.updateSet.mock.calls[0][0].aged).toBe(true);
    expect(h.insertValues).not.toHaveBeenCalled();
    expect(result).toEqual({ id: 'existing-lead', aged: true });
  });

  it('coerces a customer-only contact status (active) to a valid lead status (new)', async () => {
    h.updateReturning = [];
    h.selectRows = [{ id: 'c2', status: 'active', source: null }];

    await contactMethods.ageLead('c2', TENANT);

    expect(h.insertValues.mock.calls[0][0].status).toBe('new');
  });
});

describe('archiveLead with no backing lead row (task #814)', () => {
  it('creates a minimal archived lead row', async () => {
    h.updateReturning = [];
    h.selectRows = [{ id: 'c1', status: 'contacted', source: null }];

    await contactMethods.archiveLead('c1', TENANT);

    const inserted = h.insertValues.mock.calls[0][0];
    expect(inserted.archived).toBe(true);
    expect(inserted.aged).toBe(false);
    expect(inserted.status).toBe('contacted');
  });
});

describe('restoreLead / unageLead with no backing lead row (task #814)', () => {
  it('restoreLead succeeds and creates an un-archived lead row', async () => {
    h.updateReturning = [];
    h.selectRows = [{ id: 'c1', status: 'new', source: null }];

    const result = await contactMethods.restoreLead('c1', TENANT);

    expect(h.insertValues.mock.calls[0][0].archived).toBe(false);
    expect(result).toBeTruthy();
  });

  it('unageLead succeeds and creates an un-aged lead row', async () => {
    h.updateReturning = [];
    h.selectRows = [{ id: 'c1', status: 'new', source: null }];

    const result = await contactMethods.unageLead('c1', TENANT);

    expect(h.insertValues.mock.calls[0][0].aged).toBe(false);
    expect(result).toBeTruthy();
  });
});
