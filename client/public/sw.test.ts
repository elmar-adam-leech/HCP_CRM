// Tests for the app-shell service worker (task #743 / #745).
//
// The SW is plain JS that mutates `self` via addEventListener. We load its
// source into a fresh vm context with a fake `self`, fake `caches`, and a
// controllable `fetch`, then drive its registered `fetch` listener with
// synthetic FetchEvent-like objects and assert what gets cached / bypassed.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

type AnyFn = (...args: any[]) => any;

interface FakeCache {
  store: Map<string, Response>;
  match: (req: Request | string) => Promise<Response | undefined>;
  put: (req: Request | string, res: Response) => Promise<void>;
}

interface FakeCacheStorage {
  caches: Map<string, FakeCache>;
  open: (name: string) => Promise<FakeCache>;
  keys: () => Promise<string[]>;
  delete: (name: string) => Promise<boolean>;
}

function keyOf(req: Request | string): string {
  return typeof req === "string" ? req : req.url;
}

function makeCaches(): FakeCacheStorage {
  const caches = new Map<string, FakeCache>();
  return {
    caches,
    async open(name) {
      let c = caches.get(name);
      if (!c) {
        const store = new Map<string, Response>();
        c = {
          store,
          async match(req) {
            return store.get(keyOf(req));
          },
          async put(req, res) {
            store.set(keyOf(req), res);
          },
        };
        caches.set(name, c);
      }
      return c;
    },
    async keys() {
      return [...caches.keys()];
    },
    async delete(name) {
      return caches.delete(name);
    },
  };
}

interface LoadedSW {
  listeners: Record<string, AnyFn[]>;
  fakeCaches: FakeCacheStorage;
  fetchMock: ReturnType<typeof vi.fn>;
  dispatchFetch: (request: Request) => Promise<Response | undefined>;
  runActivate: () => Promise<void>;
}

function loadSW(): LoadedSW {
  const src = readFileSync(
    path.resolve(__dirname, "sw.js"),
    "utf8",
  );
  const listeners: Record<string, AnyFn[]> = {};
  const fakeCaches = makeCaches();
  const fetchMock = vi.fn();

  const self: any = {
    location: { origin: "https://app.example.com" },
    addEventListener: (type: string, fn: AnyFn) => {
      (listeners[type] ??= []).push(fn);
    },
    skipWaiting: () => Promise.resolve(),
    clients: { claim: () => Promise.resolve() },
  };

  const ctx = vm.createContext({
    self,
    caches: fakeCaches,
    fetch: fetchMock,
    URL,
    Response,
    Request,
    Promise,
    queueMicrotask,
    console,
  });

  vm.runInContext(src, ctx);

  async function dispatchFetch(request: Request): Promise<Response | undefined> {
    let captured: Promise<Response> | undefined;
    const event: any = {
      request,
      respondWith(p: Promise<Response>) {
        captured = Promise.resolve(p);
      },
      waitUntil() {},
    };
    for (const fn of listeners.fetch ?? []) fn(event);
    return captured ? await captured : undefined;
  }

  async function runActivate() {
    const waited: Promise<unknown>[] = [];
    const event: any = { waitUntil: (p: Promise<unknown>) => waited.push(p) };
    for (const fn of listeners.activate ?? []) fn(event);
    await Promise.all(waited);
  }

  return { listeners, fakeCaches, fetchMock, dispatchFetch, runActivate };
}

function mkRequest(
  url: string,
  init: { method?: string; mode?: RequestMode } = {},
): Request {
  // We can't fully set request.mode via the Request constructor in node,
  // so we wrap it in a plain object that exposes the fields the SW reads.
  const r: any = {
    url,
    method: init.method ?? "GET",
    mode: init.mode ?? "no-cors",
  };
  return r as Request;
}

function okResponse(body: string, url: string) {
  // Need clone() and ok/status that the SW inspects.
  const res: any = {
    ok: true,
    status: 200,
    url,
    body,
    clone() {
      return okResponse(body, url);
    },
  };
  return res as Response;
}

describe("service worker fetch handler", () => {
  let sw: LoadedSW;

  beforeEach(() => {
    sw = loadSW();
  });

  it("serves /assets/* cache-first; only refetches on miss", async () => {
    const req = mkRequest("https://app.example.com/assets/main.abc123.js");

    // First request: cache miss → network is consulted.
    sw.fetchMock.mockResolvedValueOnce(
      okResponse("console.log('v1')", req.url),
    );
    const first = await sw.dispatchFetch(req);
    expect(first).toBeDefined();
    expect((first as any).body).toBe("console.log('v1')");
    expect(sw.fetchMock).toHaveBeenCalledTimes(1);

    // Second request: cache hit → network is NOT consulted, even if the
    // server would now respond with new content.
    sw.fetchMock.mockResolvedValueOnce(
      okResponse("console.log('v2-should-not-be-seen')", req.url),
    );
    const second = await sw.dispatchFetch(req);
    expect((second as any).body).toBe("console.log('v1')");
    expect(sw.fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT intercept /api/* requests", async () => {
    const req = mkRequest("https://app.example.com/api/auth/me");
    const result = await sw.dispatchFetch(req);
    expect(result).toBeUndefined();
    expect(sw.fetchMock).not.toHaveBeenCalled();
  });

  it("does NOT intercept /_replit* requests", async () => {
    const req = mkRequest("https://app.example.com/_replit/devtools");
    const result = await sw.dispatchFetch(req);
    expect(result).toBeUndefined();
  });

  it("does NOT intercept non-GET requests", async () => {
    const req = mkRequest("https://app.example.com/assets/main.abc.js", {
      method: "POST",
    });
    const result = await sw.dispatchFetch(req);
    expect(result).toBeUndefined();
    expect(sw.fetchMock).not.toHaveBeenCalled();
  });

  it("does NOT intercept cross-origin requests", async () => {
    const req = mkRequest("https://cdn.other-origin.com/assets/foo.js");
    const result = await sw.dispatchFetch(req);
    expect(result).toBeUndefined();
    expect(sw.fetchMock).not.toHaveBeenCalled();
  });

  it("serves the shell stale-while-revalidate for navigations and falls back to cache when offline", async () => {
    const req = mkRequest("https://app.example.com/", { mode: "navigate" });

    // First load — cache is cold. Network returns the shell, which gets cached
    // and returned.
    sw.fetchMock.mockResolvedValueOnce(okResponse("<html>v1</html>", req.url));
    const first = await sw.dispatchFetch(req);
    expect((first as any).body).toBe("<html>v1</html>");

    // Subsequent offline reload — network rejects. The cached shell must
    // still be served so PWA users don't see a blank screen.
    sw.fetchMock.mockRejectedValueOnce(new Error("offline"));
    const offline = await sw.dispatchFetch(req);
    expect((offline as any).body).toBe("<html>v1</html>");
  });

  it("activate purges caches whose version doesn't match SW_VERSION", async () => {
    // Seed a stale cache from a previous SW version plus a current one.
    await sw.fakeCaches.open("assets-OLD");
    await sw.fakeCaches.open("shell-OLD");
    // Trigger one cache-first call so the current asset cache exists.
    const req = mkRequest("https://app.example.com/assets/x.js");
    sw.fetchMock.mockResolvedValueOnce(okResponse("ok", req.url));
    await sw.dispatchFetch(req);

    await sw.runActivate();

    const remaining = await sw.fakeCaches.keys();
    expect(remaining).not.toContain("assets-OLD");
    expect(remaining).not.toContain("shell-OLD");
    // Current-version asset cache should survive.
    expect(remaining.some((k) => k.startsWith("assets-"))).toBe(true);
  });
});
