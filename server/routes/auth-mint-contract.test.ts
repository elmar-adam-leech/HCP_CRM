/**
 * Response-contract tests for the four auth-mint endpoints (#734).
 *
 * Every endpoint that issues an `auth_token` cookie MUST also include a
 * non-empty `refreshToken` string in the JSON body whose value matches the
 * raw token placed in the `refresh_token` cookie. If they ever drift, the
 * IndexedDB fallback added in #720 would seed itself with a value the server
 * has never seen, and the user would be silently logged out on the next
 * cookie eviction. These tests pin the contract so a future refactor cannot
 * regress it without a loud failure.
 *
 * Endpoints under test:
 *   - POST /api/auth/login
 *   - POST /api/mfa/verify
 *   - POST /api/auth/persist-failed   (telemetry sink: 204, unauthenticated, rate-limited shape)
 *
 * (POST /api/auth/webauthn/login/finish is pinned in webauthn.test.ts and
 * the rotated branch of POST /api/auth/refresh is pinned in
 * auth-refresh.test.ts — together they cover all four mint paths.)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { type Express } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-auth-mint-contract';

// ---------------------------------------------------------------------------
// Shared mocks. issueRefreshToken is the linchpin: by mocking it to set the
// cookie + return the same raw value, we can assert that each route mirrors
// that value into the response body — which is the actual contract under
// test. Using a real DB-backed implementation would just add noise.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  rawRefresh: '',
  cookieValue: '',
  resetRefreshToken() {
    this.rawRefresh = crypto.randomBytes(32).toString('hex');
    this.cookieValue = '';
  },
}));

vi.mock('../auth-refresh', async (importActual) => {
  const actual = await importActual<typeof import('../auth-refresh')>();
  return {
    ...actual,
    issueRefreshToken: vi.fn(async (_req: any, res: any) => {
      res.cookie(actual.REFRESH_COOKIE_NAME, mocks.rawRefresh, { httpOnly: true });
      mocks.cookieValue = mocks.rawRefresh;
      return mocks.rawRefresh;
    }),
  };
});

vi.mock('../auth-service', () => ({
  AuthService: {
    generateToken: vi.fn(() => 'fake-jwt'),
    setLoginCookie: (res: any, token: string) => res.cookie('auth_token', token),
    verifyToken: (token: string) => {
      try { return jwt.verify(token, process.env.JWT_SECRET!) as any; }
      catch { return null; }
    },
  },
  requireAuth: (_req: any, _res: any, next: any) => next(),
  requireAdmin: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../utils/audit-log', () => ({ auditLog: vi.fn(async () => undefined) }));

vi.mock('../middleware/rate-limiter', async () => {
  // Real createRateLimiter so the persist-failed shape test exercises actual
  // rate-limit behaviour; permissive bypass for the login/MFA limiters because
  // those aren't what we're trying to test here.
  const passthrough = (_req: any, _res: any, next: any) => next();
  return {
    authLoginRateLimiter: passthrough,
    authRegisterRateLimiter: passthrough,
    authForgotPasswordRateLimiter: passthrough,
    createRateLimiter: (opts: { windowMs: number; maxRequests: number }) => {
      // Tiny in-memory limiter keyed by IP, just enough to verify the
      // persist-failed route is wrapped in *some* limiter.
      const hits = new Map<string, { count: number; resetAt: number }>();
      return (req: any, res: any, next: any) => {
        const key = req.ip ?? '0.0.0.0';
        const now = Date.now();
        const entry = hits.get(key);
        if (!entry || entry.resetAt <= now) {
          hits.set(key, { count: 1, resetAt: now + opts.windowMs });
          return next();
        }
        if (entry.count >= opts.maxRequests) {
          res.status(429).json({ error: 'Too many requests' });
          return;
        }
        entry.count++;
        next();
      };
    },
  };
});

vi.mock('../emails/index', () => ({
  sendGridService: { sendPasswordReset: vi.fn(), sendWelcomeEmail: vi.fn() },
}));

// Storage / DB stubs configured per-suite below via `setupStorage(...)`.
const storageMock = vi.hoisted(() => ({ impl: {} as Record<string, any> }));
vi.mock('../storage', () => ({
  storage: new Proxy({}, {
    get(_t, prop: string) { return storageMock.impl[prop]; },
  }),
}));

const dbMock = vi.hoisted(() => ({ selectResult: [] as any[] }));
vi.mock('../db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => dbMock.selectResult,
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: async () => undefined,
      }),
    }),
  },
}));

// drizzle-orm operators are no-ops here — db is fully mocked above.
vi.mock('drizzle-orm', async () => {
  const actual = await vi.importActual<any>('drizzle-orm');
  return { ...actual, eq: () => ({}), inArray: () => ({}), sql: () => ({}) };
});

// Schema columns/tables are referenced by the route but never executed against
// a real DB in this test, so opaque markers are sufficient.
vi.mock('@shared/schema', () => ({
  users: {},
  userContractors: {},
  passwordResetTokens: {},
  insertUserSchema: { parse: (x: any) => x, partial: () => ({ parse: (x: any) => x }) },
}));

// ---------------------------------------------------------------------------
// Tiny invoker — the same shape used by webauthn.test.ts. We can't use
// supertest because the project doesn't depend on it, and a full http server
// would slow these tests down for no benefit.
// ---------------------------------------------------------------------------

interface CallResult {
  status: number;
  body: any;
  cookies: Record<string, string>;
}

async function call(app: Express, method: string, url: string, body?: any, ip = '127.0.0.1'): Promise<CallResult> {
  return new Promise((resolve, reject) => {
    const cookies: Record<string, string> = {};
    const req: any = {
      method, url,
      body: body ?? {},
      headers: { host: 'localhost:5000', 'user-agent': 'vitest' },
      protocol: 'http',
      query: {}, params: {},
      ip,
      socket: { remoteAddress: ip },
      get(name: string) { return this.headers[name.toLowerCase()]; },
    };
    const res: any = {
      statusCode: 200,
      cookie(name: string, value: string) { cookies[name] = value; return this; },
      setHeader() {}, getHeader() {}, removeHeader() {},
      status(c: number) { this.statusCode = c; return this; },
      json(payload: any) { resolve({ status: this.statusCode, body: payload, cookies }); return this; },
      send(payload: any) { resolve({ status: this.statusCode, body: payload, cookies }); return this; },
      end() { resolve({ status: this.statusCode, body: null, cookies }); },
    };
    const stack: any[] = (app as any)._router.stack;
    const handle = (i: number) => {
      if (i >= stack.length) return resolve({ status: 404, body: null, cookies });
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

// ---------------------------------------------------------------------------
// POST /api/auth/login — happy-path response contract.
// ---------------------------------------------------------------------------
describe('POST /api/auth/login response contract (#734)', () => {
  beforeEach(async () => {
    mocks.resetRefreshToken();
    storageMock.impl = {
      verifyPasswordByEmail: vi.fn(async () => ({
        id: 'user-1', username: 'alice', name: 'Alice', email: 'alice@example.com',
        role: 'admin', contractorId: 'tenant-1', canManageIntegrations: true, tokenVersion: 1,
      })),
      getUserByEmail: vi.fn(),
      ensureUserContractorEntry: vi.fn(async () => ({
        role: 'admin', canManageIntegrations: true, allowedIntegrations: null,
      })),
    };
    // mfaEnabled:false so the route falls through to the mint path.
    dbMock.selectResult = [{ mfaEnabled: false }];
  });

  it('mints both cookies and mirrors the raw refresh value into the response body', async () => {
    const { registerAuthRoutes } = await import('./auth');
    const app = express();
    app.use(express.json());
    registerAuthRoutes(app);

    const r = await call(app, 'POST', '/api/auth/login', {
      email: 'alice@example.com', password: 'pw',
    });

    expect(r.status).toBe(200);
    expect(r.cookies['auth_token']).toBe('fake-jwt');
    // The whole point of #734: body MUST carry the raw refresh token AND it
    // MUST equal what was set in the cookie. If these drift, IDB-only clients
    // will rotate against a value the server doesn't know.
    expect(typeof r.body.refreshToken).toBe('string');
    expect(r.body.refreshToken.length).toBeGreaterThan(0);
    expect(r.body.refreshToken).toBe(r.cookies['refresh_token']);
    expect(r.body.refreshToken).toBe(mocks.rawRefresh);
    // task #737: body MUST also carry the raw auth JWT so the SPA can mirror
    // it into LS+IDB for the cookieless bearer-token fallback path. The body
    // value MUST equal the auth_token cookie value — drift would let an
    // IDB-only client send a bearer the server has never issued.
    expect(typeof r.body.authToken).toBe('string');
    expect(r.body.authToken.length).toBeGreaterThan(0);
    expect(r.body.authToken).toBe(r.cookies['auth_token']);
  });
});

// ---------------------------------------------------------------------------
// POST /api/mfa/verify — same contract on the second factor branch.
// ---------------------------------------------------------------------------
describe('POST /api/mfa/verify response contract (#734)', () => {
  beforeEach(() => {
    mocks.resetRefreshToken();
    storageMock.impl = {
      ensureUserContractorEntry: vi.fn(async () => ({
        role: 'admin', canManageIntegrations: true, allowedIntegrations: null,
      })),
    };
    // The MFA route reaches into db for the user row including the encrypted
    // secret. We short-circuit by mocking decryptSecret + OTPAuth below.
    dbMock.selectResult = [{
      id: 'user-1', username: 'alice', name: 'Alice', email: 'alice@example.com',
      role: 'admin', contractorId: 'tenant-1', canManageIntegrations: true, tokenVersion: 1,
      mfaEnabled: true,
      mfaSecretEncrypted: { encrypted: 'x', iv: 'y', authTag: 'z' },
      mfaRecoveryCodes: [],
    }];
  });

  it('mints both cookies and mirrors the raw refresh value into the response body', async () => {
    // Skip the real TOTP machinery — the contract under test is the response
    // shape after a successful verify, not the cryptography of OTPAuth itself.
    vi.doMock('../utils/crypto', () => ({
      decryptSecret: vi.fn(() => 'JBSWY3DPEHPK3PXP'),
      encryptSecret: vi.fn(() => ({ encrypted: '', iv: '', authTag: '' })),
    }));
    vi.doMock('otpauth', () => ({
      Secret: { fromBase32: () => ({}) },
      TOTP: class { validate() { return 0; } generate() { return '000000'; } },
    }));

    const { registerMFARoutes } = await import('./mfa');
    const app = express();
    app.use(express.json());
    registerMFARoutes(app);

    const pendingToken = jwt.sign(
      { purpose: 'mfa_pending', userId: 'user-1', contractorId: 'tenant-1' },
      process.env.JWT_SECRET!,
      { expiresIn: '5m' },
    );

    const r = await call(app, 'POST', '/api/mfa/verify', {
      pendingToken, code: '000000',
    });

    expect(r.status).toBe(200);
    expect(r.cookies['auth_token']).toBe('fake-jwt');
    expect(typeof r.body.refreshToken).toBe('string');
    expect(r.body.refreshToken.length).toBeGreaterThan(0);
    expect(r.body.refreshToken).toBe(r.cookies['refresh_token']);
    expect(r.body.refreshToken).toBe(mocks.rawRefresh);
    // task #737: body MUST also carry the raw auth JWT (matches auth_token
    // cookie). Same drift-prevention reasoning as the login contract above.
    expect(typeof r.body.authToken).toBe('string');
    expect(r.body.authToken.length).toBeGreaterThan(0);
    expect(r.body.authToken).toBe(r.cookies['auth_token']);
  });
});

// ---------------------------------------------------------------------------
// POST /api/auth/persist-failed — telemetry sink shape (#734).
// ---------------------------------------------------------------------------
describe('POST /api/auth/persist-failed (#734 telemetry sink)', () => {
  beforeEach(() => {
    storageMock.impl = {};
    dbMock.selectResult = [];
  });

  async function mountApp(): Promise<Express> {
    const { registerAuthRoutes } = await import('./auth');
    const app = express();
    app.use(express.json());
    registerAuthRoutes(app);
    return app;
  }

  it('returns 204 with no body for a well-formed payload, with no auth required', async () => {
    const app = await mountApp();
    const r = await call(app, 'POST', '/api/auth/persist-failed', {
      stage: 'login', errorName: 'QuotaExceededError',
    });
    expect(r.status).toBe(204);
    // Must NOT echo the payload back — this is a fire-and-forget sink and any
    // echoed content could become an oracle.
    expect(r.body).toBeNull();
  });

  it('still returns 204 when the body is empty / malformed (defensive sink)', async () => {
    const app = await mountApp();
    const r = await call(app, 'POST', '/api/auth/persist-failed', {});
    expect(r.status).toBe(204);
  });

  it('is wrapped by a per-IP rate limiter (5/min), so a noisy device cannot flood logs', async () => {
    const app = await mountApp();
    const ip = '203.0.113.7';
    for (let i = 0; i < 5; i++) {
      const r = await call(app, 'POST', '/api/auth/persist-failed', { stage: 's', errorName: 'e' }, ip);
      expect(r.status).toBe(204);
    }
    const sixth = await call(app, 'POST', '/api/auth/persist-failed', { stage: 's', errorName: 'e' }, ip);
    expect(sixth.status).toBe(429);
  });
});
