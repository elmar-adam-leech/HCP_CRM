import express, { type Express } from "express";
import fs from "fs";
import path from "path";
import { createServer as createViteServer, createLogger } from "vite";
import { type Server } from "http";
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
  // etc.) are NOT content-hashed, so they keep the default short cache.
  app.use(express.static(distPath));

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
  const bookingSsr = createBookingSsrHandler({
    templatePath: spaShellPath,
    loadSsrModule: createProdBookingSsrLoader(path.resolve(distPath, "..")),
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
