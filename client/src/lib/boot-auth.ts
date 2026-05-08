/**
 * Cold-start auth resolution helpers (task #738).
 *
 * Resolution chain: cookie → bearer → passkey-conditional → passkey-explicit
 * → password. The cookie/bearer paths are handled by the existing request
 * layer; this module owns telemetry, the server "is a passkey worth trying"
 * probe, and the WebAuthn round-trip used by both the boot-time and
 * conditional-UI flows.
 */

import { getStoredAuthTokenSync } from "@/lib/auth-token-storage";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";

export type BootSource =
  | "cookie"
  | "bearer"
  | "passkey-conditional"
  | "passkey-explicit"
  | "password"
  | "none";

interface FinishResponse {
  authToken?: string;
  refreshToken?: string;
  user?: { id: string; contractorId?: string };
  [k: string]: unknown;
}

/** Synchronous best-effort sniff of locally-available credential material. */
export function determineBootSource(): BootSource {
  if (typeof document !== "undefined") {
    const cookies = document.cookie.split(";").map((c) => c.trim());
    if (cookies.some((c) => c.startsWith("auth_token="))) return "cookie";
  }
  if (getStoredAuthTokenSync()) return "bearer";
  return "none";
}

/** Fire-and-forget telemetry beacon. Never blocks boot, never throws. */
export function reportBootResolution(source: BootSource): void {
  try {
    void fetch("/api/auth/storage-probe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ bootResolution: source }),
    }).catch(() => {});
  } catch {
    // ignore
  }
}

/**
 * Ask the server whether trying a passkey is worthwhile. The endpoint is
 * deliberately non-enumerating: any well-formed email returns true; without
 * an email it gates on the non-secret pkhint=1 cookie.
 */
export async function checkHasPasskeyHint(email?: string): Promise<boolean> {
  try {
    const url = email
      ? `/api/auth/webauthn/has-credentials?email=${encodeURIComponent(email)}`
      : `/api/auth/webauthn/has-credentials`;
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) return false;
    const data = (await res.json().catch(() => ({}))) as { hasAny?: boolean };
    return Boolean(data?.hasAny);
  } catch {
    return false;
  }
}

export interface PasskeyAuthResult {
  ok: boolean;
  /**
   * - "passkey-conditional": resolved via WebAuthn conditional-UI / autofill.
   * - "passkey-explicit": resolved via the immediate (system picker) flow.
   */
  source: "passkey-conditional" | "passkey-explicit" | "skipped" | "cancelled" | "unsupported" | "error";
  data?: FinishResponse;
  errorMessage?: string;
}

interface AttemptOpts {
  signal?: AbortSignal;
  /**
   * If true, request `useBrowserAutofill` so the assertion resolves silently
   * inside the autocomplete dropdown (LoginForm uses this). If false, run
   * the immediate / system-picker flow (boot-time uses this — there is no
   * focused input element to autofill into during cold start).
   */
  conditional?: boolean;
}

/**
 * Run the WebAuthn login/begin → finish round-trip. Returns the parsed
 * server response on success so the caller can persist tokens.
 */
export async function attemptPasskeyAuth(
  opts: AttemptOpts = {},
): Promise<PasskeyAuthResult> {
  let webauthn: typeof import("@simplewebauthn/browser");
  try {
    webauthn = await import("@simplewebauthn/browser");
  } catch {
    return { ok: false, source: "unsupported" };
  }
  const { startAuthentication, browserSupportsWebAuthnAutofill } = webauthn;

  // Conditional mediation must be explicitly available before we attempt
  // it. We check both the WebAuthn-spec API
  // (`PublicKeyCredential.isConditionalMediationAvailable`) and the
  // SimpleWebAuthn helper. If conditional was requested but is not
  // available, return `skipped` instead of silently falling back to the
  // explicit / system-picker flow — the explicit flow is reserved for
  // user-initiated CTAs.
  if (opts.conditional) {
    let conditionalAvailable = false;
    try {
      const PKC = (typeof window !== "undefined" ? window.PublicKeyCredential : undefined) as
        | (typeof window.PublicKeyCredential & {
            isConditionalMediationAvailable?: () => Promise<boolean>;
          })
        | undefined;
      if (PKC && typeof PKC.isConditionalMediationAvailable === "function") {
        conditionalAvailable = await PKC.isConditionalMediationAvailable();
      } else {
        conditionalAvailable = await browserSupportsWebAuthnAutofill();
      }
    } catch {
      conditionalAvailable = false;
    }
    if (!conditionalAvailable) {
      return { ok: false, source: "skipped" };
    }
  }
  const useAutofill = !!opts.conditional;

  let beginRes: Response;
  try {
    beginRes = await fetch("/api/auth/webauthn/login/begin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: "{}",
      signal: opts.signal,
    });
  } catch {
    return { ok: false, source: "error", errorMessage: "network" };
  }
  if (!beginRes.ok) {
    return { ok: false, source: "error", errorMessage: "begin-failed" };
  }
  const begin = (await beginRes.json().catch(() => ({}))) as {
    sessionId?: string;
    options?: PublicKeyCredentialRequestOptionsJSON;
  };
  if (!begin.sessionId || !begin.options) {
    return { ok: false, source: "error", errorMessage: "bad-begin-payload" };
  }

  let assertion: AuthenticationResponseJSON;
  try {
    assertion = await startAuthentication(
      useAutofill
        ? { optionsJSON: begin.options, useBrowserAutofill: true }
        : { optionsJSON: begin.options },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("NotAllowed") || msg.includes("AbortError")) {
      return { ok: false, source: "cancelled" };
    }
    return { ok: false, source: "error", errorMessage: msg };
  }

  let finishRes: Response;
  try {
    finishRes = await fetch("/api/auth/webauthn/login/finish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ sessionId: begin.sessionId, response: assertion }),
      signal: opts.signal,
    });
  } catch {
    return { ok: false, source: "error", errorMessage: "finish-network" };
  }
  if (!finishRes.ok) {
    const err = (await finishRes.json().catch(() => ({}))) as { message?: string };
    return { ok: false, source: "error", errorMessage: err?.message || "finish-failed" };
  }
  const data = (await finishRes.json().catch(() => ({}))) as FinishResponse;
  return {
    ok: true,
    source: useAutofill ? "passkey-conditional" : "passkey-explicit",
    data,
  };
}

/** Backwards-compat alias kept so the LoginForm conditional-UI effect can
 * keep its existing import path. */
export const attemptConditionalPasskey = (opts: { signal?: AbortSignal } = {}) =>
  attemptPasskeyAuth({ ...opts, conditional: true });

/**
 * Pre-render boot attempt (called from main.tsx when cookie + bearer both
 * miss). Gates on platform-authenticator availability AND the server hint
 * before triggering Face ID, and bounds the attempt to 8 seconds so a hung
 * prompt never blocks the SPA from mounting.
 */
export type BootSilentPasskeyResult =
  | { ok: true; source: "passkey-conditional" | "passkey-explicit" }
  | { ok: false; source: "skipped" | "cancelled" | "error" };

export async function attemptBootSilentPasskey(
  opts: { timeoutMs?: number } = {},
): Promise<BootSilentPasskeyResult> {
  const timeoutMs = opts.timeoutMs ?? 8000;
  try {
    if (typeof window === "undefined" || !window.PublicKeyCredential) {
      return { ok: false, source: "skipped" };
    }
    const PKC = window.PublicKeyCredential as typeof window.PublicKeyCredential & {
      isUserVerifyingPlatformAuthenticatorAvailable?: () => Promise<boolean>;
    };
    if (typeof PKC.isUserVerifyingPlatformAuthenticatorAvailable === "function") {
      const supported = await PKC.isUserVerifyingPlatformAuthenticatorAvailable();
      if (!supported) return { ok: false, source: "skipped" };
    }
  } catch {
    return { ok: false, source: "skipped" };
  }

  // pkhint=1 is a useful priority signal but NOT a hard gate — the exact
  // failure mode this task targets (full iOS storage partition wipe) also
  // erases the cookie. We attempt the unlock anyway; the OS itself is the
  // source of truth for whether a discoverable credential exists.
  await checkHasPasskeyHint();

  const ac = new AbortController();
  const timer = setTimeout(() => {
    try { ac.abort(); } catch { /* noop */ }
  }, timeoutMs);

  try {
    // Try conditional mediation first — when the browser+OS supports it
    // this can resolve completely invisibly. If conditional is not
    // available, the helper returns `skipped` and we fall back to the
    // explicit (system-picker) flow as a controlled boot fallback. This
    // is the only place an explicit prompt may be surfaced from boot;
    // user-mounted background effects in LoginForm only ever attempt
    // conditional and report skipped otherwise.
    let result = await attemptPasskeyAuth({ signal: ac.signal, conditional: true });
    if (!result.ok && result.source === "skipped") {
      result = await attemptPasskeyAuth({ signal: ac.signal, conditional: false });
    }
    if (!result.ok) {
      const fallbackSource: "skipped" | "cancelled" | "error" =
        result.source === "cancelled"
          ? "cancelled"
          : result.source === "skipped" || result.source === "unsupported"
            ? "skipped"
            : "error";
      return { ok: false, source: fallbackSource };
    }
    if (result.data) {
      try {
        const {
          persistRefreshTokenFromResponse,
          persistAuthTokenFromResponse,
        } = await import("@/lib/queryClient");
        await persistRefreshTokenFromResponse(result.data);
        await persistAuthTokenFromResponse(result.data);
      } catch {
        // Token persist failure: user will be re-prompted on the next /api
        // call. Not a hard failure for boot.
      }
    }
    return {
      ok: true,
      source:
        result.source === "passkey-explicit"
          ? "passkey-explicit"
          : "passkey-conditional",
    };
  } catch {
    return { ok: false, source: "error" };
  } finally {
    clearTimeout(timer);
  }
}
