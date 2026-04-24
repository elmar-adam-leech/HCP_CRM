import { describe, it, expect, beforeEach, vi } from 'vitest';
import crypto from 'crypto';
import type { Request, Response } from 'express';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-auth-refresh-tests-do-not-use-in-prod';

interface FakeRow {
  id: string;
  userId: string;
  contractorId: string;
  tokenHash: string;
  deviceId: string | null;
  createdAt: Date;
  expiresAt: Date;
  lastUsedAt: Date | null;
  rotatedAt: Date | null;
  revokedAt: Date | null;
  ip: string | null;
  userAgent: string | null;
}

interface FakeUser {
  id: string;
  username: string;
  name: string;
  email: string;
  tokenVersion: number;
}

interface FakeUserContractor {
  userId: string;
  contractorId: string;
  role: string;
  canManageIntegrations: boolean;
  allowedIntegrations: string[] | null;
}

const store = vi.hoisted(() => ({
  rows: [] as FakeRow[],
  users: new Map<string, FakeUser>(),
  userContractors: new Map<string, FakeUserContractor>(), // key: `${userId}:${contractorId}`
  reset() {
    this.rows = [];
    this.users.clear();
    this.userContractors.clear();
  },
}));

vi.mock('./storage', () => ({
  storage: {
    createRefreshToken: async (input: Omit<FakeRow, 'id' | 'createdAt'>) => {
      const row: FakeRow = {
        id: `row-${store.rows.length + 1}`,
        createdAt: new Date(),
        lastUsedAt: null,
        rotatedAt: null,
        revokedAt: null,
        ip: null,
        userAgent: null,
        deviceId: null,
        ...input,
      };
      store.rows.push(row);
      return row;
    },
    findRefreshTokenByHash: async (hash: string) => {
      return store.rows.find((r) => r.tokenHash === hash);
    },
    findActiveRefreshTokenByHash: async (hash: string) => {
      return store.rows.find((r) => r.tokenHash === hash && r.revokedAt === null);
    },
    markRefreshTokenUsed: async (
      id: string,
      fields: { lastUsedAt: Date; ip?: string | null; userAgent?: string | null; rotate?: boolean; revoke?: boolean },
    ) => {
      const row = store.rows.find((r) => r.id === id);
      if (!row) return;
      row.lastUsedAt = fields.lastUsedAt;
      if (fields.ip !== undefined) row.ip = fields.ip;
      if (fields.userAgent !== undefined) row.userAgent = fields.userAgent;
      if (fields.rotate) row.rotatedAt = fields.lastUsedAt;
      if (fields.revoke) row.revokedAt = fields.lastUsedAt;
    },
    revokeRefreshToken: async (id: string) => {
      const row = store.rows.find((r) => r.id === id);
      if (row && !row.revokedAt) row.revokedAt = new Date();
    },
    revokeRefreshTokenByHash: async (hash: string) => {
      const row = store.rows.find((r) => r.tokenHash === hash && r.revokedAt === null);
      if (row) row.revokedAt = new Date();
    },
    revokeRefreshTokensForUser: async (userId: string) => {
      for (const r of store.rows) {
        if (r.userId === userId && !r.revokedAt) r.revokedAt = new Date();
      }
    },
    getUser: async (id: string) => {
      return store.users.get(id);
    },
    getUserContractor: async (userId: string, contractorId: string) => {
      return store.userContractors.get(`${userId}:${contractorId}`);
    },
  },
}));

// Mock the auth-service module too — handleRefreshRequest only uses
// AuthService.generateToken, and pulling in the real one would drag in the
// services/cache + credential-service modules with all their DB side effects.
vi.mock('./auth-service', () => ({
  AuthService: {
    generateToken: (user: { id: string; contractorId: string }) =>
      `fake-jwt-for-${user.id}-${user.contractorId}-${Date.now()}`,
  },
}));

import {
  hashRefreshToken,
  issueRefreshToken,
  clearRefreshCookie,
  handleRefreshRequest,
  refreshTokenRateLimiter,
  REFRESH_TOKEN_TTL_MS,
  REFRESH_ROTATION_GRACE_MS,
  REFRESH_COOKIE_NAME,
  _resetPerTokenRateLimiterForTests,
} from './auth-refresh';
import { storage } from './storage';

interface TestRes {
  cookies: Record<string, { value: string; opts: any }>;
  cleared: string[];
  statusCode: number;
  body: any;
}

function makeReq(extra: Partial<Request> = {}): Request {
  return {
    ip: '1.2.3.4',
    socket: { remoteAddress: '1.2.3.4' } as any,
    headers: { 'user-agent': 'jest' },
    cookies: {},
    ...extra,
  } as unknown as Request;
}

function makeRes(): Response & TestRes {
  const cookies: Record<string, { value: string; opts: any }> = {};
  const cleared: string[] = [];
  const res: any = {
    cookies,
    cleared,
    statusCode: 200,
    body: undefined,
    cookie(name: string, value: string, opts: any) {
      cookies[name] = { value, opts };
      return this;
    },
    clearCookie(name: string, _opts: any) {
      cleared.push(name);
      return this;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: any) {
      this.body = body;
      return this;
    },
  };
  return res as Response & TestRes;
}

function seedUser(id = 'u1') {
  store.users.set(id, {
    id,
    username: `${id}@example.com`,
    name: id.toUpperCase(),
    email: `${id}@example.com`,
    tokenVersion: 1,
  });
}

function seedMembership(userId = 'u1', contractorId = 'c1', role = 'admin') {
  store.userContractors.set(`${userId}:${contractorId}`, {
    userId,
    contractorId,
    role,
    canManageIntegrations: true,
    allowedIntegrations: null,
  });
}

describe('issueRefreshToken / hashRefreshToken', () => {
  beforeEach(() => store.reset());

  it('persists a hashed token and sets the refresh cookie with raw token + 90d TTL', async () => {
    const req = makeReq();
    const res = makeRes();

    await issueRefreshToken(req, res, { userId: 'u1', contractorId: 'c1' });

    expect(store.rows).toHaveLength(1);
    const row = store.rows[0];
    expect(row.userId).toBe('u1');
    expect(row.contractorId).toBe('c1');
    expect(row.revokedAt).toBeNull();
    expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now() + REFRESH_TOKEN_TTL_MS - 5_000);
    expect(row.ip).toBe('1.2.3.4');
    expect(row.userAgent).toBe('jest');

    const cookie = res.cookies[REFRESH_COOKIE_NAME];
    expect(cookie).toBeDefined();
    expect(cookie.value).toMatch(/^[a-f0-9]{64}$/);
    expect(cookie.opts.httpOnly).toBe(true);
    expect(cookie.opts.sameSite).toBe('lax');
    expect(cookie.opts.maxAge).toBe(REFRESH_TOKEN_TTL_MS);

    expect(row.tokenHash).toBe(hashRefreshToken(cookie.value));
    expect(row.tokenHash).not.toBe(cookie.value);
  });

  it('clearRefreshCookie clears the named cookie', () => {
    const res = makeRes();
    clearRefreshCookie(res);
    expect(res.cleared).toContain(REFRESH_COOKIE_NAME);
  });
});

describe('refresh-token storage rotation semantics', () => {
  beforeEach(() => store.reset());

  it('findActiveRefreshTokenByHash returns the row for a freshly issued token', async () => {
    const res = makeRes();
    await issueRefreshToken(makeReq(), res, { userId: 'u1', contractorId: 'c1' });
    const raw = res.cookies[REFRESH_COOKIE_NAME].value;

    const found = await storage.findActiveRefreshTokenByHash(hashRefreshToken(raw));
    expect(found).toBeDefined();
    expect(found?.userId).toBe('u1');
  });

  it('returns undefined for a revoked token (so /api/auth/refresh would 401)', async () => {
    const res = makeRes();
    await issueRefreshToken(makeReq(), res, { userId: 'u1', contractorId: 'c1' });
    const raw = res.cookies[REFRESH_COOKIE_NAME].value;
    const hash = hashRefreshToken(raw);

    await storage.revokeRefreshTokenByHash(hash);

    const found = await storage.findActiveRefreshTokenByHash(hash);
    expect(found).toBeUndefined();
  });

  it('rotation marks rotatedAt (NOT revokedAt) so the row stays available within the grace window', async () => {
    const res = makeRes();
    await issueRefreshToken(makeReq(), res, { userId: 'u1', contractorId: 'c1' });
    const raw = res.cookies[REFRESH_COOKIE_NAME].value;
    const hash = hashRefreshToken(raw);

    const row = await storage.findActiveRefreshTokenByHash(hash);
    expect(row).toBeDefined();
    await storage.markRefreshTokenUsed(row!.id, { lastUsedAt: new Date(), rotate: true });

    // Still findable (rotatedAt set, revokedAt null) — grace evaluation lives in the route handler.
    const reused = await storage.findActiveRefreshTokenByHash(hash);
    expect(reused).toBeDefined();
    expect(reused!.rotatedAt).not.toBeNull();
    expect(reused!.revokedAt).toBeNull();
  });

  it('revokeRefreshTokensForUser revokes every active token for a user', async () => {
    const r1 = makeRes(); await issueRefreshToken(makeReq(), r1, { userId: 'u1', contractorId: 'c1' });
    const r2 = makeRes(); await issueRefreshToken(makeReq(), r2, { userId: 'u1', contractorId: 'c1' });
    const r3 = makeRes(); await issueRefreshToken(makeReq(), r3, { userId: 'u2', contractorId: 'c1' });

    await storage.revokeRefreshTokensForUser('u1');

    const h1 = hashRefreshToken(r1.cookies[REFRESH_COOKIE_NAME].value);
    const h2 = hashRefreshToken(r2.cookies[REFRESH_COOKIE_NAME].value);
    const h3 = hashRefreshToken(r3.cookies[REFRESH_COOKIE_NAME].value);

    expect(await storage.findActiveRefreshTokenByHash(h1)).toBeUndefined();
    expect(await storage.findActiveRefreshTokenByHash(h2)).toBeUndefined();
    expect(await storage.findActiveRefreshTokenByHash(h3)).toBeDefined();
  });
});

describe('handleRefreshRequest endpoint state machine', () => {
  beforeEach(() => {
    store.reset();
    seedUser('u1');
    seedMembership('u1', 'c1');
    _resetPerTokenRateLimiterForTests();
  });

  async function freshlyIssued(): Promise<{ raw: string; hash: string; rowId: string }> {
    const res = makeRes();
    await issueRefreshToken(makeReq(), res, { userId: 'u1', contractorId: 'c1' });
    const raw = res.cookies[REFRESH_COOKIE_NAME].value;
    const hash = hashRefreshToken(raw);
    const row = store.rows.find((r) => r.tokenHash === hash)!;
    return { raw, hash, rowId: row.id };
  }

  it('401s when the request has no refresh cookie', async () => {
    const res = makeRes();
    await handleRefreshRequest(makeReq(), res);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ message: 'No refresh token' });
    // No row should be touched.
    expect(store.rows).toHaveLength(0);
  });

  it('401s + clears cookie when the cookie hash is unknown', async () => {
    const res = makeRes();
    const bogus = crypto.randomBytes(32).toString('hex');
    await handleRefreshRequest(makeReq({ cookies: { [REFRESH_COOKIE_NAME]: bogus } }), res);
    expect(res.statusCode).toBe(401);
    expect(res.cleared).toContain(REFRESH_COOKIE_NAME);
  });

  it('rotates the token on a fresh use: mints auth + new refresh, marks old row rotatedAt', async () => {
    const { raw, rowId } = await freshlyIssued();

    const res = makeRes();
    await handleRefreshRequest(makeReq({ cookies: { [REFRESH_COOKIE_NAME]: raw } }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true });
    // Both cookies set on the response.
    expect(res.cookies['auth_token']).toBeDefined();
    expect(res.cookies[REFRESH_COOKIE_NAME]).toBeDefined();
    // New refresh cookie value differs from the original.
    expect(res.cookies[REFRESH_COOKIE_NAME].value).not.toBe(raw);

    // Old row marked rotated (NOT revoked) so in-flight retries can still hit grace.
    const oldRow = store.rows.find((r) => r.id === rowId)!;
    expect(oldRow.rotatedAt).not.toBeNull();
    expect(oldRow.revokedAt).toBeNull();
    expect(oldRow.lastUsedAt).not.toBeNull();

    // A fresh row exists for the new token.
    expect(store.rows).toHaveLength(2);
  });

  it('within grace window: re-arrival of the rotated token re-mints auth without rotating again', async () => {
    const { raw, rowId } = await freshlyIssued();

    // First call rotates the token.
    await handleRefreshRequest(
      makeReq({ cookies: { [REFRESH_COOKIE_NAME]: raw } }),
      makeRes(),
    );
    expect(store.rows).toHaveLength(2);

    // Capture the rotation anchor — grace math is keyed on this and must NOT shift on re-hit.
    const oldRow = store.rows.find((r) => r.id === rowId)!;
    const originalRotatedAt = oldRow.rotatedAt!.getTime();

    // Second call (in-flight retry) arrives a few ms later with the SAME old token,
    // from a different IP/UA to verify audit fields get stamped.
    const res2 = makeRes();
    await handleRefreshRequest(
      makeReq({
        cookies: { [REFRESH_COOKIE_NAME]: raw },
        ip: '9.9.9.9',
        socket: { remoteAddress: '9.9.9.9' } as any,
        headers: { 'user-agent': 'retry-client' },
      }),
      res2,
    );

    expect(res2.statusCode).toBe(200);
    expect(res2.body).toEqual({ ok: true, grace: true });
    // Auth cookie is re-minted...
    expect(res2.cookies['auth_token']).toBeDefined();
    // ...but no NEW refresh cookie is set (client already has the rotated one).
    expect(res2.cookies[REFRESH_COOKIE_NAME]).toBeUndefined();
    // Crucially: no third row was inserted — the grace path must not chain rotations.
    expect(store.rows).toHaveLength(2);

    // The old row is still in the rotated/not-revoked state...
    expect(oldRow.revokedAt).toBeNull();
    // ...rotation anchor is preserved (so the grace window doesn't get extended on every retry)...
    expect(oldRow.rotatedAt!.getTime()).toBe(originalRotatedAt);
    // ...but lastUsedAt + IP + UA are stamped for forensic auditability.
    expect(oldRow.ip).toBe('9.9.9.9');
    expect(oldRow.userAgent).toBe('retry-client');
    expect(oldRow.lastUsedAt!.getTime()).toBeGreaterThanOrEqual(originalRotatedAt);
  });

  it('past the grace window: re-arrival is treated as replay → 401, clear cookie, hard-revoke the row', async () => {
    const { raw, rowId } = await freshlyIssued();

    // Manually pre-rotate the row with a rotatedAt timestamp older than the grace window.
    const row = store.rows.find((r) => r.id === rowId)!;
    row.rotatedAt = new Date(Date.now() - REFRESH_ROTATION_GRACE_MS - 1000);
    row.lastUsedAt = row.rotatedAt;

    const res = makeRes();
    await handleRefreshRequest(
      makeReq({ cookies: { [REFRESH_COOKIE_NAME]: raw } }),
      res,
    );

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ message: 'Refresh token reused after rotation' });
    expect(res.cleared).toContain(REFRESH_COOKIE_NAME);

    // Hard-revoked so a follow-up arrival hits the revokedAt branch and never re-enters grace.
    expect(row.revokedAt).not.toBeNull();
  });

  it('hard-revoked row (e.g., logout) always 401s, even if rotatedAt is also within grace', async () => {
    const { raw, rowId } = await freshlyIssued();
    const row = store.rows.find((r) => r.id === rowId)!;
    row.rotatedAt = new Date(); // would normally qualify for grace
    row.revokedAt = new Date(); // but logout overrides

    const res = makeRes();
    await handleRefreshRequest(
      makeReq({ cookies: { [REFRESH_COOKIE_NAME]: raw } }),
      res,
    );

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ message: 'Invalid refresh token' });
    expect(res.cleared).toContain(REFRESH_COOKIE_NAME);
    // Auth cookie must NOT be issued.
    expect(res.cookies['auth_token']).toBeUndefined();
  });

  it('expired row (past expiresAt) returns 401 even when not rotated/revoked', async () => {
    const raw = crypto.randomBytes(32).toString('hex');
    store.rows.push({
      id: 'expired',
      userId: 'u1',
      contractorId: 'c1',
      tokenHash: hashRefreshToken(raw),
      deviceId: null,
      createdAt: new Date(Date.now() - REFRESH_TOKEN_TTL_MS - 1000),
      expiresAt: new Date(Date.now() - 1000),
      lastUsedAt: null,
      rotatedAt: null,
      revokedAt: null,
      ip: null,
      userAgent: null,
    });

    const res = makeRes();
    await handleRefreshRequest(
      makeReq({ cookies: { [REFRESH_COOKIE_NAME]: raw } }),
      res,
    );

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ message: 'Refresh token expired' });
    expect(res.cleared).toContain(REFRESH_COOKIE_NAME);
  });

  it('membership removed: revokes the token chain and 401s', async () => {
    const { raw, rowId } = await freshlyIssued();
    // Yank membership.
    store.userContractors.delete('u1:c1');

    const res = makeRes();
    await handleRefreshRequest(
      makeReq({ cookies: { [REFRESH_COOKIE_NAME]: raw } }),
      res,
    );

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ message: 'Access denied to this company' });
    const row = store.rows.find((r) => r.id === rowId)!;
    expect(row.revokedAt).not.toBeNull();
  });
});

describe('refreshTokenRateLimiter (per-token)', () => {
  beforeEach(() => {
    _resetPerTokenRateLimiterForTests();
  });

  function runMiddleware(rawCookie?: string): {
    allowed: boolean;
    statusCode: number;
    body: any;
  } {
    const req = makeReq({ cookies: rawCookie ? { [REFRESH_COOKIE_NAME]: rawCookie } : {} });
    const res = makeRes();
    let nextCalled = false;
    refreshTokenRateLimiter(req, res, () => {
      nextCalled = true;
    });
    return { allowed: nextCalled, statusCode: res.statusCode, body: res.body };
  }

  it('passes through when no refresh cookie is present (route handler will 401)', () => {
    const result = runMiddleware();
    expect(result.allowed).toBe(true);
  });

  it('allows up to 5 requests per minute for the same token, then 429s the 6th', () => {
    const raw = crypto.randomBytes(32).toString('hex');
    for (let i = 1; i <= 5; i++) {
      const result = runMiddleware(raw);
      expect(result.allowed).toBe(true);
    }
    const sixth = runMiddleware(raw);
    expect(sixth.allowed).toBe(false);
    expect(sixth.statusCode).toBe(429);
    expect(sixth.body).toMatchObject({
      error: 'Too many requests',
      message: 'Refresh token used too frequently',
    });
    expect(typeof sixth.body.retryAfter).toBe('number');
  });

  it('limits are per-token: a different cookie has its own bucket', () => {
    const tokenA = crypto.randomBytes(32).toString('hex');
    const tokenB = crypto.randomBytes(32).toString('hex');

    // Burn through token A's quota.
    for (let i = 0; i < 5; i++) runMiddleware(tokenA);
    expect(runMiddleware(tokenA).allowed).toBe(false);

    // Token B is unaffected.
    expect(runMiddleware(tokenB).allowed).toBe(true);
  });
});
