/**
 * Task #678 — HCP webhook receiver resilience.
 *
 * Verifies the receiver always returns 200 to Housecall Pro on parseable JSON
 * — even when the contractor lookup throws (DB hiccup), the contractor row
 * does not exist, the body is unparseable, or it's an HCP "Save URL"
 * verification ping. HCP auto-disables webhook subscriptions after repeated
 * non-2xx responses, so any path that returns 5xx during a transient outage
 * is a regression we must catch.
 *
 * Mock-path note: vi.mock() resolves module specifiers relative to the file
 * being tested (the receiver), not the test file. The receiver lives at
 * `server/routes/webhooks/housecall-pro/index.ts`, so we mock with the same
 * paths it uses (`./auth`, `./dispatch`, `../../services/cache`, etc.) by
 * referencing the absolute resolved paths from the test file.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { type Express } from 'express';

const { getContractorCachedMock, verifyAuthMock, processEventMock, dbInsertCalls } = vi.hoisted(() => ({
  getContractorCachedMock: vi.fn(),
  verifyAuthMock: vi.fn(),
  processEventMock: vi.fn(),
  dbInsertCalls: { count: 0 },
}));

// Path: receiver imports `'../../services/cache'` → server/services/cache.
// From this test file (`server/tests/...`), that's `'../services/cache'`.
vi.mock('../services/cache', () => ({
  getContractorCached: (...args: unknown[]) => getContractorCachedMock(...args),
}));

// Path: receiver imports `'../../../db'` → server/db.
// From this test file, that's `'../db'`.
vi.mock('../db', () => ({
  db: {
    insert: () => {
      dbInsertCalls.count += 1;
      const chain: any = {
        values: () => chain,
        returning: () => Promise.resolve([{ id: 'evt-1' }]),
        then: (onFulfilled: (v: unknown[]) => unknown) => Promise.resolve([]).then(onFulfilled),
        catch: () => chain,
      };
      return chain;
    },
  },
}));

// Path: receiver imports `'../../../middleware/rate-limiter'` →
// server/middleware/rate-limiter. From the test file that's
// `'../middleware/rate-limiter'`.
vi.mock('../middleware/rate-limiter', () => ({
  webhookRateLimiter: (_req: any, _res: any, next: any) => next(),
}));

// Path: receiver imports `'./auth'` →
// server/routes/webhooks/housecall-pro/auth. From the test file that's
// `'../routes/webhooks/housecall-pro/auth'`.
vi.mock('../routes/webhooks/housecall-pro/auth', () => ({
  verifyHcpWebhookAuth: (...args: unknown[]) => verifyAuthMock(...args),
}));

// Path: receiver imports `'./dispatch'` →
// server/routes/webhooks/housecall-pro/dispatch. From the test file that's
// `'../routes/webhooks/housecall-pro/dispatch'`.
vi.mock('../routes/webhooks/housecall-pro/dispatch', () => ({
  processHcpEvent: (...args: unknown[]) => processEventMock(...args),
}));

// Logger is non-essential and noisy; suppress its output.
vi.mock('../utils/logger', () => ({
  logger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

import { registerHousecallProWebhookRoutes } from '../routes/webhooks/housecall-pro/index';

const CONTRACTOR_ID = 'contractor-resilience-001';

function makeApp(): Express {
  const app = express();
  // Mirror the production raw-body branch for HCP webhooks.
  app.use((req, _res, next) => {
    if (req.path.startsWith('/api/webhooks/')) {
      return express.raw({ type: 'application/json' })(req, _res, next);
    }
    return next();
  });
  registerHousecallProWebhookRoutes(app);
  return app;
}

/**
 * Drive the receiver with a synthetic request/response. We capture the
 * response and then drain pending microtasks + one setImmediate cycle so
 * background work (auth + dispatch) has a chance to run before the test's
 * post-conditions are checked.
 */
async function postWebhook(app: Express, bodyJson: string): Promise<{ status: number; body: any }> {
  const result = await new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req: any = {
      method: 'POST',
      url: `/api/webhooks/${CONTRACTOR_ID}/housecall-pro`,
      body: Buffer.from(bodyJson, 'utf8'),
      headers: { 'content-type': 'application/json' },
      query: {},
      params: { contractorId: CONTRACTOR_ID },
      ip: '127.0.0.1',
      get: () => undefined,
    };
    const res: any = {
      statusCode: 200,
      headers: {} as Record<string, string>,
      setHeader(k: string, v: string) { this.headers[k] = v; },
      getHeader(k: string) { return this.headers[k]; },
      removeHeader(k: string) { delete this.headers[k]; },
      status(c: number) { this.statusCode = c; return this; },
      json(payload: any) { resolve({ status: this.statusCode, body: payload }); return this; },
      send(payload: any) { resolve({ status: this.statusCode, body: payload }); return this; },
      end() { resolve({ status: this.statusCode, body: undefined }); },
    };
    const stack: any[] = (app as any)._router.stack;
    const matchPath = `/api/webhooks/:contractorId/housecall-pro`;
    for (const layer of stack) {
      if (
        layer.route &&
        layer.route.path === matchPath &&
        layer.route.methods.post
      ) {
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
    }
    resolve({ status: 404, body: { error: 'no route' } });
  });

  // Allow the receiver's setImmediate background worker (and any awaits
  // inside it) to run before the test makes assertions.
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));

  return result;
}

beforeEach(() => {
  vi.clearAllMocks();
  dbInsertCalls.count = 0;
  // Default: auth succeeds, dispatch is a no-op.
  verifyAuthMock.mockResolvedValue({ ok: true });
  processEventMock.mockResolvedValue(undefined);
});

describe('HCP webhook receiver — restart resilience (Task #678)', () => {
  it('returns 200 even when contractor lookup throws (DB hiccup)', async () => {
    getContractorCachedMock.mockRejectedValue(new Error('Neon: connection terminated unexpectedly'));
    const app = makeApp();

    const result = await postWebhook(app, JSON.stringify({
      event: 'estimate.updated',
      estimate: { id: 'est-123' },
      occurred_at: new Date().toISOString(),
    }));

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ received: true });
    // Background work must NOT have called dispatch when lookup failed.
    expect(processEventMock).not.toHaveBeenCalled();
  });

  it('returns 200 even when the contractor row does not exist', async () => {
    getContractorCachedMock.mockResolvedValue(undefined);
    const app = makeApp();

    const result = await postWebhook(app, JSON.stringify({
      event: 'estimate.updated',
      estimate: { id: 'est-456' },
    }));

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ received: true });
    expect(processEventMock).not.toHaveBeenCalled();
  });

  it('returns 200 and dispatches the event in the background when everything is healthy', async () => {
    getContractorCachedMock.mockResolvedValue({ id: CONTRACTOR_ID });
    const app = makeApp();

    const result = await postWebhook(app, JSON.stringify({
      event: 'estimate.updated',
      estimate: { id: 'est-789' },
    }));

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ received: true });
    // Auth verification + dispatch ran in setImmediate.
    expect(verifyAuthMock).toHaveBeenCalledOnce();
    expect(processEventMock).toHaveBeenCalledOnce();
    expect(processEventMock).toHaveBeenCalledWith(
      CONTRACTOR_ID,
      'estimate.updated',
      expect.objectContaining({ id: 'est-789' }),
      expect.any(String),
      undefined,
    );
  });

  it('returns 200 for the HCP "Save URL" verification ping (no event field)', async () => {
    getContractorCachedMock.mockResolvedValue({ id: CONTRACTOR_ID });
    const app = makeApp();

    const result = await postWebhook(app, JSON.stringify({ foo: 'bar' }));

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ received: true });
    // Verification pings bypass auth/dispatch entirely.
    expect(verifyAuthMock).not.toHaveBeenCalled();
    expect(processEventMock).not.toHaveBeenCalled();
  });

  it('returns 200 (with received=true) on unparseable JSON instead of 400', async () => {
    getContractorCachedMock.mockResolvedValue({ id: CONTRACTOR_ID });
    const app = makeApp();

    const result = await postWebhook(app, '{not valid json');

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ received: true });
    // Bad JSON is dropped before contractor lookup.
    expect(getContractorCachedMock).not.toHaveBeenCalled();
    expect(processEventMock).not.toHaveBeenCalled();
  });

  it('does not dispatch when auth verification fails (audit-only)', async () => {
    getContractorCachedMock.mockResolvedValue({ id: CONTRACTOR_ID });
    verifyAuthMock.mockResolvedValue({ ok: false, reason: 'invalid_signature' });
    const app = makeApp();

    const result = await postWebhook(app, JSON.stringify({
      event: 'estimate.updated',
      estimate: { id: 'est-bad-sig' },
    }));

    // Still 200 to HCP — they should not auto-disable our subscription
    // because of an attacker probing.
    expect(result.status).toBe(200);
    expect(verifyAuthMock).toHaveBeenCalledOnce();
    expect(processEventMock).not.toHaveBeenCalled();
  });
});
