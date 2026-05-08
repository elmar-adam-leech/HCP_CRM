// task #737 — Cookieless bearer-token fallback storage.
//
// Mirrors the short-lived auth JWT into BOTH `localStorage["auth-token"]` AND
// IndexedDB `auth-fallback/auth-token`. Reads check both stores and prefer the
// most recently-written value (write timestamp stored alongside the token).
//
// Why both stores: on iOS PWA installs the two have different eviction
// behaviour — a single store wipe should not be able to log the user out.
// Cookies remain the default delivery path (httpOnly, immune to XSS); this
// fallback only runs when the auth_token cookie is missing.
//
// Security note: storing the raw JWT client-side is strictly weaker than the
// httpOnly cookie (an XSS would expose it). We accept that trade-off because
// the existing #720 design already stored the refresh token in IDB (also
// JS-readable), and without this fallback installed PWAs cannot meet the
// basic product expectation of staying signed in. See `replit.md` Security
// paragraph and `threat_model.md` PWA storage trade-off for the rationale.

const DB_NAME = "auth-fallback";
const DB_VERSION = 1;
const STORE = "tokens";
const IDB_KEY = "auth_token";
const LS_KEY = "auth-token";

interface StoredEntry {
  token: string;
  ts: number;
}

function safeGetLocalStorage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

function readLocalStorage(): StoredEntry | null {
  const ls = safeGetLocalStorage();
  if (!ls) return null;
  try {
    const raw = ls.getItem(LS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredEntry>;
    if (typeof parsed?.token === "string" && parsed.token.length > 0 && typeof parsed?.ts === "number") {
      return { token: parsed.token, ts: parsed.ts };
    }
    return null;
  } catch {
    return null;
  }
}

function writeLocalStorage(entry: StoredEntry): { ok: true } | { ok: false; error: unknown } {
  const ls = safeGetLocalStorage();
  if (!ls) return { ok: false, error: new Error("localStorage unavailable") };
  try {
    ls.setItem(LS_KEY, JSON.stringify(entry));
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

function clearLocalStorage(): void {
  const ls = safeGetLocalStorage();
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
    req.onerror = () => reject(req.error ?? new Error("indexedDB.open error"));
    req.onblocked = () => reject(new Error("indexedDB.open blocked"));
  });
}

async function readIdb(): Promise<StoredEntry | null> {
  let db: IDBDatabase;
  try {
    db = await openDb();
  } catch {
    return null;
  }
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, "readonly");
      const store = tx.objectStore(STORE);
      const req = store.get(IDB_KEY);
      let result: StoredEntry | null = null;
      req.onsuccess = () => {
        const value = req.result as Partial<StoredEntry> | string | undefined;
        // Tolerate the historical "raw string" shape too in case some other
        // call site wrote one — treat it as having no timestamp (oldest
        // possible) so the LS copy wins on conflict.
        if (typeof value === "string" && value.length > 0) {
          result = { token: value, ts: 0 };
        } else if (value && typeof (value as StoredEntry).token === "string") {
          const v = value as StoredEntry;
          result = { token: v.token, ts: typeof v.ts === "number" ? v.ts : 0 };
        }
      };
      tx.oncomplete = () => { db.close(); resolve(result); };
      tx.onerror = () => { db.close(); resolve(null); };
      tx.onabort = () => { db.close(); resolve(null); };
    } catch {
      try { db.close(); } catch {}
      resolve(null);
    }
  });
}

async function writeIdb(entry: StoredEntry): Promise<{ ok: true } | { ok: false; error: unknown }> {
  let db: IDBDatabase;
  try {
    db = await openDb();
  } catch (error) {
    return { ok: false, error };
  }
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      store.put(entry, IDB_KEY);
      tx.oncomplete = () => { db.close(); resolve({ ok: true }); };
      tx.onerror = () => { db.close(); resolve({ ok: false, error: tx.error ?? new Error("idb tx error") }); };
      tx.onabort = () => { db.close(); resolve({ ok: false, error: tx.error ?? new Error("idb tx abort") }); };
    } catch (error) {
      try { db.close(); } catch {}
      resolve({ ok: false, error });
    }
  });
}

async function clearIdb(): Promise<void> {
  let db: IDBDatabase;
  try {
    db = await openDb();
  } catch {
    return;
  }
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(IDB_KEY);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); resolve(); };
      tx.onabort = () => { db.close(); resolve(); };
    } catch {
      try { db.close(); } catch {}
      resolve();
    }
  });
}

/**
 * Read the most recently-written stored auth JWT, checking both localStorage
 * and IndexedDB. Returns `null` if neither store has a value. The newer write
 * timestamp wins on conflict — this matters when one store has been evicted
 * and re-seeded by a newer session while the other still holds a stale token.
 */
export async function getStoredAuthToken(): Promise<string | null> {
  const ls = readLocalStorage();
  let idb: StoredEntry | null = null;
  try {
    idb = await readIdb();
  } catch {
    idb = null;
  }
  if (!ls && !idb) return null;
  if (ls && !idb) return ls.token;
  if (!ls && idb) return idb.token;
  return (ls!.ts >= idb!.ts ? ls!.token : idb!.token);
}

/**
 * Synchronously read the localStorage copy of the stored auth JWT.
 *
 * Used in the request hot path (`apiRequest` / `getQueryFn`) where awaiting an
 * IDB read on every request would add latency. The IDB copy is only consulted
 * by `getStoredAuthToken()` for slower, less-frequent paths (e.g. boot-time
 * recovery). On the common case the LS copy is up-to-date because every
 * `persistAuthToken` write hits both stores.
 */
export function getStoredAuthTokenSync(): string | null {
  return readLocalStorage()?.token ?? null;
}

/**
 * Persist the auth JWT into BOTH stores. Best-effort: writes are attempted in
 * parallel and the result reflects whether at least one succeeded. The
 * caller's strict variant (`persistAuthTokenStrict`) surfaces failures via
 * the existing `auth-persist-failed` telemetry channel.
 */
export async function setStoredAuthToken(token: string): Promise<void> {
  const entry: StoredEntry = { token, ts: Date.now() };
  writeLocalStorage(entry);
  await writeIdb(entry);
}

/**
 * Strict variant — rejects if BOTH stores fail to persist. The caller
 * (`persistAuthTokenFromResponse`) maps the rejection into an
 * `auth-persist-failed` telemetry event so silent persistence failures don't
 * strand a freshly-issued JWT outside both stores.
 */
export async function setStoredAuthTokenStrict(token: string): Promise<void> {
  const entry: StoredEntry = { token, ts: Date.now() };
  const lsResult = writeLocalStorage(entry);
  const idbResult = await writeIdb(entry);
  if (!lsResult.ok && !idbResult.ok) {
    // Surface the IDB error preferentially because LS errors are usually just
    // "quota exceeded" while IDB errors are diagnostically richer.
    const err = !idbResult.ok ? idbResult.error : (lsResult as { error: unknown }).error;
    throw err instanceof Error ? err : new Error("auth-token persist failed");
  }
}

/**
 * Clear the auth JWT from BOTH stores. Called on logout, dead-token refresh
 * outcomes (revoked / not-found / expired / replayed-past-grace /
 * membership-missing), and any other path that proves the stored token is no
 * longer trustworthy.
 */
export async function clearStoredAuthToken(): Promise<void> {
  clearLocalStorage();
  try {
    await clearIdb();
  } catch {
    // ignore — clear is best-effort
  }
}

/**
 * task #737 (review fix): boot-time recovery — reconcile the LS and IDB
 * copies so the synchronous request hot path (`getStoredAuthTokenSync`) sees
 * the freshest token even when only IDB survived an eviction.
 *
 *   - If IDB has a token and LS doesn't, copy IDB → LS.
 *   - If both have tokens but IDB.ts > LS.ts, copy IDB → LS.
 *   - Otherwise no-op.
 *
 * Returns the resolved token (or null) so the caller can decide whether to
 * fire the `/api/auth/storage-probe` telemetry call without a second read.
 */
export async function bootRecoverAuthToken(): Promise<string | null> {
  const ls = readLocalStorage();
  let idb: StoredEntry | null = null;
  try {
    idb = await readIdb();
  } catch {
    idb = null;
  }
  if (!idb) return ls?.token ?? null;
  if (!ls || idb.ts > ls.ts) {
    writeLocalStorage({ token: idb.token, ts: idb.ts });
    return idb.token;
  }
  return ls.token;
}

let bootRecoveryPromise: Promise<string | null> | null = null;
/**
 * Idempotent boot-recovery wrapper. Caches the in-flight promise so multiple
 * concurrent callers (queryClient init, SPA boot probe, the first /api call)
 * all await the same single LS+IDB merge instead of racing.
 */
export function ensureBootRecovery(): Promise<string | null> {
  if (!bootRecoveryPromise) {
    bootRecoveryPromise = bootRecoverAuthToken().catch(() => null);
  }
  return bootRecoveryPromise;
}
if (typeof window !== "undefined") {
  // Kick off recovery as soon as the module loads so LS reflects the freshest
  // IDB copy before the first synchronous request-hot-path read.
  void ensureBootRecovery();
}
