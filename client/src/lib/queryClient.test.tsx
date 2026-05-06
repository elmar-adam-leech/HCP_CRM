// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the IDB storage so we can drive the cookie→IDB fallback decision
// without touching real IndexedDB inside jsdom.
vi.mock("./refresh-token-storage", () => ({
  getStoredRefreshToken: vi.fn(async () => null),
  setStoredRefreshToken: vi.fn(async () => {}),
  clearStoredRefreshToken: vi.fn(async () => {}),
}));

import { getQueryFn } from "./queryClient";
import * as storage from "./refresh-token-storage";

describe("queryClient silent refresh — startup boot path", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    fetchMock = vi.fn();
    // @ts-expect-error jsdom global
    globalThis.fetch = fetchMock;
    vi.mocked(storage.getStoredRefreshToken).mockResolvedValue(null);
    // Ensure any in-flight refresh from a previous test has had time to
    // release the gate (the queryClient drops the gate on a setTimeout 0).
    await new Promise((r) => setTimeout(r, 5));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // Regression for task #720 review item #3: every cold boot of the SPA
  // hits /api/auth/me first, and on iOS PWA installs that request commonly
  // 401s because the auth_token cookie has been evicted. The silent-refresh
  // path MUST kick in there or the user gets bounced to /login on every
  // cold start. This test pins the contract.
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
