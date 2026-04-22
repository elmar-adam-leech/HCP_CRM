# CDN purge runbook (pre-rendered marketing routes)

The marketing pages at `/`, `/privacy`, `/terms`, and `/licenses` are
pre-rendered to static HTML at build time and served with
`Cache-Control: public, max-age=300, must-revalidate`. That means a CDN /
edge POP in front of the app is allowed to cache them, so cellular visitors
hit a nearby POP instead of the origin.

To make that safe, every deploy must invalidate those exact paths on the
CDN — otherwise an edge POP could keep serving HTML that still references
the previous build's hashed JS/CSS bundles, which were deleted from origin.
That invalidation runs automatically as part of `npm run build`.

## How it works

```
vite build
  └─ emits dist/public/{assets/*-[hash].{js,css}, ...}
node scripts/prerender.mjs
  ├─ writes dist/public/{,privacy,terms,licenses}/index.html
  │    (each containing <script src="/assets/index-[hash].js"> etc.)
  └─ calls purgeCdnIfBuildChanged() from scripts/purge-cdn.mjs
       ├─ hashes every pre-rendered HTML file → "build fingerprint"
       ├─ compares to dist/.cdn-purge-state.json (last fingerprint)
       ├─ if unchanged → no-op (rebuild without code changes)
       └─ if changed   → calls the configured CDN purge API for the
                         paths in shared/prerendered-routes.mjs, then
                         writes the new fingerprint
```

`Cache-Control` itself lives in `server/vite.ts` and can be overridden at
runtime with the `PRERENDERED_CACHE_CONTROL` env var (e.g. set to
`no-store` to temporarily disable edge caching during an incident — no
redeploy needed).

## Configuring the CDN

The purge step is a no-op until CDN credentials are set. Pick one
provider:

### Cloudflare

Set these as deployment secrets:

| Variable | Description |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | API token scoped to `Zone → Cache Purge → Purge` for the zone below. |
| `CLOUDFLARE_ZONE_ID` | The zone serving the app (Cloudflare dashboard → zone overview). |
| `CDN_PUBLIC_BASE_URL` | The origin of the deployed app, e.g. `https://app.example.com`. Used to build the absolute URLs that Cloudflare's `purge_cache` API requires. |

Cloudflare is auto-detected when `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ZONE_ID` are both present.

> **First-time setup:** the build records a fingerprint even when no
> credentials are configured. After you add the CDN secrets the *next*
> build won't trigger a purge unless the asset hashes also changed in
> that build. Run `node scripts/purge-cdn.mjs --force` once after
> wiring up credentials so the edge is primed with the current build.

### Generic webhook (Fastly, Bunny, custom)

| Variable | Description |
| --- | --- |
| `CDN_PROVIDER` | Set to `webhook`. |
| `CDN_PURGE_WEBHOOK_URL` | URL that receives `POST { "paths": ["/", "/privacy", ...] }`. |
| `CDN_PURGE_WEBHOOK_AUTH` | Optional. Sent verbatim as the `Authorization` header (e.g. `Bearer xyz`). |

## Adding a new pre-rendered route

1. **Add the path** to `PRERENDERED_ROUTE_PATHS` in
   `shared/prerendered-routes.mjs`. This is the single source of truth —
   the prerender script, the Express server, and the CDN purge step all
   read it.
2. **Render it.** Add the matching `<Route>` inside
   `client/src/prerender-entry.tsx` so the prerender SSR bundle knows how
   to render it.
3. **Map it to a file.** No change needed in `server/vite.ts` — the
   `PRERENDERED_ROUTES` map is built from the shared list, expecting
   `dist/public/<route>/index.html` (or `dist/public/index.html` for `/`).
4. **Verify.** Run `npm run build`. The build log should print
   `[prerender] Wrote dist/public/<route>/index.html` and
   `[purge-cdn] ... purged N URL(s)` (or `no-provider` locally).

## Manual operations

- **Force a purge** (e.g. you rolled back and want the edge to drop the
  rolled-back HTML):
  ```
  node scripts/purge-cdn.mjs --force
  ```
- **Reset the fingerprint** (next build will purge regardless of
  changes): delete `dist/.cdn-purge-state.json`.
- **Disable edge caching temporarily**: set
  `PRERENDERED_CACHE_CONTROL=no-store` on the deployment and restart.
  Reverts to the cacheable header by clearing the env var.

## Failure handling

A purge failure does **not** fail the build — the deploy succeeds and the
error is logged. The fingerprint is **not** advanced when a purge fails,
so the next successful run (manual `--force` or the next deploy) will
retry the same paths.
