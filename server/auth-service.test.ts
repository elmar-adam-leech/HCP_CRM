import { describe, it, expect, beforeEach, vi } from 'vitest';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-auth-service-revocation-tests-do-not-use-in-prod';

const mocks = vi.hoisted(() => ({
  revokedJtis: new Set<string>(),
  user: { id: 'user-1', tokenVersion: 1 },
  userContractor: {
    role: 'admin' as string,
    canManageIntegrations: true,
    allowedIntegrations: null as string[] | null,
  },
  reset() {
    this.revokedJtis.clear();
    this.user.tokenVersion = 1;
  },
}));

vi.mock('./db', () => {
  const dbMock = {
    insert: (_table: unknown) => ({
      values: (vals: { jti?: string }) => ({
        onConflictDoNothing: async () => {
          if (vals.jti) mocks.revokedJtis.add(vals.jti);
          return undefined;
        },
      }),
    }),
    select: (_cols: unknown) => ({
      from: (_table: unknown) => ({
        where: (_cond: unknown) => ({
          limit: async (_n: number) => {
            return [...mocks.revokedJtis].map((jti) => ({ jti }));
          },
        }),
      }),
    }),
    delete: (_table: unknown) => ({
      where: (_cond: unknown) => ({
        returning: async (_cols: unknown) => [] as Array<{ jti: string }>,
      }),
    }),
  };
  return { db: dbMock };
});

vi.mock('./services/cache', () => ({
  getUserCached: async (userId: string) => ({
    ...mocks.user,
    id: userId,
  }),
  getUserContractorCached: async (_userId: string, _contractorId: string) => mocks.userContractor,
}));

import { AuthService, type AuthenticatedRequest, type JWTPayload } from './auth-service';
import { _resetAuthCacheForTests, getCachedValidation, evictAuthCache } from './services/auth-cache';
import type { Response } from 'express';

function makeRes() {
  const res = {
    statusCode: 200 as number,
    body: null as unknown,
    cookieSet: null as null | { name: string; value: string; opts: unknown },
    status(code: number) { this.statusCode = code; return this; },
    json(b: unknown) { this.body = b; return this; },
    cookie(name: string, value: string, opts: unknown) { this.cookieSet = { name, value, opts }; return this; },
  };
  return res as unknown as Response & { statusCode: number; body: any };
}

function makeReq(token: string): AuthenticatedRequest {
  return {
    cookies: { auth_token: token },
    headers: {},
  } as unknown as AuthenticatedRequest;
}

function freshUser() {
  return {
    id: 'user-1',
    username: 'alice',
    name: 'Alice',
    email: 'alice@example.com',
    role: 'admin',
    contractorId: 'contractor-1',
    canManageIntegrations: true,
    allowedIntegrations: null,
    tokenVersion: 1,
  };
}

async function runMiddleware(token: string) {
  const req = makeReq(token);
  const res = makeRes();
  const next = vi.fn();
  await AuthService.requireAuth(req, res as unknown as Response, next);
  return { req, res, next };
}

describe('AuthService.requireAuth × revokeToken (end-to-end)', () => {
  beforeEach(() => {
    mocks.reset();
    _resetAuthCacheForTests();
  });

  it('rejects the very next request after revokeToken with "Session has been revoked"', async () => {
    const token = AuthService.generateToken(freshUser());
    const decoded = AuthService.verifyToken(token)!;
    expect(decoded).not.toBeNull();

    // First request: validates and populates the auth cache.
    const first = await runMiddleware(token);
    expect(first.next).toHaveBeenCalledTimes(1);
    expect(first.res.statusCode).toBe(200);
    expect(getCachedValidation(decoded.jti)).not.toBeNull();

    // Revoke the token. This should evict the cache so the next request
    // hits the slow path and sees the revoked_tokens row.
    await AuthService.revokeToken(decoded);
    expect(getCachedValidation(decoded.jti)).toBeNull();
    expect(mocks.revokedJtis.has(decoded.jti)).toBe(true);

    // Second request: must be rejected immediately, even though the cache
    // TTL has not yet elapsed.
    const second = await runMiddleware(token);
    expect(second.next).not.toHaveBeenCalled();
    expect(second.res.statusCode).toBe(401);
    expect((second.res.body as { message: string }).message).toBe('Session has been revoked');
  });

  it('rejects the next request after a tokenVersion bump + cache eviction with "Session invalidated"', async () => {
    const token = AuthService.generateToken(freshUser());
    const decoded = AuthService.verifyToken(token) as JWTPayload;

    // Prime the cache via a successful first request.
    const first = await runMiddleware(token);
    expect(first.next).toHaveBeenCalledTimes(1);
    expect(getCachedValidation(decoded.jti)).not.toBeNull();

    // Simulate "sign out all devices": bump users.tokenVersion and evict
    // the cached jti so the slow path runs on the next request.
    mocks.user.tokenVersion = 2;
    evictAuthCache(decoded.jti);

    const second = await runMiddleware(token);
    expect(second.next).not.toHaveBeenCalled();
    expect(second.res.statusCode).toBe(401);
    expect((second.res.body as { message: string }).message).toMatch(/Session invalidated/);
    // Defensive eviction in the slow path should leave the cache empty.
    expect(getCachedValidation(decoded.jti)).toBeNull();
  });
});
