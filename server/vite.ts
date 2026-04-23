import express, { type Express } from "express";
import fs from "fs";
import path from "path";
import { createServer as createViteServer, createLogger } from "vite";
import { type Server } from "http";
// @ts-expect-error - critters ships types under src/ but its package.json
// "exports" map doesn't expose them, so TS can't resolve a declaration file.
import Critters from "critters";
import viteConfig from "../vite.config";
import { nanoid } from "nanoid";
import { PRERENDERED_ROUTE_PATHS } from "@shared/prerendered-routes.mjs";
import {
  createBookingSsrHandler,
  createDevBookingSsrLoader,
  createProdBookingSsrLoader,
} from "./booking-ssr";

// Cache-Control for pre-rendered marketing HTML. Short max-age + must-revalidate
// keeps mobile visitors hitting an edge POP for the typical session, but lets
// the CDN re-validate quickly. The deploy-time CDN purge (scripts/purge-cdn.mjs)
// is what guarantees a brand-new build is visible immediately even if a POP is
// still holding the previous HTML.
const PRERENDERED_CACHE_CONTROL =
  process.env.PRERENDERED_CACHE_CONTROL ?? "public, max-age=300, must-revalidate";

const viteLogger = createLogger();

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

export async function setupVite(app: Express, _server: Server) {
  // HMR is disabled because Replit's reverse proxy strips the
  // `Sec-WebSocket-Protocol: vite-hmr` header that Vite's HMR handshake
  // requires. Without it the handshake fails with a dirty close, Vite polls
  // until the server responds, then calls location.reload() — producing the
  // "page keeps refreshing every few seconds" symptom the user reported.
  // Disabling HMR stops the injected client from running at all, so there
  // are no reconnect loops and no forced reloads. The app's own /ws WebSocket
  // (for live data updates) is unaffected.
  const serverOptions = {
    middlewareMode: true,
    hmr: false,
    allowedHosts: true as const,
  };

  const vite = await createViteServer({
    ...viteConfig,
    configFile: false,
    customLogger: {
      ...viteLogger,
      error: (msg, options) => {
        viteLogger.error(msg, options);
        process.exit(1);
      },
    },
    server: serverOptions,
    appType: "custom",
  });

  app.use(vite.middlewares);

  const clientTemplate = path.resolve(
    import.meta.dirname,
    "..",
    "client",
    "index.html",
  );
  const ssrEntry = path.resolve(
    import.meta.dirname,
    "..",
    "client",
    "src",
    "prerender-entry.tsx",
  );

  // Per-tenant SSR for the public booking page so the branded card paints
  // before the React bundle loads. Falls through to the SPA shell on miss.
  const bookingSsr = createBookingSsrHandler({
    templatePath: clientTemplate,
    loadSsrModule: createDevBookingSsrLoader(vite, ssrEntry),
    transformTemplate: (url, html) => vite.transformIndexHtml(url, html),
  });
  app.get("/book/:slug", (req, res, next) => bookingSsr(req, res, next));

  app.use("*", async (req, res, next) => {
    const url = req.originalUrl;

    try {
      // always reload the index.html file from disk incase it changes
      let template = await fs.promises.readFile(clientTemplate, "utf-8");
      template = template.replace(
        `src="/src/main.tsx"`,
        `src="/src/main.tsx?v=${nanoid()}"`,
      );
      // Inject the Replit dev banner here (dev only) so it never ships in
      // production HTML. The banner adds a top notice when the dev server is
      // opened outside the Replit editor.
      template = template.replace(
        "</body>",
        `    <script type="text/javascript" src="https://replit.com/public/js/replit-dev-banner.js"></script>\n  </body>`,
      );
      const page = await vite.transformIndexHtml(url, template);
      res.status(200).set({ "Content-Type": "text/html" }).end(page);
    } catch (e) {
      vite.ssrFixStacktrace(e as Error);
      next(e);
    }
  });
}

export function serveStatic(app: Express) {
  const distPath = path.resolve(import.meta.dirname, "public");

  if (!fs.existsSync(distPath)) {
    throw new Error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`,
    );
  }

  // Content-hashed bundles in /assets are immutable — Vite gives every file in
  // its assetsDir a content hash in the filename, so a 1-year immutable cache
  // is safe. Returning visitors get an instant 304/cache hit instead of
  // re-downloading the full JS/CSS bundle on every page load.
  app.use(
    "/assets",
    express.static(path.join(distPath, "assets"), {
      maxAge: "1y",
      immutable: true,
    }),
  );

  // Other static files (manifest.json, icons, booking-widget.js, robots.txt,
  // etc.) are NOT content-hashed, so they keep the default short cache,
  // EXCEPT for the optimized landing-page logo variants and favicons —
  // those are referenced from the prerendered HTML and the LCP preload, so
  // a longer cache materially helps repeat-visit mobile metrics. A 30-day
  // public cache is the sweet spot: long enough to be useful, short enough
  // that a new build is picked up within a month even without an explicit
  // purge. Headers are set via `setHeaders` so serve-static cannot
  // overwrite them.
  const LOGO_RE =
    /^.*[\\/](hcp-crm-logo|favicon|apple-touch-icon|icon-\d+)[\w.-]*\.(avif|webp|png|svg|ico)$/i;
  app.use(
    express.static(distPath, {
      setHeaders(res, filePath) {
        if (LOGO_RE.test(filePath)) {
          res.setHeader("Cache-Control", "public, max-age=2592000");
        }
      },
    }),
  );

  // Marketing/public routes are pre-rendered into per-route HTML files at
  // build time (scripts/prerender.mjs). Serve those files directly so the
  // browser paints content before any JavaScript loads. The hashed JS/CSS
  // bundles they reference are still long-cached.
  //
  // Cache-Control is `public, max-age=300, must-revalidate` (overridable via
  // PRERENDERED_CACHE_CONTROL) so a CDN/edge POP can serve these pages
  // without round-tripping. New builds publish new asset hashes, and the
  // post-build CDN purge step (scripts/purge-cdn.mjs) invalidates these
  // exact paths so visitors never see HTML that points at deleted assets.
  // The route list is the single source of truth in
  // shared/prerendered-routes.mjs — see docs/cdn-purge-runbook.md when
  // adding a new route.
  //
  // Any path not in this set falls through to the SPA shell (spa.html, the
  // empty-root index.html the original SPA used) so wouter can route it.
  // The SPA shell stays `no-store` because it is the entry point for
  // authenticated app routes and must never be cached at the edge.
  const PRERENDERED_ROUTES: Record<string, string> = Object.fromEntries(
    PRERENDERED_ROUTE_PATHS.map((route) => [
      route,
      route === "/"
        ? path.resolve(distPath, "index.html")
        : path.resolve(distPath, route.replace(/^\//, ""), "index.html"),
    ]),
  );

  const spaShellPath = fs.existsSync(path.resolve(distPath, "spa.html"))
    ? path.resolve(distPath, "spa.html")
    : path.resolve(distPath, "index.html");

  // Per-tenant SSR for /book/:slug — paints the branded booking card before
  // any JavaScript loads. Uses the same SSR bundle the build-time prerender
  // produced (dist/prerender/prerender-entry.mjs).
  //
  // We also run Critters over the rendered HTML to inline the CSS rules used
  // for the first paint (mirroring what scripts/prerender.mjs does for the
  // static marketing pages). The full stylesheet is rewritten with a swap
  // preload so it takes over once it finishes loading. Critters output is
  // cached by booking-ssr alongside the rendered HTML, so the cost is paid at
  // most once per slug per cache TTL.
  const critters = new Critters({
    path: distPath,
    publicPath: "/",
    preload: "swap",
    pruneSource: false,
    reduceInlineStyles: false,
    logLevel: "silent",
  });
  const bookingSsr = createBookingSsrHandler({
    templatePath: spaShellPath,
    loadSsrModule: createProdBookingSsrLoader(path.resolve(distPath, "..")),
    inlineCriticalCss: (html) => critters.process(html),
  });
  app.get("/book/:slug", (req, res, next) => bookingSsr(req, res, next));

  app.use("*", (req, res) => {
    const prerendered = PRERENDERED_ROUTES[req.path];
    if (prerendered && fs.existsSync(prerendered)) {
      res.set("Cache-Control", PRERENDERED_CACHE_CONTROL);
      res.set("Content-Type", "text/html; charset=utf-8");
      return res.sendFile(prerendered);
    }
    res.set("Cache-Control", "no-store");
    res.sendFile(spaShellPath);
  });
}
