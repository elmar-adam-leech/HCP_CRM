import { QueryClient, QueryFunction, QueryCache, MutationCache } from "@tanstack/react-query";
import {
  clearStoredRefreshToken,
  getStoredRefreshToken,
  setStoredRefreshTokenStrict,
} from "./refresh-token-storage";

class RateLimitError extends Error {
  retryAfter: number;
  constructor(retryAfter: number, message: string) {
    super(message);
    this.name = "RateLimitError";
    this.retryAfter = retryAfter;
  }
}

async function throwIfResNotOk(res: Response) {
  if (res.status === 429) {
    let retryAfter = 60;
    try {
      const body = await res.json();
      if (body.retryAfter) retryAfter = body.retryAfter;
    } catch {}
    throw new RateLimitError(retryAfter, `Rate limited — please wait ${retryAfter}s`);
  }
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    throw new Error(`${res.status}: ${text}`);
  }
}

// ---------------------------------------------------------------------------
// Silent refresh on 401 — task #650 (cookie path) + task #720 (IDB fallback)
// ---------------------------------------------------------------------------
// On any 401 from /api/* we try ONE silent POST to /api/auth/refresh, which
// reads the long-lived `refresh_token` httpOnly cookie and (on success) sets a
// fresh `auth_token` cookie. We then retry the original request exactly once.
//
// If that cookie-based refresh fails (typically because iOS Safari has evicted
// the refresh cookie from the PWA's storage partition), we fall back to a copy
// of the refresh token persisted in IndexedDB and POST it in the body. The
// server treats body-supplied tokens with the same rotation, replay, grace,
// and rate-limit rules as cookie-supplied ones — there is no weaker path.
//
// Concurrent 401s from many in-flight queries share the SAME in-flight refresh
// promise so we never fan out N refresh calls (which would also rotate the
// refresh token N times and lose the race). After the refresh resolves all
// callers retry against the new auth cookie in parallel.
//
// We never auto-refresh requests targeting the auth flow itself — refreshing in
// response to a failed /api/auth/login or /api/auth/refresh would create an
// infinite loop and mask the real failure. NOTE: /api/auth/me is intentionally
// NOT in this list — it's the SPA's primary "am I logged in?" probe and MUST
// be retried after a successful refresh, otherwise the app would bounce the
// user to /login on every cold start where the auth_token has been evicted.

let inFlightRefresh: Promise<boolean> | null = null;

const NO_REFRESH_PATHS = new Set([
  "/api/auth/login",
  "/api/auth/register",
  "/api/auth/logout",
  "/api/auth/logout-all",
  "/api/auth/logout-company",
  "/api/auth/refresh",
  "/api/auth/forgot-password",
  "/api/auth/reset-password",
  "/api/auth/persist-failed",
  "/api/mfa/verify",
]);

function isAuthEndpoint(url: string): boolean {
  // Match both absolute (https://...) and relative (/api/...) URLs by inspecting
  // the path segment.
  try {
    const path = url.startsWith("http")
      ? new URL(url).pathname
      : url.split("?")[0];
    return NO_REFRESH_PATHS.has(path);
  } catch {
    return false;
  }
}

/**
 * Persist a refresh token returned by the server (login, MFA verify, passkey
 * finish, or a successful /api/auth/refresh rotation) into IndexedDB so the
 * IDB fallback path stays in sync with the latest rotation.
 */
function reportPersistFailure(stage: "persist", error: unknown): void {
  // Stage exists so future call sites (e.g. a "clear on logout" path that also
  // wants to surface failures) can reuse the same telemetry pipe with a
  // different label without us having to invent a second event type.
  const errorName =
    error && typeof error === "object" && "name" in error && typeof (error as { name?: unknown }).name === "string"
      ? (error as { name: string }).name
      : "UnknownError";
  // eslint-disable-next-line no-console
  console.warn(`[auth] refresh-token persist failed (${stage}): ${errorName}`);
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("auth-persist-failed", { detail: { stage, errorName } }),
    );
  }
  // Fire-and-forget telemetry ping so production can detect IDB-write failures
  // without the user having to send screenshots. Sends NO token, NO PII — just
  // the stage and the error class. The endpoint itself is rate-limited and
  // requires no auth (the typical caller has just been bounced to /login).
  try {
    void fetch("/api/auth/persist-failed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stage, errorName }),
      credentials: "include",
      keepalive: true,
    }).catch(() => {});
  } catch {
    // ignore — telemetry is best-effort
  }
}

export async function persistRefreshTokenFromResponse(body: unknown): Promise<void> {
  if (
    body &&
    typeof body === "object" &&
    "refreshToken" in body &&
    typeof (body as { refreshToken: unknown }).refreshToken === "string"
  ) {
    try {
      await setStoredRefreshTokenStrict((body as { refreshToken: string }).refreshToken);
    } catch (err) {
      // IDB write failed (private mode, quota exceeded, opaque origin, etc.).
      // The cookie path is still serving the session so the user is not signed
      // out right now — but the next browser/PWA reopen that loses the cookie
      // will bounce them to /login. Surface this so we can detect it in prod.
      reportPersistFailure("persist", err);
    }
  }
}

/**
 * Clear the IDB copy. Call after logout / logout-all / remove-this-device.
 *
 * Today the only client surfaces that explicitly invoke a logout endpoint are
 * `Header` (POST /api/auth/logout) and `SecurityTab` (POST /api/auth/logout-company),
 * and both already call this directly. There is currently NO client UI for
 * /api/auth/logout-all or for an individual remove-this-device flow — those
 * are server-only endpoints. If/when a UI is added for either, that handler
 * MUST also call `clearStoredRefreshTokenSafe()` so the IDB copy doesn't get
 * left behind on the device. Any future call site grep-able by this export
 * name keeps the contract honest.
 *
 * Note: even WITHOUT an explicit clear at the call site, the IDB copy will
 * be auto-cleared the next time the SPA tries to silently refresh and the
 * server returns a dead-token reason (`revoked` from logout-all on another
 * device, `not-found` if the row was deleted, `membership-missing`, etc.).
 * That auto-clear is implemented inside `attemptSilentRefresh` below.
 */
export async function clearStoredRefreshTokenSafe(): Promise<void> {
  try {
    await clearStoredRefreshToken();
  } catch {}
}

function reportRefreshFailure(stage: "cookie" | "idb", status: number, reason: string | null) {
  // Surface the structured failure both to the console (so it shows up in any
  // browser-attached dev tools / remote inspector) and via a window event so
  // existing error-reporting listeners can pick it up. See task #720 step 1.
  // eslint-disable-next-line no-console
  console.warn(`[auth] silent refresh failed (${stage}): ${status} ${reason ?? ""}`.trim());
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("auth-refresh-failed", { detail: { stage, status, reason } }),
    );
  }
}

async function doRefreshOnce(body?: { token: string }): Promise<{ ok: boolean; status: number; reason: string | null; payload: unknown }> {
  try {
    const res = await fetch("/api/auth/refresh", {
      method: "POST",
      credentials: "include",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    let payload: unknown = null;
    try {
      payload = await res.clone().json();
    } catch {}
    const reason =
      payload && typeof payload === "object" && "reason" in payload
        ? String((payload as { reason: unknown }).reason ?? "")
        : null;
    return { ok: res.ok, status: res.status, reason, payload };
  } catch {
    return { ok: false, status: 0, reason: "network", payload: null };
  }
}

async function attemptSilentRefresh(): Promise<boolean> {
  if (!inFlightRefresh) {
    inFlightRefresh = (async () => {
      try {
        // Try the cookie path first.
        const cookieAttempt = await doRefreshOnce();
        if (cookieAttempt.ok) {
          await persistRefreshTokenFromResponse(cookieAttempt.payload);
          return true;
        }

        reportRefreshFailure("cookie", cookieAttempt.status, cookieAttempt.reason);

        // 429s are not recoverable by switching to the body path — same token
        // hash, same bucket. Bail rather than waste the IDB attempt.
        if (cookieAttempt.status === 429) return false;

        // Cookie path failed — try the IDB fallback. iOS PWA installs commonly
        // lose the refresh cookie while keeping IDB intact for far longer.
        let idbToken: string | null = null;
        try {
          idbToken = await getStoredRefreshToken();
        } catch {}
        if (!idbToken) return false;

        const bodyAttempt = await doRefreshOnce({ token: idbToken });
        if (bodyAttempt.ok) {
          await persistRefreshTokenFromResponse(bodyAttempt.payload);
          return true;
        }

        reportRefreshFailure("idb", bodyAttempt.status, bodyAttempt.reason);

        // If the server explicitly rejected our IDB copy as not-found / revoked
        // / expired / replayed, the stored token is dead — drop it so we don't
        // keep retrying it on every subsequent 401.
        if (
          bodyAttempt.status === 401 &&
          (bodyAttempt.reason === "not-found" ||
            bodyAttempt.reason === "revoked" ||
            bodyAttempt.reason === "expired" ||
            bodyAttempt.reason === "replayed-past-grace" ||
            bodyAttempt.reason === "membership-missing")
        ) {
          await clearStoredRefreshTokenSafe();
        }
        return false;
      } finally {
        // Release the gate on the next tick so any concurrent 401s that arrive
        // mid-rotation still observe the same resolved promise instead of
        // kicking off a second refresh.
        setTimeout(() => {
          inFlightRefresh = null;
        }, 0);
      }
    })();
  }
  return inFlightRefresh;
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
): Promise<Response> {
  const doFetch = () =>
    fetch(url, {
      method,
      headers: data ? { "Content-Type": "application/json" } : {},
      body: data ? JSON.stringify(data) : undefined,
      credentials: "include",
    });

  let res = await doFetch();

  if (res.status === 401 && !isAuthEndpoint(url)) {
    const refreshed = await attemptSilentRefresh();
    if (refreshed) {
      res = await doFetch();
    }
  }

  await throwIfResNotOk(res);
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const url = queryKey.join("/") as string;
    const doFetch = () => fetch(url, { credentials: "include" });

    let res = await doFetch();

    if (res.status === 401 && !isAuthEndpoint(url)) {
      const refreshed = await attemptSilentRefresh();
      if (refreshed) {
        res = await doFetch();
      }
    }

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

export { RateLimitError };

let lastRateLimitToast = 0;

function handleQueryError(error: unknown) {
  if (error instanceof RateLimitError) {
    const now = Date.now();
    if (now - lastRateLimitToast > 5000) {
      lastRateLimitToast = now;
      window.dispatchEvent(
        new CustomEvent("rate-limit-hit", { detail: { retryAfter: error.retryAfter } })
      );
    }
  }
}

export const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: handleQueryError,
  }),
  mutationCache: new MutationCache({
    onError: handleQueryError,
  }),
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: true,
      staleTime: 30_000,
      gcTime: 300_000,
      retry: (failureCount, error) => {
        if (error instanceof RateLimitError) return false;
        return failureCount < 1;
      },
      retryDelay: (attemptIndex, error) => {
        if (error instanceof RateLimitError) {
          return error.retryAfter * 1000;
        }
        return Math.min(1000 * 2 ** attemptIndex, 30000);
      },
    },
    mutations: {
      retry: false,
    },
  },
});
