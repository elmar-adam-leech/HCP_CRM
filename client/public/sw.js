/**
 * App-shell service worker (task #743).
 *
 * Goal: make installed-PWA cold-start near-instant on iOS by serving the
 * app shell from cache while the network silently revalidates.
 *
 * Caching strategy:
 *   - /assets/*           : cache-first (Vite emits content-hashed filenames,
 *                           so a cached entry is safe to return forever).
 *   - / and /index.html   : stale-while-revalidate (HTML is unhashed).
 *   - Static icons/manifest in client/public/ : stale-while-revalidate.
 *
 * NEVER cached:
 *   - /api/*              : auth + tenant data, must always hit the server.
 *   - /_replit*           : Replit dev/internal endpoints.
 *   - WebSocket / non-GET : not cacheable.
 *   - Cross-origin        : SW only handles same-origin requests.
 *
 * Bump SW_VERSION on every deploy that changes shell behavior — old caches
 * with a different version are deleted on activate.
 */

const SW_VERSION = "v1-2026-05-10";
const ASSET_CACHE = `assets-${SW_VERSION}`;
const SHELL_CACHE = `shell-${SW_VERSION}`;

const SHELL_STATIC = [
  "/manifest.json",
  "/favicon-32.png",
  "/apple-touch-icon.png",
  "/icon-192.png",
  "/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k !== ASSET_CACHE && k !== SHELL_CACHE)
          .map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

function isSameOrigin(url) {
  return url.origin === self.location.origin;
}

function shouldBypass(url) {
  if (url.pathname.startsWith("/api/")) return true;
  if (url.pathname.startsWith("/_replit")) return true;
  if (url.pathname.startsWith("/@")) return true; // vite dev internals
  if (url.pathname.startsWith("/src/")) return true; // vite dev sources
  if (url.pathname.startsWith("/node_modules/")) return true;
  return false;
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response && response.ok && response.status === 200) {
    cache.put(request, response.clone()).catch(() => {});
  }
  return response;
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const networkPromise = fetch(request)
    .then((response) => {
      if (response && response.ok && response.status === 200) {
        cache.put(request, response.clone()).catch(() => {});
      }
      return response;
    })
    .catch(() => null);
  return cached || (await networkPromise) || fetch(request);
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (!isSameOrigin(url)) return;
  if (shouldBypass(url)) return;

  // Hashed Vite assets — cache forever.
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(cacheFirst(request, ASSET_CACHE));
    return;
  }

  // App-shell HTML navigations.
  if (request.mode === "navigate" || url.pathname === "/" || url.pathname === "/index.html") {
    event.respondWith(staleWhileRevalidate(request, SHELL_CACHE));
    return;
  }

  // Known static shell files.
  if (SHELL_STATIC.includes(url.pathname)) {
    event.respondWith(staleWhileRevalidate(request, SHELL_CACHE));
    return;
  }
});
