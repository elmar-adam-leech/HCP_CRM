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
// task #737: also mirror the refresh token to localStorage so it survives an
// eviction that wipes IDB. Reads check both; writes hit both. Format is the
// raw token string (not a JSON envelope) for backward compatibility with the
// IDB-only behaviour from #720.
const LS_KEY = "refresh-token";

function safeLocalStorage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

function readLocalStorage(): string | null {
  const ls = safeLocalStorage();
  if (!ls) return null;
  try {
    const raw = ls.getItem(LS_KEY);
    return typeof raw === "string" && raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

function writeLocalStorage(token: string): boolean {
  const ls = safeLocalStorage();
  if (!ls) return false;
  try {
    ls.setItem(LS_KEY, token);
    return true;
  } catch {
    return false;
  }
}

function clearLocalStorageEntry(): void {
  const ls = safeLocalStorage();
  if (!ls) return;
  try {
    ls.removeItem(LS_KEY);
  } catch {
    // ignore — clear is best-effort
  }
}

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
  // task #737: check both stores. IDB is the historical canonical store from
  // #720; LS is the new mirror. Either may be evicted independently on iOS,
  // so we accept whichever has a value.
  const idbValue = await withStore<string>("readonly", (s) => s.get(KEY) as IDBRequest<string>);
  if (typeof idbValue === "string" && idbValue.length > 0) return idbValue;
  return readLocalStorage();
}

export async function setStoredRefreshToken(token: string): Promise<void> {
  // task #737: write to BOTH stores in parallel so an eviction of one does
  // not strand the SPA without a usable fallback.
  writeLocalStorage(token);
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
  // task #737: also mirror to localStorage. The LS write is best-effort —
  // its failure does not block the strict IDB path because LS-only is a
  // strictly weaker fallback than IDB+LS, and the existing telemetry
  // contract is keyed to the IDB-write outcome.
  writeLocalStorage(token);
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
  // task #737: clear from BOTH stores so a logout / dead-token outcome wipes
  // every persistent copy of the refresh token.
  clearLocalStorageEntry();
  await withStore("readwrite", (s) => {
    s.delete(KEY);
  });
}
