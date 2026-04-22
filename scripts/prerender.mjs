#!/usr/bin/env node
/**
 * Pre-render the public/marketing routes to static HTML so the page paints
 * before React loads. Runs after `vite build` in the production build pipeline.
 *
 * Steps:
 *   1. Build a Vite SSR bundle of `client/src/prerender-entry.tsx`.
 *   2. Import the resulting module and call `render(path)` for each
 *      pre-rendered route.
 *   3. Inject the rendered markup into a copy of the SPA `index.html`.
 *   4. Inline critical CSS via `critters`.
 *   5. Write per-route HTML files into `dist/public/<route>/index.html`.
 *   6. Preserve the original SPA shell at `dist/public/spa.html` so
 *      `serveStatic` can fall back to it for non-prerendered routes.
 */
import { build } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import Critters from "critters";
import { purgeCdnIfBuildChanged } from "./purge-cdn.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const distPublic = path.resolve(projectRoot, "dist/public");
const ssrOutDir = path.resolve(projectRoot, "dist/prerender");

async function buildSsrBundle() {
  await build({
    root: path.resolve(projectRoot, "client"),
    logLevel: "warn",
    resolve: {
      alias: {
        "@": path.resolve(projectRoot, "client", "src"),
        "@shared": path.resolve(projectRoot, "shared"),
        "@assets": path.resolve(projectRoot, "attached_assets"),
      },
    },
    plugins: [react()],
    build: {
      ssr: path.resolve(projectRoot, "client/src/prerender-entry.tsx"),
      outDir: ssrOutDir,
      emptyOutDir: true,
      rollupOptions: {
        output: { format: "esm", entryFileNames: "prerender-entry.mjs" },
      },
    },
  });
}

async function main() {
  if (!existsSync(path.resolve(distPublic, "index.html"))) {
    throw new Error(
      `Expected ${distPublic}/index.html to exist. Run 'vite build' first.`
    );
  }

  console.log("[prerender] Building SSR bundle...");
  await buildSsrBundle();

  const entryPath = path.resolve(ssrOutDir, "prerender-entry.mjs");
  const mod = await import(pathToFileURL(entryPath).href);
  const { render, PRERENDER_PATHS } = mod;

  // Read the SPA shell once and preserve it for non-prerendered routes.
  const spaShell = await fs.readFile(
    path.resolve(distPublic, "index.html"),
    "utf-8"
  );
  await fs.writeFile(path.resolve(distPublic, "spa.html"), spaShell, "utf-8");

  const critters = new Critters({
    path: distPublic,
    publicPath: "/",
    preload: "swap",
    pruneSource: false,
    reduceInlineStyles: false,
    logLevel: "silent",
  });

  for (const route of PRERENDER_PATHS) {
    const html = render(route);
    let pageHtml = spaShell.replace(
      `<div id="root"></div>`,
      `<div id="root">${html}</div>`
    );
    try {
      pageHtml = await critters.process(pageHtml);
    } catch (err) {
      console.warn(
        `[prerender] critters failed for ${route}:`,
        err instanceof Error ? err.message : err
      );
    }

    const outPath =
      route === "/"
        ? path.resolve(distPublic, "index.html")
        : path.resolve(distPublic, route.replace(/^\//, ""), "index.html");
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, pageHtml, "utf-8");
    console.log(`[prerender] Wrote ${path.relative(projectRoot, outPath)}`);
  }

  // Purge the CDN edge caches for the pre-rendered routes if the build
  // produced new asset hashes. No-op when no CDN credentials are set.
  await purgeCdnIfBuildChanged();
}

main().catch((err) => {
  console.error("[prerender] Failed:", err);
  process.exit(1);
});
