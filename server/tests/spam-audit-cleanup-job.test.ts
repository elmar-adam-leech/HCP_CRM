import { describe, it, expect, vi, beforeEach } from 'vitest';

type Row = {
  id: string;
  contractorId: string;
  flaggedAt: Date;
  recoveredAt: Date | null;
};

const state = vi.hoisted(() => ({
  rows: [] as Row[],
  selectFilter: null as ((r: Row) => boolean) | null,
  deleteFilter: null as ((r: Row) => boolean) | null,
}));

vi.mock('../db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: (predicate: any) => {
          state.selectFilter = predicate;
          return {
            limit: (n: number) => {
              const filter = state.selectFilter ?? (() => true);
              const matched = state.rows.filter(filter).slice(0, n);
              return Promise.resolve(matched.map((r) => ({ id: r.id })));
            },
          };
        },
      }),
    }),
    delete: () => ({
      where: (predicate: any) => {
        const filter = predicate as (r: Row) => boolean;
        const before = state.rows.length;
        state.rows = state.rows.filter((r) => !filter(r));
        const removed = before - state.rows.length;
        return Promise.resolve({ rowCount: removed });
      },
    }),
  },
}));

vi.mock('@shared/schema', () => ({
  leadCaptureInboxes: {},
  spamAuditLog: {
    id: 'id',
    contractorId: 'contractorId',
    flaggedAt: 'flaggedAt',
    recoveredAt: 'recoveredAt',
  },
}));

vi.mock('drizzle-orm', () => {
  const eq = (col: string, val: any) => ({ kind: 'eq', col, val });
  const and = (...preds: any[]) => (r: Row) => preds.every((p) => evaluate(p, r));
  const or = (...preds: any[]) => (r: Row) => preds.some((p) => evaluate(p, r));
  const isNull = (col: string) => ({ kind: 'isNull', col });
  const isNotNull = (col: string) => ({ kind: 'isNotNull', col });
  const lt = (col: string, val: any) => ({ kind: 'lt', col, val });
  const inArray = (col: string, vals: any[]) => ({ kind: 'in', col, vals });
  const desc = (col: string) => col;
  const count = () => ({ kind: 'count' });

  function evaluate(pred: any, r: Row): boolean {
    if (typeof pred === 'function') return pred(r);
    if (!pred || typeof pred !== 'object') return true;
    const colVal = (r as any)[pred.col];
    switch (pred.kind) {
      case 'eq': return colVal === pred.val;
      case 'isNull': return colVal == null;
      case 'isNotNull': return colVal != null;
      case 'lt': return colVal != null && colVal < pred.val;
      case 'in': return pred.vals.includes(colVal);
      default: return true;
    }
  }

  return { eq, and, or, isNull, isNotNull, lt, inArray, desc, count };
});

vi.mock('../utils/normalize-sender-rules', () => ({
  normalizeSenderRules: (x: any) => x ?? [],
}));

import { leadCaptureMethods } from '../storage/lead-capture';

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';

beforeEach(() => {
  state.rows = [];
  state.selectFilter = null;
});

describe('deleteSpamAuditLogEntry', () => {
  it('only deletes the matching contractor + entry id', async () => {
    state.rows = [
      { id: 'e1', contractorId: TENANT_A, flaggedAt: new Date(), recoveredAt: null },
      { id: 'e2', contractorId: TENANT_A, flaggedAt: new Date(), recoveredAt: null },
      { id: 'e1-other', contractorId: TENANT_B, flaggedAt: new Date(), recoveredAt: null },
    ];

    const deleted = await leadCaptureMethods.deleteSpamAuditLogEntry(TENANT_A, 'e1');
    expect(deleted).toBe(1);
    expect(state.rows.map((r) => r.id).sort()).toEqual(['e1-other', 'e2']);
  });

  it('does not delete a row that belongs to a different contractor', async () => {
    state.rows = [
      { id: 'shared-id', contractorId: TENANT_B, flaggedAt: new Date(), recoveredAt: null },
    ];
    const deleted = await leadCaptureMethods.deleteSpamAuditLogEntry(TENANT_A, 'shared-id');
    expect(deleted).toBe(0);
    expect(state.rows).toHaveLength(1);
  });
});

describe('deleteAllUnrecoveredSpamAuditLog', () => {
  it('deletes only unrecovered rows for the requested contractor and leaves recovered rows alone', async () => {
    state.rows = [
      { id: 'a-unrec-1', contractorId: TENANT_A, flaggedAt: new Date(), recoveredAt: null },
      { id: 'a-unrec-2', contractorId: TENANT_A, flaggedAt: new Date(), recoveredAt: null },
      { id: 'a-rec',     contractorId: TENANT_A, flaggedAt: new Date(), recoveredAt: new Date() },
      { id: 'b-unrec',   contractorId: TENANT_B, flaggedAt: new Date(), recoveredAt: null },
    ];

    const deleted = await leadCaptureMethods.deleteAllUnrecoveredSpamAuditLog(TENANT_A);
    expect(deleted).toBe(2);
    expect(state.rows.map((r) => r.id).sort()).toEqual(['a-rec', 'b-unrec']);
  });

  it('returns 0 when no unrecovered rows exist for the contractor', async () => {
    state.rows = [
      { id: 'a-rec', contractorId: TENANT_A, flaggedAt: new Date(), recoveredAt: new Date() },
    ];
    const deleted = await leadCaptureMethods.deleteAllUnrecoveredSpamAuditLog(TENANT_A);
    expect(deleted).toBe(0);
    expect(state.rows).toHaveLength(1);
  });
});
