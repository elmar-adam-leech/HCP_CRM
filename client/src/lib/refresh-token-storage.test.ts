// @vitest-environment jsdom
//
// Tests for the IDB-backed refresh-token storage that backs the iOS-PWA
// fallback path (task #720) and the persist-failure telemetry added in #734.
// We mock the global `indexedDB` rather than installing fake-indexeddb so the
// test stays self-contained and we can drive both the happy path AND the
// "indexedDB.open errors" path that the strict variant must surface.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  setStoredRefreshToken,
  setStoredRefreshTokenStrict,
  getStoredRefreshToken,
  clearStoredRefreshToken,
} from "./refresh-token-storage";

type StoredKV = Map<unknown, unknown>;

function installFakeIndexedDB(opts: { failOpen?: boolean } = {}): {
  store: StoredKV;
  uninstall: () => void;
} {
  const store: StoredKV = new Map();

  // Real IndexedDB fires `request.onsuccess` BEFORE `transaction.oncomplete`.
  // We model that by tracking pending requests against the current tx and
  // only firing tx.oncomplete after every request handler has been invoked.
  function makeRequest<T>(
    tx: any,
    result: T,
    error?: DOMException | Error,
  ): IDBRequest<T> {
    const req: any = { result, error: error ?? null, onsuccess: null, onerror: null };
    tx._pending = (tx._pending ?? 0) + 1;
    queueMicrotask(() => {
      if (error && req.onerror) req.onerror({ target: req });
      else if (req.onsuccess) req.onsuccess({ target: req });
      tx._pending -= 1;
      tx._maybeComplete?.();
    });
    return req as IDBRequest<T>;
  }

  function makeStore(tx: any): IDBObjectStore {
    return {
      put: (value: unknown, key: unknown) => {
        store.set(key, value);
        return makeRequest(tx, undefined);
      },
      get: (key: unknown) => makeRequest(tx, store.get(key)),
      delete: (key: unknown) => {
        store.delete(key);
        return makeRequest(tx, undefined);
      },
    } as unknown as IDBObjectStore;
  }

  function makeTx(): IDBTransaction {
    const tx: any = { onerror: null, oncomplete: null, onabort: null, error: null, _pending: 0, _readyToComplete: false };
    tx._maybeComplete = () => {
      if (tx._readyToComplete && tx._pending === 0 && tx.oncomplete) {
        tx.oncomplete({ target: tx });
        tx.oncomplete = null;
      }
    };
    // Mark "no more requests will be issued" after the current microtask drain
    // so any synchronous put/get calls have already registered their pending
    // counts before we evaluate completion.
    queueMicrotask(() => {
      tx._readyToComplete = true;
      tx._maybeComplete();
    });
    tx.objectStore = (_name: string) => makeStore(tx);
    return tx as IDBTransaction;
  }

  function makeDB(): IDBDatabase {
    return {
      objectStoreNames: { contains: () => true } as unknown as DOMStringList,
      transaction: () => makeTx(),
      close: () => {},
      createObjectStore: () => makeStore(),
    } as unknown as IDBDatabase;
  }

  const fakeIDB: any = {
    open: () => {
      const req: any = {
        result: makeDB(),
        error: null,
        onupgradeneeded: null,
        onsuccess: null,
        onerror: null,
        onblocked: null,
      };
      queueMicrotask(() => {
        if (opts.failOpen) {
          req.error = new Error("simulated open failure");
          if (req.onerror) req.onerror({ target: req });
        } else if (req.onsuccess) {
          req.onsuccess({ target: req });
        }
      });
      return req;
    },
  };

  const originalIDB = (globalThis as any).indexedDB;
  (globalThis as any).indexedDB = fakeIDB;
  return {
    store,
    uninstall: () => {
      (globalThis as any).indexedDB = originalIDB;
    },
  };
}

describe("refresh-token-storage", () => {
  let cleanup: () => void = () => {};

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    // task #737: storage now mirrors writes to localStorage too. Without an
    // explicit clear here, a token written by one test would leak into the
    // "returns null when nothing is stored" assertion in the next test.
    try { window.localStorage.clear(); } catch {}
  });

  describe("happy path (IDB available)", () => {
    let store: StoredKV;
    beforeEach(() => {
      const setup = installFakeIndexedDB();
      store = setup.store;
      cleanup = setup.uninstall;
    });

    it("setStoredRefreshToken writes the token under the expected key", async () => {
      await setStoredRefreshToken("token-abc-123");
      // Single entry, value matches what we wrote.
      expect(Array.from(store.values())).toEqual(["token-abc-123"]);
    });

    it("getStoredRefreshToken reads back the previously written token", async () => {
      await setStoredRefreshToken("token-xyz-789");
      const out = await getStoredRefreshToken();
      expect(out).toBe("token-xyz-789");
    });

    it("getStoredRefreshToken returns null when nothing is stored", async () => {
      const out = await getStoredRefreshToken();
      expect(out).toBeNull();
    });

    it("clearStoredRefreshToken empties the store and getStoredRefreshToken returns null", async () => {
      await setStoredRefreshToken("token-doomed");
      await clearStoredRefreshToken();
      const out = await getStoredRefreshToken();
      expect(out).toBeNull();
    });

    it("setStoredRefreshTokenStrict resolves on success and persists the value", async () => {
      await expect(setStoredRefreshTokenStrict("token-strict")).resolves.toBeUndefined();
      expect(await getStoredRefreshToken()).toBe("token-strict");
    });
  });

  describe("failure surfacing (strict variant)", () => {
    it("setStoredRefreshTokenStrict rejects when indexedDB.open errors (so callers can fire telemetry)", async () => {
      const setup = installFakeIndexedDB({ failOpen: true });
      cleanup = setup.uninstall;
      await expect(setStoredRefreshTokenStrict("token-doomed")).rejects.toBeTruthy();
    });

    it("setStoredRefreshTokenStrict rejects when indexedDB is unavailable entirely", async () => {
      const original = (globalThis as any).indexedDB;
      (globalThis as any).indexedDB = undefined;
      cleanup = () => {
        (globalThis as any).indexedDB = original;
      };
      await expect(setStoredRefreshTokenStrict("token-no-idb")).rejects.toThrow(/IndexedDB/);
    });
  });
});
