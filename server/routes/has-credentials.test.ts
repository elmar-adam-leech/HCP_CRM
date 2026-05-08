/**
 * task #738 — pin the no-enumeration contract on
 * GET /api/auth/webauthn/has-credentials.
 *
 * The endpoint MUST NOT leak whether a specific email is registered. For any
 * well-formed email it returns `{ hasAny: true }` regardless of database
 * state. Without an email, it gates on the non-secret `pkhint=1` cookie.
 *
 * The route handler is database-free for the email branch (it does not
 * consult the DB at all), so this test mounts only the route and exercises
 * the handler directly.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { type Express } from 'express';

vi.mock('../db', () => ({ db: {} }));
vi.mock('../auth-service', () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
}));

interface CallResult { status: number; body: any }
async function call(app: Express, method: string, url: string, opts: { cookie?: string; ip?: string } = {}): Promise<CallResult> {
  const ip = opts.ip ?? '127.0.0.1';
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      host: 'localhost:5000', 'user-agent': 'vitest',
    };
    if (opts.cookie) headers.cookie = opts.cookie;
    const req: any = {
      method, url,
      body: {}, headers,
      protocol: 'http',
      query: {}, params: {},
      ip,
      socket: { remoteAddress: ip },
      get(name: string) { return this.headers[name.toLowerCase()]; },
    };
    // parse query from url
    const qIdx = url.indexOf('?');
    if (qIdx >= 0) {
      const qs = url.slice(qIdx + 1);
      qs.split('&').forEach((p) => {
        const [k, v] = p.split('=');
        if (k) req.query[decodeURIComponent(k)] = v ? decodeURIComponent(v) : '';
      });
    }
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
    const path = url.split('?')[0];
    const handle = (i: number) => {
      if (i >= stack.length) return resolve({ status: 404, body: null });
      const layer = stack[i];
      if (layer.route && layer.route.path === path && layer.route.methods[method.toLowerCase()]) {
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
  const { registerWebAuthnRoutes } = await import('./webauthn');
  registerWebAuthnRoutes(app);
  return app;
}

describe('GET /api/auth/webauthn/has-credentials — task #738 anti-enumeration', () => {
  let app: Express;
  beforeEach(async () => { app = await buildApp(); });

  it('returns { hasAny: true } for ANY well-formed email regardless of DB state', async () => {
    const a = await call(app, 'GET', '/api/auth/webauthn/has-credentials?email=alice@example.com', { ip: '10.0.0.1' });
    const b = await call(app, 'GET', '/api/auth/webauthn/has-credentials?email=nobody-here@example.com', { ip: '10.0.0.2' });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // Identical responses — the entire enumeration defense is that the DB is
    // never consulted on this branch.
    expect(a.body).toEqual({ hasAny: true });
    expect(b.body).toEqual({ hasAny: true });
  });

  it('returns { hasAny: false } for a malformed email (UX short-circuit, no oracle)', async () => {
    const r = await call(app, 'GET', '/api/auth/webauthn/has-credentials?email=not-an-email', { ip: '10.0.0.3' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ hasAny: false });
  });

  it('without email: returns { hasAny: false } when pkhint cookie is absent', async () => {
    const r = await call(app, 'GET', '/api/auth/webauthn/has-credentials', { ip: '10.0.0.4' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ hasAny: false });
  });

  it('without email: returns { hasAny: true } when pkhint=1 cookie is present', async () => {
    const r = await call(app, 'GET', '/api/auth/webauthn/has-credentials', {
      ip: '10.0.0.5',
      cookie: 'something=else; pkhint=1; other=x',
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ hasAny: true });
  });

  it('rate-limits to 10 calls per minute per IP (task #738 spec)', async () => {
    const ip = '10.50.50.50';
    let last: CallResult | undefined;
    for (let i = 0; i < 11; i++) {
      last = await call(app, 'GET', '/api/auth/webauthn/has-credentials?email=x@y.com', { ip });
    }
    expect(last?.status).toBe(429);
  });
});
