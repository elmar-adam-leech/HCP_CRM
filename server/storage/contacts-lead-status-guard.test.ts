import { describe, it, expect, vi, beforeEach } from 'vitest';

// Task #798: the lead-status invariant lives in the shared write path
// (createContact / updateContact in this module). A lead-type contact must
// never be persisted with a customer-only status (active/inactive) — those
// statuses are not part of the leads pipeline, so a lead that lands on one
// silently disappears from every Leads filter, tab, and Kanban column.
//
// These tests drive the REAL coercion logic by mocking only the database layer
// and capturing the values that would have been written, so a future refactor
// that weakens the guard fails loudly here.

const h = vi.hoisted(() => ({
  selectRows: [] as any[],
  selectCalled: vi.fn(),
  insertValues: vi.fn(),
  updateSet: vi.fn(),
}));

vi.mock('../db', () => ({
  db: {
    insert: () => ({
      values: (v: any) => {
        h.insertValues(v);
        return { returning: () => Promise.resolve([{ id: 'created-id', ...v }]) };
      },
    }),
    update: () => ({
      set: (v: any) => {
        h.updateSet(v);
        return { where: () => ({ returning: () => Promise.resolve([{ id: 'updated-id', ...v }]) }) };
      },
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => {
            h.selectCalled();
            return Promise.resolve(h.selectRows);
          },
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
  h.selectRows = [];
});

describe('createContact lead-status invariant (task #798)', () => {
  it('coerces a new lead saved as active → new', async () => {
    await contactMethods.createContact(
      { name: 'Active Andy', type: 'lead', status: 'active' } as any,
      TENANT,
    );
    expect(h.insertValues).toHaveBeenCalledTimes(1);
    expect(h.insertValues.mock.calls[0][0].status).toBe('new');
    expect(h.insertValues.mock.calls[0][0].type).toBe('lead');
  });

  it('coerces a booked lead saved as active → scheduled', async () => {
    await contactMethods.createContact(
      { name: 'Booked Bea', type: 'lead', status: 'active', isScheduled: true } as any,
      TENANT,
    );
    expect(h.insertValues.mock.calls[0][0].status).toBe('scheduled');
  });

  it('coerces a lead saved as inactive → new', async () => {
    await contactMethods.createContact(
      { name: 'Inactive Ivy', type: 'lead', status: 'inactive' } as any,
      TENANT,
    );
    expect(h.insertValues.mock.calls[0][0].status).toBe('new');
  });

  it('leaves a genuine customer with status active untouched', async () => {
    await contactMethods.createContact(
      { name: 'Customer Carl', type: 'customer', status: 'active' } as any,
      TENANT,
    );
    expect(h.insertValues.mock.calls[0][0].status).toBe('active');
    expect(h.insertValues.mock.calls[0][0].type).toBe('customer');
  });

  it('leaves a normal lead status (contacted) untouched', async () => {
    await contactMethods.createContact(
      { name: 'Normal Ned', type: 'lead', status: 'contacted' } as any,
      TENANT,
    );
    expect(h.insertValues.mock.calls[0][0].status).toBe('contacted');
  });
});

describe('updateContact lead-status invariant (task #798)', () => {
  it('coerces an existing lead patched to active → new', async () => {
    h.selectRows = [{ type: 'lead', status: 'new', isScheduled: false }];
    await contactMethods.updateContact('c1', { status: 'active' } as any, TENANT);
    expect(h.updateSet).toHaveBeenCalledTimes(1);
    expect(h.updateSet.mock.calls[0][0].status).toBe('new');
  });

  it('coerces an existing booked lead patched to active → scheduled', async () => {
    h.selectRows = [{ type: 'lead', status: 'scheduled', isScheduled: true }];
    await contactMethods.updateContact('c1', { status: 'active' } as any, TENANT);
    expect(h.updateSet.mock.calls[0][0].status).toBe('scheduled');
  });

  it('coerces an existing lead patched to inactive → new', async () => {
    h.selectRows = [{ type: 'lead', status: 'new', isScheduled: false }];
    await contactMethods.updateContact('c1', { status: 'inactive' } as any, TENANT);
    expect(h.updateSet.mock.calls[0][0].status).toBe('new');
  });

  it('coerces when a contact is re-typed to lead while already on active', async () => {
    // patch.type='lead' triggers the guard; existing row carries the bad status.
    h.selectRows = [{ type: 'customer', status: 'active', isScheduled: false }];
    await contactMethods.updateContact('c1', { type: 'lead' } as any, TENANT);
    expect(h.updateSet.mock.calls[0][0].status).toBe('new');
  });

  it('leaves a genuine customer promotion (type=customer, status=active) untouched and does not read the row', async () => {
    await contactMethods.updateContact('c1', { type: 'customer', status: 'active' } as any, TENANT);
    expect(h.updateSet.mock.calls[0][0].status).toBe('active');
    expect(h.updateSet.mock.calls[0][0].type).toBe('customer');
    // Both type and status are present in the patch, so no extra fetch is needed.
    expect(h.selectCalled).not.toHaveBeenCalled();
  });

  it('does not touch ordinary updates that set neither a bad status nor lead type, and pays no extra query', async () => {
    await contactMethods.updateContact('c1', { name: 'Renamed' } as any, TENANT);
    expect(h.updateSet.mock.calls[0][0].name).toBe('Renamed');
    expect(h.updateSet.mock.calls[0][0].status).toBeUndefined();
    expect(h.selectCalled).not.toHaveBeenCalled();
  });
});
