/**
 * Smoke test for the Settings → Sales Process tab integration path.
 *
 * The frontend Settings tab calls GET /api/sales-process to hydrate and
 * PUT /api/sales-process to save. Without a full DB harness in this repo,
 * we exercise the route handlers directly against a mocked storage and
 * assert the contract the UI relies on (load shape, save shape, backfill
 * threshold response field).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { type Express } from 'express';

vi.mock('../storage', () => {
  const storage: any = {
    getSalesProcessWithSteps: vi.fn(),
    upsertSalesProcess: vi.fn(),
    countOpenLeadsForBackfill: vi.fn(),
    listTaskInstances: vi.fn(),
    listTaskInstancesWithLeadSummary: vi.fn(),
    countCompletedTasksSince: vi.fn(),
    retryFailedTask: vi.fn(),
    markTaskCompleted: vi.fn(),
    markTaskSkipped: vi.fn(),
    bulkMarkTasksTerminal: vi.fn(),
    getTaskInstance: vi.fn(),
  };
  return { storage };
});
vi.mock('../auth-service', () => ({
  requireManagerOrAdmin: (_req: any, _res: any, next: any) => next(),
  // The route uses AuthedRequest as a type; injection is via a stub
  // middleware below.
}));
vi.mock('../services/sales-process', () => ({
  backfillOpenLeads: vi.fn().mockResolvedValue({ leadsTouched: 3, tasksCreated: 9 }),
}));
vi.mock('../services/sales-process-cron', () => ({
  runDueAutoTasksOnce: vi.fn().mockResolvedValue({ claimed: 0, sent: 0, failed: 0, skipped: 0 }),
}));

import { storage } from '../storage';
import { registerSalesProcessRoutes } from './sales-process';

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  // Stub auth: every request gets a known tenant + admin user.
  app.use((req, _res, next) => {
    (req as any).user = { contractorId: 'tenant-1', userId: 'user-1' };
    next();
  });
  registerSalesProcessRoutes(app);
  return app;
}

async function call(app: Express, method: string, url: string, body?: any) {
  // Minimal in-process invoker — we don't need supertest for this smoke.
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const [pathOnly, queryString] = url.split('?');
    const query: Record<string, string> = {};
    if (queryString) {
      for (const [k, v] of new URLSearchParams(queryString)) query[k] = v;
    }
    const req: any = {
      method, url, body: body ?? {},
      headers: {}, query, params: {},
      get: () => undefined,
    };
    void pathOnly;
    const chunks: any[] = [];
    const res: any = {
      statusCode: 200,
      setHeader() {}, getHeader() {}, removeHeader() {},
      status(c: number) { this.statusCode = c; return this; },
      json(payload: any) { resolve({ status: this.statusCode, body: payload }); return this; },
      send(payload: any) { resolve({ status: this.statusCode, body: payload }); return this; },
      end() { resolve({ status: this.statusCode, body: chunks.join('') }); },
    };
    const matchUrl = url.split('?')[0];
    // Walk the express router stack to find a matching layer.
    const stack: any[] = (app as any)._router.stack;
    const handle = (i: number) => {
      if (i >= stack.length) return resolve({ status: 404, body: { error: 'no route' } });
      const layer = stack[i];
      if (layer.route && layer.route.path === matchUrl && layer.route.methods[method.toLowerCase()]) {
        // Run the route's stack of handlers in order.
        const handlers = layer.route.stack.map((s: any) => s.handle);
        let h = 0;
        const next = (err?: any) => {
          if (err) return reject(err);
          const fn = handlers[h++];
          if (!fn) return;
          try { Promise.resolve(fn(req, res, next)).catch(reject); } catch (e) { reject(e); }
        };
        next();
        return;
      }
      // For app.use middleware (auth stub), invoke and continue.
      if (!layer.route && layer.handle.length === 3) {
        layer.handle(req, res, () => handle(i + 1));
        return;
      }
      handle(i + 1);
    };
    handle(0);
  });
}

beforeEach(() => vi.clearAllMocks());

describe('Settings → Sales Process tab API smoke', () => {
  it('GET /api/sales-process returns process+steps for the tenant', async () => {
    (storage.getSalesProcessWithSteps as any).mockResolvedValue({
      process: { id: 'p1', contractorId: 'tenant-1', name: 'Default', active: true },
      steps: [{ id: 's1', dayOffset: 1, actionType: 'call', mode: 'manual' }],
    });
    const app = makeApp();
    const r = await call(app, 'GET', '/api/sales-process');
    expect(r.status).toBe(200);
    expect(r.body.process.contractorId).toBe('tenant-1');
    expect(r.body.steps).toHaveLength(1);
    expect((storage.getSalesProcessWithSteps as any).mock.calls[0][0]).toBe('tenant-1');
  });

  it('PUT /api/sales-process accepts a valid cadence and reports backfill counts (sync)', async () => {
    (storage.upsertSalesProcess as any).mockResolvedValue({
      process: { id: 'p1', contractorId: 'tenant-1', active: true },
      steps: [],
      removedStepIds: [],
      changedStepIds: [],
      wasActivated: true,
      previousStepCount: 0,
    });
    (storage.countOpenLeadsForBackfill as any).mockResolvedValue(5); // below threshold
    const app = makeApp();
    const r = await call(app, 'PUT', '/api/sales-process', {
      active: true,
      steps: [
        { dayOffset: 1, actionType: 'call', mode: 'manual', displayOrder: 0 },
        { dayOffset: 4, actionType: 'text', mode: 'auto', messageTemplate: 'hi {{first_name}}', displayOrder: 1 },
      ],
    });
    expect(r.status).toBe(200);
    expect(r.body.wasActivated).toBe(true);
    expect(r.body.backfill).toEqual({ leadsTouched: 3, tasksCreated: 9 });
    expect(r.body.backfillStarted).toBe(false);
  });

  it('PUT /api/sales-process detaches backfill above the threshold (backfillStarted=true)', async () => {
    (storage.upsertSalesProcess as any).mockResolvedValue({
      process: { id: 'p1', contractorId: 'tenant-1', active: true },
      steps: [],
      removedStepIds: [],
      changedStepIds: [],
      wasActivated: true,
      previousStepCount: 0,
    });
    (storage.countOpenLeadsForBackfill as any).mockResolvedValue(500); // above threshold
    const app = makeApp();
    const r = await call(app, 'PUT', '/api/sales-process', {
      active: true,
      steps: [{ dayOffset: 1, actionType: 'call', mode: 'manual', displayOrder: 0 }],
    });
    expect(r.status).toBe(200);
    expect(r.body.backfillStarted).toBe(true);
    expect(r.body.backfill).toEqual({ leadsTouched: 0, tasksCreated: 0 });
  });

  it('GET /api/sales-process/tasks?contactId=...&withLead=1 forwards contactId filter to storage', async () => {
    (storage.listTaskInstancesWithLeadSummary as any).mockResolvedValue({
      items: [
        {
          id: 't1', contractorId: 'tenant-1', leadId: 'lead-A', stepId: 's1',
          actionType: 'call', mode: 'manual', status: 'pending',
          dueAt: new Date().toISOString(),
          lead: { id: 'lead-A', contactId: 'c-1', status: 'new', source: null, createdAt: null, name: 'Jane', email: null, phone: null },
        },
      ],
      total: 1,
    });
    const app = makeApp();
    const r = await call(app, 'GET', '/api/sales-process/tasks?withLead=1&contactId=c-1&status=pending,failed');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
    const callArgs = (storage.listTaskInstancesWithLeadSummary as any).mock.calls[0];
    expect(callArgs[0]).toBe('tenant-1');
    expect(callArgs[1].contactId).toBe('c-1');
    expect(callArgs[1].statuses).toEqual(['pending', 'failed']);
    // leadId must NOT be set when only contactId was passed.
    expect(callArgs[1].leadId).toBeUndefined();
  });

  it('GET /api/sales-process/tasks?paged=1 returns the {items,total,hasMore} envelope and forwards limit/offset', async () => {
    (storage.listTaskInstancesWithLeadSummary as any).mockResolvedValue({
      items: [
        {
          id: 't1', contractorId: 'tenant-1', leadId: 'lead-A', stepId: 's1',
          actionType: 'call', mode: 'manual', status: 'pending',
          dueAt: new Date().toISOString(),
          lead: { id: 'lead-A', contactId: 'c-1', status: 'new', source: null, createdAt: null, name: 'Jane', email: null, phone: null },
        },
      ],
      total: 137,
    });
    const app = makeApp();
    const r = await call(app, 'GET', '/api/sales-process/tasks?withLead=1&paged=1&limit=50&offset=100');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(false);
    expect(r.body.total).toBe(137);
    expect(r.body.items).toHaveLength(1);
    // 100 (offset) + 1 (returned) < 137 (total) ⇒ more pages remain.
    expect(r.body.hasMore).toBe(true);
    const callArgs = (storage.listTaskInstancesWithLeadSummary as any).mock.calls[0];
    expect(callArgs[1].limit).toBe(50);
    expect(callArgs[1].offset).toBe(100);
  });

  it('GET /api/sales-process/tasks?paged=1 sets hasMore=false on the last page', async () => {
    (storage.listTaskInstancesWithLeadSummary as any).mockResolvedValue({
      items: [
        {
          id: 't2', contractorId: 'tenant-1', leadId: 'lead-B', stepId: 's1',
          actionType: 'text', mode: 'auto', status: 'pending',
          dueAt: new Date().toISOString(),
          lead: { id: 'lead-B', contactId: 'c-2', status: 'new', source: null, createdAt: null, name: 'Bob', email: null, phone: null },
        },
      ],
      total: 51,
    });
    const app = makeApp();
    const r = await call(app, 'GET', '/api/sales-process/tasks?withLead=1&paged=1&limit=50&offset=50');
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(51);
    // 50 (offset) + 1 (returned) === 51 (total) ⇒ no more pages.
    expect(r.body.hasMore).toBe(false);
  });

  it('GET /api/sales-process/tasks (no paged flag) preserves the legacy raw-array response', async () => {
    (storage.listTaskInstancesWithLeadSummary as any).mockResolvedValue({
      items: [
        {
          id: 't3', contractorId: 'tenant-1', leadId: 'lead-C', stepId: 's1',
          actionType: 'email', mode: 'manual', status: 'pending',
          dueAt: new Date().toISOString(),
          lead: { id: 'lead-C', contactId: 'c-3', status: 'new', source: null, createdAt: null, name: 'Carol', email: null, phone: null },
        },
      ],
      total: 1,
    });
    const app = makeApp();
    const r = await call(app, 'GET', '/api/sales-process/tasks?withLead=1');
    expect(r.status).toBe(200);
    // Back-compat: clients that haven't migrated to the envelope still
    // receive a plain array of task rows.
    expect(Array.isArray(r.body)).toBe(true);
    expect(r.body).toHaveLength(1);
  });

  it('GET /api/sales-process/tasks?paged=1 forwards status, from, and to scope to storage', async () => {
    (storage.listTaskInstancesWithLeadSummary as any).mockResolvedValue({
      items: [], total: 0,
    });
    const app = makeApp();
    const from = '2026-05-01T00:00:00.000Z';
    const to = '2026-05-02T00:00:00.000Z';
    const r = await call(
      app,
      'GET',
      `/api/sales-process/tasks?withLead=1&paged=1&limit=50&offset=0&status=pending&from=${from}&to=${to}`,
    );
    expect(r.status).toBe(200);
    const callArgs = (storage.listTaskInstancesWithLeadSummary as any).mock.calls[0];
    // Tenant scope is always asserted on arg 0.
    expect(callArgs[0]).toBe('tenant-1');
    // The route must hand the bucket window straight through — paging
    // never widens or drops the from/to/status filters.
    expect(callArgs[1].statuses).toEqual(['pending']);
    expect(callArgs[1].limit).toBe(50);
    expect(callArgs[1].offset).toBe(0);
    expect(callArgs[1].from instanceof Date).toBe(true);
    expect(callArgs[1].to instanceof Date).toBe(true);
    expect((callArgs[1].from as Date).toISOString()).toBe(from);
    expect((callArgs[1].to as Date).toISOString()).toBe(to);
  });

  it('POST /api/sales-process/tasks/bulk-skip runs the batch through one transactional storage call and reports per-id outcome', async () => {
    (storage.bulkMarkTasksTerminal as any).mockResolvedValueOnce(new Map([
      ['a', 'updated'],
      ['b', 'already_terminal'],
      ['c', 'not_found'],
    ]));
    const app = makeApp();
    const r = await call(app, 'POST', '/api/sales-process/tasks/bulk-skip', { ids: ['a', 'b', 'c'] });
    expect(r.status).toBe(200);
    expect(r.body.succeeded).toBe(2);
    expect(r.body.failed).toBe(1);
    expect(r.body.results.find((x: any) => x.id === 'c')).toEqual({ id: 'c', ok: false, error: 'not_found' });
    // Exactly ONE storage call per bulk request — the whole batch is
    // atomic inside the storage layer's drizzle transaction (no
    // per-id loop in the route).
    expect((storage.bulkMarkTasksTerminal as any).mock.calls.length).toBe(1);
    const args = (storage.bulkMarkTasksTerminal as any).mock.calls[0];
    expect(args[0]).toEqual(['a', 'b', 'c']);
    expect(args[1]).toBe('tenant-1'); // tenant scope enforced — no IDOR.
    expect(args[2]).toBe('skipped');
    expect(args[3]).toBe('manual');
    expect(args[4]).toBe('user-1');
  });

  it('POST /api/sales-process/tasks/bulk-complete batches completions through the transactional storage call', async () => {
    (storage.bulkMarkTasksTerminal as any).mockResolvedValueOnce(new Map([
      ['x', 'updated'],
      ['y', 'updated'],
    ]));
    const app = makeApp();
    const r = await call(app, 'POST', '/api/sales-process/tasks/bulk-complete', { ids: ['x', 'y'] });
    expect(r.status).toBe(200);
    expect(r.body.succeeded).toBe(2);
    expect(r.body.failed).toBe(0);
    const args = (storage.bulkMarkTasksTerminal as any).mock.calls[0];
    expect(args[1]).toBe('tenant-1');
    expect(args[2]).toBe('completed');
    expect(args[3]).toBe('manual');
    expect(args[4]).toBe('user-1');
  });

  it('POST /api/sales-process/tasks/bulk-skip surfaces a batch-level failure when the storage transaction rolls back', async () => {
    // Simulate a mid-batch DB error. Because the storage layer wraps
    // the batch in a single drizzle transaction, the whole batch
    // rolls back and the route must report failure for every id —
    // it MUST NOT report partial success.
    (storage.bulkMarkTasksTerminal as any).mockRejectedValueOnce(new Error('db down'));
    const app = makeApp();
    const r = await call(app, 'POST', '/api/sales-process/tasks/bulk-skip', { ids: ['a', 'b', 'c'] });
    expect(r.status).toBe(200);
    expect(r.body.succeeded).toBe(0);
    expect(r.body.failed).toBe(3);
    expect(r.body.results.every((x: any) => x.ok === false && x.error === 'db down')).toBe(true);
  });

  it('POST /api/sales-process/tasks/bulk-skip rejects empty arrays and oversized batches', async () => {
    const app = makeApp();
    const empty = await call(app, 'POST', '/api/sales-process/tasks/bulk-skip', { ids: [] });
    expect(empty.status).toBe(400);
    const tooMany = await call(app, 'POST', '/api/sales-process/tasks/bulk-skip', {
      ids: Array.from({ length: 201 }, (_, i) => `id-${i}`),
    });
    expect(tooMany.status).toBe(400);
  });

  it('PUT /api/sales-process rejects auto+call with a 400 validation error', async () => {
    const app = makeApp();
    const r = await call(app, 'PUT', '/api/sales-process', {
      active: true,
      steps: [{ dayOffset: 1, actionType: 'call', mode: 'auto', displayOrder: 0 }],
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Invalid sales process/);
  });
});
