/**
 * Per-tenant SSR for the public booking page (`/book/:slug`).
 *
 * The marketing routes (/, /privacy, /terms, /licenses) are pre-rendered at
 * build time into static HTML — but the booking page is per-tenant (logo,
 * brand color, services, etc.), so a one-shot static build won't work. We
 * instead render at request time using the same SSR bundle the build-time
 * prerender uses, populating react-query's cache with the contractor info so
 * the page paints branded content before the booking form's JS loads.
 *
 * In production we import the pre-built SSR bundle from dist/prerender. In
 * development we use Vite's ssrLoadModule so edits to the page hot-reload.
 */
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { type Request, type Response } from "express";
import type { ViteDevServer } from "vite";
import { storage } from "./storage";
import type { BookingContractor } from "../client/src/prerender-entry";

type RenderBooking = (opts: {
  slug: string;
  contractor: BookingContractor;
  search?: string;
}) => string;

interface SsrModule {
  renderBooking: RenderBooking;
}

const SLUG_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Tiny in-memory cache of rendered HTML per slug. The SSR render itself is
 * cheap, but the contractor lookup hits the DB and we don't want to do that
 * on every visitor. TTL is short so a contractor rename takes effect quickly.
 */
const HTML_CACHE_TTL_MS = 60_000;
type CacheEntry = { html: string; expiresAt: number };
const htmlCache = new Map<string, CacheEntry>();

function escapeJsonForScript(value: unknown): string {
  // </script> in JSON would close the script tag. Escape the < to be safe.
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function buildPage(
  template: string,
  contractor: BookingContractor,
  ssrHtml: string,
  slug: string,
): string {
  const safeName = escapeHtmlAttr(contractor.name);
  const description = `Schedule a free estimate with ${safeName}. Pick a date and time that works for you.`;
  let page = template;

  // Update <title>
  page = page.replace(
    /<title>[^<]*<\/title>/,
    `<title>Book an Appointment - ${safeName}</title>`,
  );

  // Update meta description
  page = page.replace(
    /<meta\s+name="description"[^>]*>/,
    `<meta name="description" content="${description}">`,
  );

  // Inject SSR'd markup into the root container and ship the contractor data
  // for the client to repopulate the react-query cache before hydration.
  const bootstrap = `<script>window.__BOOKING_DATA__=${escapeJsonForScript({
    slug,
    contractor,
  })}</script>`;
  page = page.replace(
    `<div id="root"></div>`,
    `<div id="root">${ssrHtml}</div>${bootstrap}`,
  );

  return page;
}

export interface BookingSsrHandlerOptions {
  /** Path to the SPA shell HTML template. */
  templatePath: string;
  /** Loads the SSR module (cached by callers as appropriate). */
  loadSsrModule: () => Promise<SsrModule>;
  /** Optional template transform (used by Vite in dev for HMR injection). */
  transformTemplate?: (url: string, html: string) => Promise<string>;
}

export function createBookingSsrHandler(opts: BookingSsrHandlerOptions) {
  return async function bookingSsrHandler(req: Request, res: Response, next: () => void) {
    const slug = req.params.slug;
    if (!slug || !SLUG_RE.test(slug)) {
      return next();
    }
    try {
      const cached = htmlCache.get(slug);
      if (cached && cached.expiresAt > Date.now()) {
        res.set("Cache-Control", "no-store");
        res.set("Content-Type", "text/html; charset=utf-8");
        res.status(200).end(cached.html);
        return;
      }

      const contractor = await storage.getContractorBySlug(slug);
      if (!contractor) {
        // Let the SPA 404 inside React (it shows a friendly card).
        return next();
      }

      const publicContractor: BookingContractor = {
        name: contractor.name,
        bookingSlug: contractor.bookingSlug ?? slug,
        bookingRedirectUrl: contractor.bookingRedirectUrl ?? null,
      };

      let template = await fs.readFile(opts.templatePath, "utf-8");
      if (opts.transformTemplate) {
        template = await opts.transformTemplate(req.originalUrl, template);
      }

      const mod = await opts.loadSsrModule();
      const ssrHtml = mod.renderBooking({
        slug,
        contractor: publicContractor,
        search: typeof req.query === "object" ? new URLSearchParams(req.query as Record<string, string>).toString() : "",
      });

      const html = buildPage(template, publicContractor, ssrHtml, slug);

      htmlCache.set(slug, { html, expiresAt: Date.now() + HTML_CACHE_TTL_MS });

      res.set("Cache-Control", "no-store");
      res.set("Content-Type", "text/html; charset=utf-8");
      res.status(200).end(html);
    } catch (err) {
      // SSR is a paint optimisation, never a correctness requirement. Fall
      // through to the SPA shell on any error so the page still works.
      console.warn("[booking-ssr] render failed, falling through to SPA:", err);
      next();
    }
  };
}

/**
 * Production: import the SSR bundle once from dist/prerender/.
 */
export function createProdBookingSsrLoader(distRoot: string): () => Promise<SsrModule> {
  let cached: Promise<SsrModule> | null = null;
  return () => {
    if (cached) return cached;
    const bundlePath = path.resolve(distRoot, "prerender", "prerender-entry.mjs");
    if (!existsSync(bundlePath)) {
      cached = Promise.reject(
        new Error(`[booking-ssr] SSR bundle missing at ${bundlePath} — run 'vite build && node scripts/prerender.mjs'`),
      );
      return cached;
    }
    cached = import(pathToFileURL(bundlePath).href) as Promise<SsrModule>;
    return cached;
  };
}

/**
 * Dev: use Vite's ssrLoadModule so edits to the booking page hot-reload.
 */
export function createDevBookingSsrLoader(
  vite: ViteDevServer,
  entryPath: string,
): () => Promise<SsrModule> {
  return async () => {
    const mod = await vite.ssrLoadModule(entryPath);
    return mod as unknown as SsrModule;
  };
}
