/**
 * task #737: pin the storage-probe endpoint contract.
 *
 * The probe is fired from the SPA on cold boot when both the auth_token
 * cookie AND the local storage / IndexedDB JWT mirrors are empty — the
 * exact unauthenticated state we need to measure. So the endpoint MUST:
 *   1. Return `{ supportsBearer: true }` without a session.
 *   2. Be rate-limited (10/min/IP) so a misbehaving client cannot flood
 *      the AuthStorageProbe log.
 *
 * Reachability past the global `requireAuth` middleware in
 * `server/routes.ts` is enforced by inspection: the bypass list explicitly
 * names `/auth/storage-probe`. This test exercises the route handler
 * directly, mirroring the invocation pattern used by the other auth tests
 * (`auth-mint-contract.test.ts`, `webauthn.test.ts`).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { type Express } from 'express';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-storage-probe';

vi.mock('../logger', () => ({
  logger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

interface CallResult {
  status: number;
  body: any;
}

async function call(
  app: Express,
  method: string,
  url: string,
  ip = '127.0.0.1',
): Promise<CallResult> {
  return new Promise((resolve, reject) => {
    const req: any = {
      method, url,
      body: {},
      headers: { host: 'localhost:5000', 'user-agent': 'vitest' },
      protocol: 'http',
      query: {}, params: {},
      ip,
      socket: { remoteAddress: ip },
      get(name: string) { return this.headers[name.toLowerCase()]; },
    };
    const res: any = {
      statusCode: 200,
      cookie() { return this; },
      setHeader() {}, getHeader() {}, removeHeader() {},
      status(c: number) { this.statusCode = c; return this; },
      json(payload: any) { resolve({ status: this.statusCode, body: payload }); return this; },
      send(payload: any) { resolve({ status: this.statusCode, body: payload }); return this; },
      end() { resolve({ status: this.statusCode, body: null }); },
    };
    const stack: any[] = (app as any)._router.stack;
    const handle = (i: number) => {
      if (i >= stack.length) return resolve({ status: 404, body: null });
      const layer = stack[i];
      if (layer.route && layer.route.path === url.split('?')[0] && layer.route.methods[method.toLowerCase()]) {
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
      handle(i + 1);
    };
    handle(0);
  });
}

async function buildApp(): Promise<Express> {
  const app = express();
  app.use(express.json());
  const { registerAuthRoutes } = await import('./auth');
  registerAuthRoutes(app);
  return app;
}

describe('POST /api/auth/storage-probe — task #737', () => {
  let app: Express;

  beforeEach(async () => {
    app = await buildApp();
  });

  it('returns { supportsBearer: true } WITHOUT a session (the unauthenticated probe state)', async () => {
    const res = await call(app, 'POST', '/api/auth/storage-probe');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ supportsBearer: true });
  });

  it('rate-limits to 10 calls per minute per IP', async () => {
    let last: CallResult | undefined;
    // 11th call should 429 (limit is 10/min/IP). Use a unique IP so we
    // don't bleed into the previous test's bucket.
    const ip = '10.20.30.40';
    for (let i = 0; i < 11; i++) {
      last = await call(app, 'POST', '/api/auth/storage-probe', ip);
    }
    expect(last?.status).toBe(429);
  });
});
