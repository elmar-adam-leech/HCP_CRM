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
    markTaskCompleted: vi.fn(),
    markTaskSkipped: vi.fn(),
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
    const req: any = {
      method, url, body: body ?? {},
      headers: {}, query: {}, params: {},
      get: () => undefined,
    };
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
