/**
 * Service worker registration (task #743).
 *
 * Called from main.tsx AFTER the React tree mounts so the SW install
 * never delays first interactive paint. The SW itself lives at
 * /sw.js (see client/public/sw.js).
 *
 * In development we explicitly skip registration — Vite serves modules
 * from /src/ and /@vite/, and we don't want a stale shell intercepting
 * HMR. Production builds ship the SW so reopens of the installed PWA
 * paint from cache instead of paying a full network round-trip.
 */
export function registerAppShellServiceWorker(): void {
  if (typeof window === "undefined") return;
  if (!("serviceWorker" in navigator)) return;
  if (import.meta.env.DEV) return;

  // Defer to idle so registration never competes with first paint.
  const register = () => {
    navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .catch(() => {
        // Registration failures are non-fatal — the app still works
        // without the cache, just slower on cold start.
      });
  };

  if ("requestIdleCallback" in window) {
    (window as unknown as {
      requestIdleCallback: (cb: () => void, opts?: { timeout?: number }) => void;
    }).requestIdleCallback(register, { timeout: 3000 });
  } else {
    setTimeout(register, 1000);
  }
}
