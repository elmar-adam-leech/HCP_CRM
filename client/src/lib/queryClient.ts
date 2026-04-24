import { QueryClient, QueryFunction, QueryCache, MutationCache } from "@tanstack/react-query";

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
// Silent refresh on 401 — task #650 (Persistent PWA login)
// ---------------------------------------------------------------------------
// On any 401 from /api/* we try ONE silent POST to /api/auth/refresh, which
// reads the long-lived `refresh_token` httpOnly cookie and (on success) sets a
// fresh `auth_token` cookie. We then retry the original request exactly once.
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

async function attemptSilentRefresh(): Promise<boolean> {
  if (!inFlightRefresh) {
    inFlightRefresh = (async () => {
      try {
        const res = await fetch("/api/auth/refresh", {
          method: "POST",
          credentials: "include",
        });
        return res.ok;
      } catch {
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
