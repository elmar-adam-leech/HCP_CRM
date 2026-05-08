// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the IDB storage so we can drive the cookie→IDB fallback decision
// without touching real IndexedDB inside jsdom.
vi.mock("./refresh-token-storage", () => ({
  getStoredRefreshToken: vi.fn(async () => null),
  setStoredRefreshToken: vi.fn(async () => {}),
  setStoredRefreshTokenStrict: vi.fn(async () => {}),
  clearStoredRefreshToken: vi.fn(async () => {}),
}));

// task #737: mock the new auth-token storage so the bearer-attach test below
// can drive the "I have a stored JWT" branch without touching real IndexedDB.
// The mock exposes a typed `__setStored` test hook so we don't need `any`
// casts at the call sites — the cast is centralised here in the mock factory.
interface AuthTokenStorageMock {
  getStoredAuthTokenSync: ReturnType<typeof vi.fn>;
  setStoredAuthTokenStrict: ReturnType<typeof vi.fn>;
  clearStoredAuthToken: ReturnType<typeof vi.fn>;
  ensureBootRecovery: ReturnType<typeof vi.fn>;
  __setStored(t: string | null): void;
}
vi.mock("./auth-token-storage", () => {
  let stored: string | null = null;
  const mock: AuthTokenStorageMock = {
    getStoredAuthTokenSync: vi.fn(() => stored),
    setStoredAuthTokenStrict: vi.fn(async (t: string) => { stored = t; }),
    clearStoredAuthToken: vi.fn(async () => { stored = null; }),
    ensureBootRecovery: vi.fn(async () => stored),
    __setStored(t: string | null) { stored = t; },
  };
  return mock;
});

import { apiRequest, getQueryFn } from "./queryClient";
import * as storage from "./refresh-token-storage";
import * as authTokenStorageRaw from "./auth-token-storage";
const authTokenStorage = authTokenStorageRaw as unknown as AuthTokenStorageMock;

function clearAuthCookie() {
  document.cookie = "auth_token=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
}

describe("queryClient silent refresh — startup boot path", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    fetchMock = vi.fn();
    // @ts-expect-error jsdom global
    globalThis.fetch = fetchMock;
    vi.mocked(storage.getStoredRefreshToken).mockResolvedValue(null);
    authTokenStorage.__setStored(null);
    clearAuthCookie();
    await new Promise((r) => setTimeout(r, 5));
  });

  afterEach(() => {
    vi.clearAllMocks();
    authTokenStorage.__setStored(null);
    clearAuthCookie();
  });

  it("retries /api/auth/me exactly once after a successful silent refresh", async () => {
    const userPayload = { user: { id: "u1", email: "test@example.com" } };
    fetchMock
      .mockResolvedValueOnce(makeResponse(401, { message: "no auth" }))
      .mockResolvedValueOnce(makeResponse(200, { ok: true }))
      .mockResolvedValueOnce(makeResponse(200, userPayload));

    const fn = getQueryFn({ on401: "throw" });
    const result = await fn({
      queryKey: ["/api/auth/me"],
      signal: new AbortController().signal,
      meta: undefined,
    } as never);

    expect(result).toEqual(userPayload);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const urls = fetchMock.mock.calls.map((c) => c[0]);
    expect(urls).toEqual(["/api/auth/me", "/api/auth/refresh", "/api/auth/me"]);
  });

  it("does NOT silently refresh when the failing request is itself an auth endpoint", async () => {
    fetchMock.mockResolvedValueOnce(makeResponse(401, { message: "bad creds" }));

    const fn = getQueryFn({ on401: "returnNull" });
    const result = await fn({
      queryKey: ["/api/auth/login"],
      signal: new AbortController().signal,
      meta: undefined,
    } as never);

    expect(result).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

function makeResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// task #737 step 4 — pin the bearer-fallback contract literally as written
// in the task spec: "if `document.cookie` does NOT contain `auth_token`,
// read the stored auth JWT from `auth-token-storage` and attach it as
// `Authorization: Bearer <token>`." Cookies remain the default delivery
// path; bearer is gated on the cookie-visibility check.
describe("queryClient — task #737 bearer fallback header", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    // @ts-expect-error jsdom global
    globalThis.fetch = fetchMock;
    authTokenStorage.__setStored("jwt-from-storage-abc");
    clearAuthCookie();
  });

  afterEach(() => {
    authTokenStorage.__setStored(null);
    clearAuthCookie();
    vi.clearAllMocks();
  });

  it("attaches Authorization: Bearer when document.cookie lacks auth_token and a stored JWT exists", async () => {
    await apiRequest("GET", "/api/leads");
    const [, init] = fetchMock.mock.calls[0];
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer jwt-from-storage-abc",
    );
    // Cookie path stays in play — bearer is added IN ADDITION TO, never
    // INSTEAD OF, the cookie. Server prefers cookie when both arrive.
    expect(init.credentials).toBe("include");
  });

  it("getQueryFn attaches Authorization: Bearer under the same gate", async () => {
    const fn = getQueryFn({ on401: "throw" });
    await fn({
      queryKey: ["/api/leads"],
      signal: new AbortController().signal,
      meta: undefined,
    } as never);
    const [, init] = fetchMock.mock.calls[0];
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer jwt-from-storage-abc",
    );
    expect(init.credentials).toBe("include");
  });

  it("does NOT attach Authorization: Bearer when document.cookie shows a (non-httpOnly) auth_token", async () => {
    // Test-environment cookies are necessarily JS-visible. This branch
    // proves the gate respects the cookie-presence signal — production
    // httpOnly cookies are invisible to JS by design and so won't trigger
    // this branch in real traffic, but the gate itself is wired correctly.
    document.cookie = "auth_token=jwt-from-cookie; path=/";
    await apiRequest("GET", "/api/leads");
    const [, init] = fetchMock.mock.calls[0];
    expect((init.headers as Record<string, string>)["Authorization"]).toBeUndefined();
    expect(init.credentials).toBe("include");
  });

  it("omits the Authorization header when no stored auth JWT is present", async () => {
    authTokenStorage.__setStored(null);
    await apiRequest("GET", "/api/leads");
    const [, init] = fetchMock.mock.calls[0];
    expect((init.headers as Record<string, string>)["Authorization"]).toBeUndefined();
  });
});
