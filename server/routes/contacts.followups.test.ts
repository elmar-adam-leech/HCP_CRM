/**
 * Paging contract test for GET /api/follow-ups/unified.
 *
 * The Follow-ups page replaced its single "fetch every row" query with a
 * server-paginated one. We mock the DB layer so the test is hermetic and
 * just asserts the route honors limit/offset, returns the
 * { items, total, hasMore } envelope, and computes hasMore correctly at
 * page boundaries.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { type Express } from 'express';

const { executeMock } = vi.hoisted(() => ({ executeMock: vi.fn() }));

vi.mock('../db', () => ({
  db: { execute: (...args: any[]) => executeMock(...args) },
}));
vi.mock('../storage', () => ({ storage: {} }));
vi.mock('../websocket', () => ({ broadcastToTenant: vi.fn() }));
vi.mock('../utils/orphan-cleanup', () => ({ cleanupOrphanedContact: vi.fn() }));

import { registerContactRoutes } from './contacts';

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { contractorId: 'tenant-1', userId: 'user-1' };
    next();
  });
  registerContactRoutes(app);
  return app;
}

async function call(app: Express, url: string) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const [pathOnly, queryString] = url.split('?');
    const query: Record<string, string> = {};
    if (queryString) for (const [k, v] of new URLSearchParams(queryString)) query[k] = v;
    const req: any = { method: 'GET', url, body: {}, headers: {}, query, params: {}, get: () => undefined };
    void pathOnly;
    const res: any = {
      statusCode: 200,
      setHeader() {}, getHeader() {}, removeHeader() {},
      status(c: number) { this.statusCode = c; return this; },
      json(payload: any) { resolve({ status: this.statusCode, body: payload }); return this; },
      send(payload: any) { resolve({ status: this.statusCode, body: payload }); return this; },
      end() { resolve({ status: this.statusCode, body: undefined }); },
    };
    const stack: any[] = (app as any)._router.stack;
    const handle = (i: number) => {
      if (i >= stack.length) return resolve({ status: 404, body: { error: 'no route' } });
      const layer = stack[i];
      if (layer.route && layer.route.path === pathOnly && layer.route.methods.get) {
        const handlers = layer.route.stack.map((s: any) => s.handle);
        let h = 0;
        const next = (err?: any) => {
          if (err) return reject(err);
          const fn = handlers[h++]; if (!fn) return;
          try { Promise.resolve(fn(req, res, next)).catch(reject); } catch (e) { reject(e); }
        };
        next(); return;
      }
      if (!layer.route && layer.handle.length === 3) {
        layer.handle(req, res, () => handle(i + 1)); return;
      }
      handle(i + 1);
    };
    handle(0);
  });
}

beforeEach(() => {
  executeMock?.mockReset();
});

function makeRow(id: string, totalCount: number) {
  return {
    id,
    row_type: 'lead' as const,
    name: `name-${id}`,
    title: null,
    follow_up_date: new Date('2026-01-15T12:00:00Z'),
    email: null, phone: null, address: null,
    value: null, notes: null, source: null, status: 'new',
    contact_id: null,
    total_count: totalCount,
  };
}

describe('GET /api/follow-ups/unified paging', () => {
  it('returns the {items,total,hasMore} envelope with hasMore=true when more rows remain', async () => {
    executeMock.mockResolvedValue({
      rows: [makeRow('r1', 137), makeRow('r2', 137)],
    });
    const app = makeApp();
    const r = await call(app, '/api/follow-ups/unified?limit=50&offset=0');
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(137);
    expect(r.body.items).toHaveLength(2);
    // 0 (offset) + 2 (returned) < 137 (total) ⇒ more remain.
    expect(r.body.hasMore).toBe(true);
  });

  it('sets hasMore=false on the last page', async () => {
    executeMock.mockResolvedValue({
      rows: [makeRow('r1', 51)],
    });
    const app = makeApp();
    const r = await call(app, '/api/follow-ups/unified?limit=50&offset=50');
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(51);
    // 50 (offset) + 1 (returned) === 51 (total) ⇒ no more pages.
    expect(r.body.hasMore).toBe(false);
  });

  it('returns total=0/hasMore=false when no rows match the date window', async () => {
    executeMock.mockResolvedValue({ rows: [] });
    const app = makeApp();
    const r = await call(app, '/api/follow-ups/unified?from=2030-01-01T00:00:00Z');
    expect(r.status).toBe(200);
    expect(r.body.items).toEqual([]);
    expect(r.body.total).toBe(0);
    expect(r.body.hasMore).toBe(false);
  });

  it('rejects a non-numeric limit with 400', async () => {
    const app = makeApp();
    const r = await call(app, '/api/follow-ups/unified?limit=banana');
    expect(r.status).toBe(400);
  });

  it('widget mode forces limit=5/offset=0 regardless of query params', async () => {
    executeMock.mockResolvedValue({ rows: [makeRow('r1', 1)] });
    const app = makeApp();
    await call(app, '/api/follow-ups/unified?widget=true&limit=200&offset=999');
    // Compile the SQL drizzle handed to the DB and assert the LIMIT/OFFSET
    // params are pinned (5/0) — the caller's 200/999 must NOT survive.
    const sqlObj: any = executeMock.mock.calls[0][0];
    const compiled = sqlObj.toQuery
      ? sqlObj.toQuery({ escapeName: (s: string) => s, escapeParam: (i: number) => `$${i + 1}`, escapeString: (s: string) => `'${s}'` })
      : { params: [] };
    const params: unknown[] = compiled.params ?? [];
    expect(params).toContain(5);
    expect(params).toContain(0);
    expect(params).not.toContain(200);
    expect(params).not.toContain(999);
  });
});
