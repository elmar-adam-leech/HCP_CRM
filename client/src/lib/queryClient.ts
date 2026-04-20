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

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
): Promise<Response> {
  const res = await fetch(url, {
    method,
    headers: data ? { "Content-Type": "application/json" } : {},
    body: data ? JSON.stringify(data) : undefined,
    credentials: "include",
  });

  await throwIfResNotOk(res);
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const res = await fetch(queryKey.join("/") as string, {
      credentials: "include",
    });

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
