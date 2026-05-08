// @vitest-environment jsdom
/**
 * task #738 — unit tests for the boot-auth helper.
 *
 * Covers:
 *   - determineBootSource() correctly resolves cookie > bearer > none.
 *   - reportBootResolution() POSTs the bootResolution field and never throws.
 *   - checkHasPasskeyHint() never throws on network failure.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Reset module cache between tests so dynamic imports inside the helper
// always pick up freshly mocked siblings.
beforeEach(() => { vi.resetModules(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('determineBootSource', () => {
  it('returns "cookie" when document.cookie contains auth_token', async () => {
    Object.defineProperty(document, 'cookie', { value: 'foo=bar; auth_token=xyz; baz=q', configurable: true });
    vi.doMock('@/lib/auth-token-storage', () => ({ getStoredAuthTokenSync: () => null }));
    const { determineBootSource } = await import('./boot-auth');
    expect(determineBootSource()).toBe('cookie');
  });

  it('returns "bearer" when only the local-storage mirror is populated', async () => {
    Object.defineProperty(document, 'cookie', { value: 'unrelated=1', configurable: true });
    vi.doMock('@/lib/auth-token-storage', () => ({ getStoredAuthTokenSync: () => 'jwt-here' }));
    const { determineBootSource } = await import('./boot-auth');
    expect(determineBootSource()).toBe('bearer');
  });

  it('returns "none" when neither cookie nor bearer mirror is present', async () => {
    Object.defineProperty(document, 'cookie', { value: '', configurable: true });
    vi.doMock('@/lib/auth-token-storage', () => ({ getStoredAuthTokenSync: () => null }));
    const { determineBootSource } = await import('./boot-auth');
    expect(determineBootSource()).toBe('none');
  });
});

describe('reportBootResolution', () => {
  it('POSTs /api/auth/storage-probe with bootResolution and never throws', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ supportsBearer: true }) });
    (globalThis as any).fetch = fetchSpy;
    vi.doMock('@/lib/auth-token-storage', () => ({ getStoredAuthTokenSync: () => null }));
    const { reportBootResolution } = await import('./boot-auth');
    expect(() => reportBootResolution('passkey-conditional')).not.toThrow();
    // microtask queue
    await Promise.resolve();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('/api/auth/storage-probe');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ bootResolution: 'passkey-conditional' });
  });

  it('swallows fetch rejection so boot is never blocked by telemetry', async () => {
    (globalThis as any).fetch = vi.fn().mockRejectedValue(new Error('offline'));
    vi.doMock('@/lib/auth-token-storage', () => ({ getStoredAuthTokenSync: () => null }));
    const { reportBootResolution } = await import('./boot-auth');
    expect(() => reportBootResolution('none')).not.toThrow();
  });
});

describe('attemptBootSilentPasskey (decision ordering)', () => {
  // These tests pin task #738's boot-order contract: cookie + bearer absent
  // is the ONLY path that reaches a Face ID prompt, and even then we must
  // first ask the server (`/has-credentials`) whether trying is worthwhile
  // — otherwise users with no local passkey would see a surprise OS prompt.

  it('skips when no platform authenticator is available', async () => {
    Object.defineProperty(window, 'PublicKeyCredential', {
      value: { isUserVerifyingPlatformAuthenticatorAvailable: async () => false },
      configurable: true,
    });
    const fetchSpy = vi.fn();
    (globalThis as any).fetch = fetchSpy;
    vi.doMock('@/lib/auth-token-storage', () => ({ getStoredAuthTokenSync: () => null }));
    const { attemptBootSilentPasskey } = await import('./boot-auth');
    const r = await attemptBootSilentPasskey();
    expect(r).toEqual({ ok: false, source: 'skipped' });
    // Must NOT have hit /has-credentials when the device cannot satisfy a
    // platform-authenticator request — otherwise we'd be polling the
    // anti-enumeration endpoint for nothing.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('still attempts when the server hint says no passkey is registered', async () => {
    // task #738 follow-up: pkhint=1 is a priority signal, not a hard gate
    // — the exact iOS storage-partition wipe this task targets ALSO erases
    // the cookie, so a false hint must not prevent the OS-driven
    // discoverable-credential lookup from running. The OS itself is the
    // source of truth for whether a credential exists.
    Object.defineProperty(window, 'PublicKeyCredential', {
      value: {
        isUserVerifyingPlatformAuthenticatorAvailable: async () => true,
        isConditionalMediationAvailable: async () => false,
      },
      configurable: true,
    });
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ hasAny: false }) })
      // Begin must still be reached even with a false hint.
      .mockResolvedValueOnce({ ok: false, json: async () => ({}) });
    (globalThis as any).fetch = fetchSpy;
    vi.doMock('@/lib/auth-token-storage', () => ({ getStoredAuthTokenSync: () => null }));
    const { attemptBootSilentPasskey } = await import('./boot-auth');
    const r = await attemptBootSilentPasskey();
    expect(r.ok).toBe(false);
    // Two fetches: has-credentials hint, then /webauthn/login/begin.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[0][0]).toContain('/api/auth/webauthn/has-credentials');
    expect(fetchSpy.mock.calls[1][0]).toContain('/api/auth/webauthn/login/begin');
  });
});

describe('checkHasPasskeyHint', () => {
  it('returns true when server says { hasAny: true }', async () => {
    (globalThis as any).fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ hasAny: true }) });
    vi.doMock('@/lib/auth-token-storage', () => ({ getStoredAuthTokenSync: () => null }));
    const { checkHasPasskeyHint } = await import('./boot-auth');
    await expect(checkHasPasskeyHint('a@b.com')).resolves.toBe(true);
  });

  it('returns false on network failure (no throw)', async () => {
    (globalThis as any).fetch = vi.fn().mockRejectedValue(new Error('network'));
    vi.doMock('@/lib/auth-token-storage', () => ({ getStoredAuthTokenSync: () => null }));
    const { checkHasPasskeyHint } = await import('./boot-auth');
    await expect(checkHasPasskeyHint()).resolves.toBe(false);
  });
});
