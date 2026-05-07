/**
 * Unit tests for the WebAuthn passkey routes (Task #651).
 *
 * We mock the database layer and the @simplewebauthn/server library so we can
 * exercise the route handlers' contract: challenge issuance, payload
 * validation, credential persistence, and the unauth login path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { type Express } from 'express';
import { verifyAuthenticationResponse } from '@simplewebauthn/server';

// In-memory fake DB ------------------------------------------------------
type CredRow = {
  id: string;
  userId: string;
  credentialId: string;
  publicKey: string;
  counter: number;
  transports: string[] | null;
  deviceLabel: string;
  createdAt: Date;
  lastUsedAt: Date | null;
};
type ChallengeRow = {
  id: string;
  userId: string | null;
  sessionId: string | null;
  challenge: string;
  purpose: string;
  expiresAt: Date;
};
const fakeDb = {
  credentials: [] as CredRow[],
  challenges: [] as ChallengeRow[],
  reset() { this.credentials = []; this.challenges = []; },
};

vi.mock('../db', () => {
  const matchEq = (row: any, condition: any): boolean => {
    if (!condition) return true;
    if (condition.kind === 'and') return condition.parts.every((p: any) => matchEq(row, p));
    if (condition.kind === 'eq') return row[condition.field] === condition.value;
    if (condition.kind === 'lt') return row[condition.field] < condition.value;
    return true;
  };
  const tableFor = (table: any): any[] => {
    if (table.__tableName === 'webauthn_credentials') return fakeDb.credentials;
    if (table.__tableName === 'webauthn_challenges') return fakeDb.challenges;
    throw new Error('unknown table');
  };
  const db = {
    select(_cols?: any) {
      return {
        from(table: any) {
          return {
            where(condition: any) {
              const rows = tableFor(table).filter((r) => matchEq(r, condition));
              return {
                limit(n: number) { return Promise.resolve(rows.slice(0, n)); },
                then(resolve: any) { resolve(rows); },
              };
            },
          };
        },
      };
    },
    insert(table: any) {
      return {
        values(data: any) {
          const id = `id-${Math.random().toString(36).slice(2, 10)}`;
          const row = {
            id,
            createdAt: new Date(),
            ...data,
          };
          tableFor(table).push(row as any);
          return {
            returning() { return Promise.resolve([row]); },
            then(resolve: any) { resolve([row]); },
          };
        },
      };
    },
    delete(table: any) {
      return {
        where(condition: any) {
          const arr = tableFor(table);
          const removed: any[] = [];
          for (let i = arr.length - 1; i >= 0; i--) {
            if (matchEq(arr[i], condition)) {
              removed.push(arr[i]);
              arr.splice(i, 1);
            }
          }
          return {
            returning() { return Promise.resolve(removed); },
            then(resolve: any) { resolve(removed); },
          };
        },
      };
    },
    update(table: any) {
      return {
        set(patch: any) {
          return {
            where(condition: any) {
              const arr = tableFor(table);
              for (const r of arr) {
                if (matchEq(r, condition)) Object.assign(r, patch);
              }
              return Promise.resolve();
            },
          };
        },
      };
    },
  };
  return { db };
});

// drizzle-orm operator stand-ins return tagged objects our fake matches against.
vi.mock('drizzle-orm', async () => {
  const actual = await vi.importActual<any>('drizzle-orm');
  return {
    ...actual,
    eq: (col: any, value: any) => ({ kind: 'eq', field: col.__fieldName, value }),
    and: (...parts: any[]) => ({ kind: 'and', parts }),
    lt: (col: any, value: any) => ({ kind: 'lt', field: col.__fieldName, value }),
  };
});

// Schema stub: tag tables/columns so the fake DB can dispatch on them.
vi.mock('@shared/schema', () => {
  const makeColumn = (name: string) => ({ __fieldName: name });
  const credentialColumns = {
    id: makeColumn('id'),
    userId: makeColumn('userId'),
    credentialId: makeColumn('credentialId'),
    publicKey: makeColumn('publicKey'),
    counter: makeColumn('counter'),
    transports: makeColumn('transports'),
    deviceLabel: makeColumn('deviceLabel'),
    createdAt: makeColumn('createdAt'),
    lastUsedAt: makeColumn('lastUsedAt'),
  };
  const challengeColumns = {
    id: makeColumn('id'),
    userId: makeColumn('userId'),
    sessionId: makeColumn('sessionId'),
    challenge: makeColumn('challenge'),
    purpose: makeColumn('purpose'),
    expiresAt: makeColumn('expiresAt'),
    createdAt: makeColumn('createdAt'),
  };
  return {
    webauthnCredentials: { __tableName: 'webauthn_credentials', ...credentialColumns },
    webauthnChallenges: { __tableName: 'webauthn_challenges', ...challengeColumns },
  };
});

// SimpleWebAuthn server stubs --------------------------------------------
vi.mock('@simplewebauthn/server', () => ({
  generateRegistrationOptions: vi.fn(async () => ({ challenge: 'register-challenge', rp: { id: 'localhost', name: 'HCP CRM' } })),
  verifyRegistrationResponse: vi.fn(async () => ({
    verified: true,
    registrationInfo: {
      credential: {
        id: 'cred-abc',
        publicKey: new Uint8Array([1, 2, 3, 4]),
        counter: 0,
        transports: ['internal'],
      },
    },
  })),
  generateAuthenticationOptions: vi.fn(async () => ({ challenge: 'login-challenge' })),
  verifyAuthenticationResponse: vi.fn(async () => ({
    verified: true,
    authenticationInfo: { newCounter: 1 },
  })),
}));
vi.mock('@simplewebauthn/server/helpers', () => ({
  isoBase64URL: {
    fromBuffer: (buf: Uint8Array) => Buffer.from(buf).toString('base64url'),
    toBuffer: (s: string) => new Uint8Array(Buffer.from(s, 'base64url')),
  },
  isoUint8Array: {
    fromUTF8String: (s: string) => new TextEncoder().encode(s),
  },
}));

// Storage + AuthService + audit ------------------------------------------
vi.mock('../storage', () => ({
  storage: {
    getUser: vi.fn(async (id: string) => ({
      id,
      username: 'u',
      name: 'User',
      email: 'u@example.com',
      role: 'admin',
      contractorId: 'tenant-1',
      canManageIntegrations: true,
      tokenVersion: 1,
    })),
    ensureUserContractorEntry: vi.fn(async () => ({
      role: 'admin',
      canManageIntegrations: true,
      allowedIntegrations: null,
    })),
    // issueRefreshToken (called from the WebAuthn login finish path) writes a
    // row through storage.createRefreshToken — without this stub the test would
    // throw a TypeError and never reach the response-contract assertions.
    createRefreshToken: vi.fn(async () => ({ id: 'refresh-row' })),
  },
}));
vi.mock('../auth-service', () => ({
  AuthService: {
    generateToken: vi.fn(() => 'fake-jwt-token'),
    setLoginCookie: (res: any, token: string) => res.cookie('auth_token', token),
  },
  requireAuth: (req: any, _res: any, next: any) => {
    if (!req.user) req.user = {
      userId: 'user-1',
      contractorId: 'tenant-1',
      email: 'u@example.com',
      name: 'User',
      role: 'admin',
    };
    next();
  },
}));
vi.mock('../utils/audit-log', () => ({ auditLog: vi.fn(async () => undefined) }));
vi.mock('../middleware/rate-limiter', () => ({
  authLoginRateLimiter: (_req: any, _res: any, next: any) => next(),
}));

import { registerWebAuthnRoutes } from './webauthn';

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = {
      userId: 'user-1',
      contractorId: 'tenant-1',
      email: 'u@example.com',
      name: 'User',
      role: 'admin',
    };
    next();
  });
  registerWebAuthnRoutes(app);
  return app;
}

async function call(app: Express, method: string, url: string, body?: any) {
  return new Promise<{ status: number; body: any; headers: Record<string, string> }>((resolve, reject) => {
    const matchUrl = url.split('?')[0];
    const params: Record<string, string> = {};
    const req: any = {
      method,
      url,
      body: body ?? {},
      headers: { host: 'localhost:5000', 'user-agent': 'jsdom' },
      protocol: 'http',
      query: {},
      params,
      get(name: string) { return this.headers[name.toLowerCase()]; },
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
    };
    const cookies: Record<string, string> = {};
    const res: any = {
      statusCode: 200,
      _cookies: cookies,
      cookie(name: string, value: string) { cookies[name] = value; return this; },
      setHeader() {}, getHeader() {}, removeHeader() {},
      status(c: number) { this.statusCode = c; return this; },
      json(payload: any) { resolve({ status: this.statusCode, body: payload, headers: cookies }); return this; },
      send(payload: any) { resolve({ status: this.statusCode, body: payload, headers: cookies }); return this; },
      end() { resolve({ status: this.statusCode, body: null, headers: cookies }); },
    };
    const stack: any[] = (app as any)._router.stack;
    const handle = (i: number) => {
      if (i >= stack.length) return resolve({ status: 404, body: { error: 'no route' }, headers: cookies });
      const layer = stack[i];
      // Exact path match (handles ":id" param)
      if (layer.route) {
        const path = layer.route.path as string;
        const re = new RegExp('^' + path.replace(/:([^/]+)/g, (_, n) => `(?<${n}>[^/]+)`) + '$');
        const m = re.exec(matchUrl);
        if (m && layer.route.methods[method.toLowerCase()]) {
          if (m.groups) Object.assign(params, m.groups);
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
      if (!layer.route && layer.handle.length === 3) {
        layer.handle(req, res, () => handle(i + 1));
        return;
      }
      handle(i + 1);
    };
    handle(0);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  fakeDb.reset();
});

describe('WebAuthn registration', () => {
  it('POST /register/begin issues options and stores a register challenge', async () => {
    const app = makeApp();
    const r = await call(app, 'POST', '/api/auth/webauthn/register/begin');
    expect(r.status).toBe(200);
    expect(r.body.challenge).toBe('register-challenge');
    expect(fakeDb.challenges).toHaveLength(1);
    expect(fakeDb.challenges[0].userId).toBe('user-1');
    expect(fakeDb.challenges[0].purpose).toBe('register');
    expect(fakeDb.challenges[0].expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('POST /register/finish persists the credential and consumes the challenge', async () => {
    fakeDb.challenges.push({
      id: 'chal-1', userId: 'user-1', sessionId: null,
      challenge: 'register-challenge', purpose: 'register',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const app = makeApp();
    const r = await call(app, 'POST', '/api/auth/webauthn/register/finish', { response: { id: 'cred-abc' } });
    expect(r.status).toBe(200);
    expect(r.body.deviceLabel).toMatch(/Unknown device|Mac|iPhone|Android|Windows|Linux/);
    expect(fakeDb.credentials).toHaveLength(1);
    expect(fakeDb.credentials[0].userId).toBe('user-1');
    expect(fakeDb.credentials[0].credentialId).toBe('cred-abc');
    expect(fakeDb.challenges).toHaveLength(0);
  });

  it('POST /register/finish rejects an expired challenge', async () => {
    fakeDb.challenges.push({
      id: 'chal-1', userId: 'user-1', sessionId: null,
      challenge: 'register-challenge', purpose: 'register',
      expiresAt: new Date(Date.now() - 1000),
    });
    const app = makeApp();
    const r = await call(app, 'POST', '/api/auth/webauthn/register/finish', { response: { id: 'cred-abc' } });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/expired/i);
  });

  it('POST /register/finish rejects when no challenge exists', async () => {
    const app = makeApp();
    const r = await call(app, 'POST', '/api/auth/webauthn/register/finish', { response: { id: 'cred-abc' } });
    expect(r.status).toBe(400);
  });
});

describe('WebAuthn login (unauth)', () => {
  it('POST /login/begin issues a sessionId-bound challenge', async () => {
    const app = makeApp();
    const r = await call(app, 'POST', '/api/auth/webauthn/login/begin');
    expect(r.status).toBe(200);
    expect(typeof r.body.sessionId).toBe('string');
    expect(r.body.options.challenge).toBe('login-challenge');
    expect(fakeDb.challenges).toHaveLength(1);
    expect(fakeDb.challenges[0].sessionId).toBe(r.body.sessionId);
    expect(fakeDb.challenges[0].purpose).toBe('login');
  });

  it('POST /login/finish issues an auth_token cookie on success', async () => {
    fakeDb.credentials.push({
      id: 'c-1', userId: 'user-1', credentialId: 'cred-abc',
      publicKey: Buffer.from([9, 9]).toString('base64url'),
      counter: 0, transports: ['internal'], deviceLabel: 'iPhone (Safari)',
      createdAt: new Date(), lastUsedAt: null,
    });
    fakeDb.challenges.push({
      id: 'chal-1', userId: null, sessionId: 'sess-1',
      challenge: 'login-challenge', purpose: 'login',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const app = makeApp();
    const r = await call(app, 'POST', '/api/auth/webauthn/login/finish', {
      sessionId: 'sess-1',
      response: { id: 'cred-abc' },
    });
    expect(r.status).toBe(200);
    expect(r.body.message).toBe('Login successful');
    expect(r.headers.auth_token).toBe('fake-jwt-token');
    // #734 response contract: every endpoint that mints an auth_token cookie
    // MUST also include a non-empty `refreshToken` in the JSON body whose value
    // matches the raw value placed in the refresh_token cookie. Otherwise an
    // IDB-only client (cookie evicted by Safari) would seed its fallback with
    // a token that doesn't match what the server later rotates against.
    expect(typeof r.body.refreshToken).toBe('string');
    expect(r.body.refreshToken.length).toBeGreaterThan(0);
    expect(r.headers.refresh_token).toBe(r.body.refreshToken);
    // Counter advanced + lastUsedAt stamped
    expect(fakeDb.credentials[0].counter).toBe(1);
    expect(fakeDb.credentials[0].lastUsedAt).toBeInstanceOf(Date);
    // Challenge consumed
    expect(fakeDb.challenges).toHaveLength(0);
  });

  it('POST /login/finish rejects an unknown credential', async () => {
    fakeDb.challenges.push({
      id: 'chal-1', userId: null, sessionId: 'sess-1',
      challenge: 'login-challenge', purpose: 'login',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const app = makeApp();
    const r = await call(app, 'POST', '/api/auth/webauthn/login/finish', {
      sessionId: 'sess-1',
      response: { id: 'unknown-cred' },
    });
    expect(r.status).toBe(401);
    expect(r.body.message).toMatch(/not recognised/i);
    // Challenge still consumed (single-use even on failure)
    expect(fakeDb.challenges).toHaveLength(0);
  });

  it('POST /login/finish rejects an expired login challenge', async () => {
    fakeDb.challenges.push({
      id: 'chal-1', userId: null, sessionId: 'sess-1',
      challenge: 'login-challenge', purpose: 'login',
      expiresAt: new Date(Date.now() - 1000),
    });
    const app = makeApp();
    const r = await call(app, 'POST', '/api/auth/webauthn/login/finish', {
      sessionId: 'sess-1',
      response: { id: 'cred-abc' },
    });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/expired/i);
  });

  it('POST /login/finish 400s on a malformed payload', async () => {
    const app = makeApp();
    const r = await call(app, 'POST', '/api/auth/webauthn/login/finish', {});
    expect(r.status).toBe(400);
  });

  it('POST /login/finish rejects a counter regression (cloned authenticator)', async () => {
    // Stored counter is 5; the authenticator response only claims 5 — that's
    // a regression and must be treated as a possible cloned credential.
    fakeDb.credentials.push({
      id: 'c-1', userId: 'user-1', credentialId: 'cred-abc',
      publicKey: Buffer.from([9, 9]).toString('base64url'),
      counter: 5, transports: ['internal'], deviceLabel: 'iPhone (Safari)',
      createdAt: new Date(), lastUsedAt: null,
    });
    fakeDb.challenges.push({
      id: 'chal-1', userId: null, sessionId: 'sess-1',
      challenge: 'login-challenge', purpose: 'login',
      expiresAt: new Date(Date.now() + 60_000),
    });
    vi.mocked(verifyAuthenticationResponse).mockResolvedValueOnce({
      verified: true,
      authenticationInfo: { newCounter: 5 },
    } as any);
    const app = makeApp();
    const r = await call(app, 'POST', '/api/auth/webauthn/login/finish', {
      sessionId: 'sess-1',
      response: { id: 'cred-abc' },
    });
    expect(r.status).toBe(401);
    expect(r.body.message).toMatch(/sign-in failed/i);
    // Stored counter was NOT advanced — regression rejected before update.
    expect(fakeDb.credentials[0].counter).toBe(5);
    // No auth cookie issued
    expect(r.headers.auth_token).toBeUndefined();
    // Single-use challenge still consumed.
    expect(fakeDb.challenges).toHaveLength(0);
  });

  it('POST /login/finish rejects a previously revoked (deleted) credential', async () => {
    // Simulate the user having removed their passkey via DELETE /credentials/:id.
    // The credential row no longer exists, but the device still tries to use it.
    fakeDb.challenges.push({
      id: 'chal-1', userId: null, sessionId: 'sess-1',
      challenge: 'login-challenge', purpose: 'login',
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(fakeDb.credentials).toHaveLength(0);
    const app = makeApp();
    const r = await call(app, 'POST', '/api/auth/webauthn/login/finish', {
      sessionId: 'sess-1',
      response: { id: 'revoked-cred-id' },
    });
    expect(r.status).toBe(401);
    expect(r.body.message).toMatch(/not recognised/i);
    expect(r.headers.auth_token).toBeUndefined();
    // Challenge consumed (single-use).
    expect(fakeDb.challenges).toHaveLength(0);
  });

  it('POST /login/finish rejects when the underlying verification returns verified=false', async () => {
    fakeDb.credentials.push({
      id: 'c-1', userId: 'user-1', credentialId: 'cred-abc',
      publicKey: Buffer.from([9, 9]).toString('base64url'),
      counter: 0, transports: ['internal'], deviceLabel: 'iPhone (Safari)',
      createdAt: new Date(), lastUsedAt: null,
    });
    fakeDb.challenges.push({
      id: 'chal-1', userId: null, sessionId: 'sess-1',
      challenge: 'login-challenge', purpose: 'login',
      expiresAt: new Date(Date.now() + 60_000),
    });
    vi.mocked(verifyAuthenticationResponse).mockResolvedValueOnce({
      verified: false,
      authenticationInfo: { newCounter: 1 },
    } as any);
    const app = makeApp();
    const r = await call(app, 'POST', '/api/auth/webauthn/login/finish', {
      sessionId: 'sess-1',
      response: { id: 'cred-abc' },
    });
    expect(r.status).toBe(401);
    // Counter NOT advanced
    expect(fakeDb.credentials[0].counter).toBe(0);
  });
});

describe('WebAuthn credential management', () => {
  it('GET /credentials returns the current user\'s passkeys', async () => {
    fakeDb.credentials.push({
      id: 'c-1', userId: 'user-1', credentialId: 'cred-abc',
      publicKey: 'pk', counter: 0, transports: null, deviceLabel: 'iPhone (Safari)',
      createdAt: new Date(), lastUsedAt: null,
    });
    fakeDb.credentials.push({
      id: 'c-2', userId: 'someone-else', credentialId: 'other',
      publicKey: 'pk', counter: 0, transports: null, deviceLabel: 'Other',
      createdAt: new Date(), lastUsedAt: null,
    });
    const app = makeApp();
    const r = await call(app, 'GET', '/api/auth/webauthn/credentials');
    expect(r.status).toBe(200);
    expect(r.body.credentials).toHaveLength(1);
    expect(r.body.credentials[0].id).toBe('c-1');
  });

  it('DELETE /credentials/:id removes only the caller\'s passkey', async () => {
    fakeDb.credentials.push({
      id: 'c-1', userId: 'user-1', credentialId: 'cred-abc',
      publicKey: 'pk', counter: 0, transports: null, deviceLabel: 'iPhone (Safari)',
      createdAt: new Date(), lastUsedAt: null,
    });
    const app = makeApp();
    const r = await call(app, 'DELETE', '/api/auth/webauthn/credentials/c-1');
    expect(r.status).toBe(200);
    expect(fakeDb.credentials).toHaveLength(0);
  });

  it('DELETE /credentials/:id returns 404 for someone else\'s passkey', async () => {
    fakeDb.credentials.push({
      id: 'c-2', userId: 'someone-else', credentialId: 'other',
      publicKey: 'pk', counter: 0, transports: null, deviceLabel: 'Other',
      createdAt: new Date(), lastUsedAt: null,
    });
    const app = makeApp();
    const r = await call(app, 'DELETE', '/api/auth/webauthn/credentials/c-2');
    expect(r.status).toBe(404);
    expect(fakeDb.credentials).toHaveLength(1);
  });
});
