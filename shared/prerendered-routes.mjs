/**
 * Single source of truth for the marketing/public routes that are
 * pre-rendered to static HTML at build time (see scripts/prerender.mjs).
 *
 * Imported by:
 *   - client/src/prerender-entry.tsx  (which routes to render)
 *   - server/vite.ts                  (which paths to serve as static HTML)
 *   - scripts/purge-cdn.mjs           (which paths to purge on the CDN
 *                                      after a deploy with new asset hashes)
 *
 * To add a new pre-rendered route, append its path here and add the
 * matching <Route> inside client/src/prerender-entry.tsx. The Express
 * file mapping in server/vite.ts is generated from this list, and the
 * CDN purge list picks the new path up automatically. See
 * docs/cdn-purge-runbook.md.
 */
export const PRERENDERED_ROUTE_PATHS = ["/", "/privacy", "/terms", "/licenses"];
