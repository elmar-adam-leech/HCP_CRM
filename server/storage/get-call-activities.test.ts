import { describe, it, expect, vi, beforeEach } from 'vitest';

// getCallActivities derives `otherPartyNumber` server-side from each call's
// `metadata`. The `activities.metadata` column is TEXT holding JSON, and
// depending on the ingestion path a row can arrive either already parsed
// (jsonb-style object) OR as a raw JSON string. These tests pin that BOTH
// representations resolve the number for inbound/outbound and unassigned rows.

const h = vi.hoisted(() => ({
  rows: [] as any[],
}));

vi.mock('../db', () => ({
  db: {
    select: () => ({
      from: () => ({
        leftJoin: () => ({
          leftJoin: () => ({
            where: () => ({
              orderBy: () => ({
                limit: () => Promise.resolve(h.rows),
              }),
            }),
          }),
        }),
      }),
    }),
  },
}));

vi.mock('@shared/schema', () => {
  const table = () => new Proxy({}, { get: (_t, p) => ({ _col: String(p) }) });
  return {
    activities: table(),
    users: table(),
    estimates: table(),
    jobs: table(),
    contacts: table(),
  };
});

vi.mock('drizzle-orm', () => {
  const fn = () => ({});
  const sql = Object.assign((..._a: any[]) => ({}), { raw: () => ({}) });
  return {
    eq: fn, and: fn, or: fn, desc: fn, sql, isNotNull: fn, inArray: fn,
  };
});

import { activityMethods } from './activities';

const TENANT = 'tenant-1';

function baseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'a1', type: 'call', title: 'Call', content: null,
    contactId: null, estimateId: null, jobId: null,
    userId: 'u1', contractorId: TENANT,
    externalId: null, externalSource: 'twilio',
    createdAt: new Date(), updatedAt: new Date(),
    userName: 'Rep', contactName: null, contactType: null, contactPhones: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.rows = [];
});

describe('getCallActivities otherPartyNumber derivation', () => {
  it('inbound → from_number when metadata is a parsed object', async () => {
    h.rows = [baseRow({ metadata: { direction: 'inbound', from_number: '+15551110001', to_number: '+15559990000' } })];
    const [call] = await activityMethods.getCallActivities(TENANT);
    expect((call as any).otherPartyNumber).toBe('+15551110001');
  });

  it('inbound → from_number when metadata is a JSON string (legacy text column)', async () => {
    h.rows = [baseRow({ metadata: JSON.stringify({ direction: 'inbound', from_number: '+15551110002', to_number: '+15559990000' }) })];
    const [call] = await activityMethods.getCallActivities(TENANT);
    expect((call as any).otherPartyNumber).toBe('+15551110002');
  });

  it('outbound → to_number when metadata is a parsed object', async () => {
    h.rows = [baseRow({ metadata: { direction: 'outbound', from_number: '+15559990000', to_number: '+15551110003' } })];
    const [call] = await activityMethods.getCallActivities(TENANT);
    expect((call as any).otherPartyNumber).toBe('+15551110003');
  });

  it('outbound → to_number when metadata is a JSON string', async () => {
    h.rows = [baseRow({ metadata: JSON.stringify({ direction: 'outbound', from_number: '+15559990000', to_number: '+15551110004' }) })];
    const [call] = await activityMethods.getCallActivities(TENANT);
    expect((call as any).otherPartyNumber).toBe('+15551110004');
  });

  it('unassigned inbound call (no linked contact) still resolves its number from a JSON-string metadata', async () => {
    h.rows = [baseRow({ contactId: null, contactPhones: null, metadata: JSON.stringify({ direction: 'inbound', from_number: '+15551110005' }) })];
    const [call] = await activityMethods.getCallActivities(TENANT);
    expect((call as any).contactId).toBeNull();
    expect((call as any).otherPartyNumber).toBe('+15551110005');
    expect((call as any).entityName).toBeNull();
  });

  it('falls back to the linked contact first phone when metadata lacks numbers', async () => {
    h.rows = [baseRow({ contactId: 'c1', contactName: 'Jane', contactType: 'lead', contactPhones: ['+15551110006'], metadata: { direction: 'inbound' } })];
    const [call] = await activityMethods.getCallActivities(TENANT);
    expect((call as any).otherPartyNumber).toBe('+15551110006');
    expect((call as any).entityName).toBe('Jane');
    expect((call as any).entityType).toBe('lead');
  });

  it('returns null number (never throws) when metadata is malformed JSON and no contact phone', async () => {
    h.rows = [baseRow({ metadata: '{not valid json', contactPhones: null })];
    const [call] = await activityMethods.getCallActivities(TENANT);
    expect((call as any).otherPartyNumber).toBeNull();
  });

  it('uses provider-specific fallbacks (customerNumber) from a JSON string', async () => {
    h.rows = [baseRow({ metadata: JSON.stringify({ direction: 'inbound', customerNumber: '+15551110007' }) })];
    const [call] = await activityMethods.getCallActivities(TENANT);
    expect((call as any).otherPartyNumber).toBe('+15551110007');
  });
});
