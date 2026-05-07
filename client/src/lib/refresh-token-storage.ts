// Tiny IndexedDB wrapper for the long-lived refresh token. iOS Safari evicts
// httpOnly cookies aggressively for installed PWAs (often within 24h of last
// use), but it retains an installed PWA's IndexedDB store far longer. So we
// mirror the refresh token here as a durable fallback: when /api/auth/refresh
// fails because the cookie is missing, the client retries once with the IDB
// copy in the request body. See task #720.
//
// Security note: storing the raw refresh token client-side is strictly weaker
// than httpOnly cookies (an XSS would expose it), so this is a fallback only —
// the cookie is still the primary path. Both delivery paths hit the SAME
// server-side rotation, replay, and rate-limit checks.

const DB_NAME = "auth-fallback";
const DB_VERSION = 1;
const STORE = "tokens";
const KEY = "refresh_token";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T> | void,
): Promise<T | undefined> {
  let db: IDBDatabase;
  try {
    db = await openDb();
  } catch {
    return undefined;
  }
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    let result: T | undefined;
    const req = fn(store);
    if (req) {
      req.onsuccess = () => {
        result = req.result;
      };
    }
    tx.oncomplete = () => {
      db.close();
      resolve(result);
    };
    tx.onerror = () => {
      db.close();
      resolve(undefined);
    };
    tx.onabort = () => {
      db.close();
      resolve(undefined);
    };
  });
}

export async function getStoredRefreshToken(): Promise<string | null> {
  const value = await withStore<string>("readonly", (s) => s.get(KEY) as IDBRequest<string>);
  return typeof value === "string" && value.length > 0 ? value : null;
}

export async function setStoredRefreshToken(token: string): Promise<void> {
  await withStore("readwrite", (s) => {
    s.put(token, KEY);
  });
}

/**
 * Like `setStoredRefreshToken`, but surfaces the underlying IDB error so callers
 * can report a structured "persist failed" telemetry event. The `withStore`
 * helper above intentionally swallows transaction errors (so it can return
 * `undefined` rather than throw on private-mode browsers); this thin wrapper
 * goes one level deeper and rejects when `indexedDB.open` itself fails or when
 * the store is missing — the two conditions that would silently strand a
 * freshly-issued refresh token outside IDB. See task #734.
 */
export async function setStoredRefreshTokenStrict(token: string): Promise<void> {
  if (typeof indexedDB === "undefined") {
    throw new Error("IndexedDB unavailable");
  }
  const db: IDBDatabase = await new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const opening = req.result;
      if (!opening.objectStoreNames.contains(STORE)) {
        opening.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexedDB.open error"));
    req.onblocked = () => reject(new Error("indexedDB.open blocked"));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      store.put(token, KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("idb tx error"));
      tx.onabort = () => reject(tx.error ?? new Error("idb tx abort"));
    });
  } finally {
    db.close();
  }
}

export async function clearStoredRefreshToken(): Promise<void> {
  await withStore("readwrite", (s) => {
    s.delete(KEY);
  });
}
