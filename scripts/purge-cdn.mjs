#!/usr/bin/env node
/**
 * Auto-purge stale CDN/edge caches when a new build deploys.
 *
 * Runs at the tail of the build pipeline (invoked from scripts/prerender.mjs).
 * Compares the asset hashes referenced by the freshly-built pre-rendered HTML
 * against the hashes seen the last time this script ran. If they changed,
 * the build is new and we purge the marketing HTML paths on the configured
 * CDN so visitors don't get HTML pointing at deleted asset files.
 *
 * Supported providers (auto-selected via env vars):
 *
 *   Cloudflare:
 *     CDN_PROVIDER=cloudflare        (optional; auto-detected from token)
 *     CLOUDFLARE_API_TOKEN=<token with Cache Purge permission>
 *     CLOUDFLARE_ZONE_ID=<zone id>
 *     CDN_PUBLIC_BASE_URL=https://app.example.com   (used to build full URLs)
 *
 *   Generic webhook (works for Fastly/Bunny/custom):
 *     CDN_PROVIDER=webhook
 *     CDN_PURGE_WEBHOOK_URL=https://...             (POST receives JSON body
 *                                                    { paths: [...] })
 *     CDN_PURGE_WEBHOOK_AUTH=Bearer xyz             (optional, sent as
 *                                                    Authorization header)
 *
 * If no CDN env vars are set the script is a no-op (logs and exits 0). This
 * lets local builds and preview deploys run the same pipeline without
 * needing CDN credentials.
 *
 * State is stored at dist/.cdn-purge-state.json so the next build can detect
 * the asset-hash change. Delete that file to force a purge on the next build.
 *
 * See docs/cdn-purge-runbook.md for adding new routes.
 */
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { PRERENDERED_ROUTE_PATHS } from "../shared/prerendered-routes.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const distPublic = path.resolve(projectRoot, "dist/public");
const stateFile = path.resolve(projectRoot, "dist/.cdn-purge-state.json");

function log(msg) {
  console.log(`[purge-cdn] ${msg}`);
}

function warn(msg) {
  console.warn(`[purge-cdn] ${msg}`);
}

/**
 * Read every pre-rendered HTML file and hash its raw bytes. The hashed
 * /assets/* references inside change whenever Vite emits new bundle hashes,
 * so this fingerprint flips on any meaningful build change.
 */
async function computeBuildFingerprint() {
  const hash = createHash("sha256");
  for (const route of PRERENDERED_ROUTE_PATHS) {
    const filePath =
      route === "/"
        ? path.resolve(distPublic, "index.html")
        : path.resolve(distPublic, route.replace(/^\//, ""), "index.html");
    if (!existsSync(filePath)) {
      warn(`Missing pre-rendered file ${filePath}; skipping fingerprint entry`);
      continue;
    }
    const bytes = await fs.readFile(filePath);
    hash.update(route);
    hash.update("\0");
    hash.update(bytes);
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function readPreviousFingerprint() {
  if (!existsSync(stateFile)) return null;
  try {
    const raw = await fs.readFile(stateFile, "utf-8");
    return JSON.parse(raw).fingerprint ?? null;
  } catch (err) {
    warn(`Could not read ${stateFile}: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

async function writeFingerprint(fingerprint) {
  await fs.mkdir(path.dirname(stateFile), { recursive: true });
  await fs.writeFile(
    stateFile,
    JSON.stringify({ fingerprint, updatedAt: new Date().toISOString() }, null, 2),
    "utf-8",
  );
}

function detectProvider() {
  const explicit = process.env.CDN_PROVIDER?.toLowerCase();
  if (explicit) return explicit;
  if (process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_ZONE_ID) {
    return "cloudflare";
  }
  if (process.env.CDN_PURGE_WEBHOOK_URL) return "webhook";
  return null;
}

async function purgeCloudflare(paths) {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const zoneId = process.env.CLOUDFLARE_ZONE_ID;
  const baseUrl = process.env.CDN_PUBLIC_BASE_URL;
  if (!token || !zoneId) {
    throw new Error(
      "Cloudflare provider requires CLOUDFLARE_API_TOKEN and CLOUDFLARE_ZONE_ID",
    );
  }
  if (!baseUrl) {
    throw new Error(
      "Cloudflare purge requires CDN_PUBLIC_BASE_URL (e.g. https://app.example.com)",
    );
  }
  const files = paths.map((p) => new URL(p, baseUrl).toString());
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ files }),
    },
  );
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`Cloudflare purge failed (${res.status}): ${body}`);
  }
  log(`Cloudflare purged ${files.length} URL(s): ${files.join(", ")}`);
}

async function purgeWebhook(paths) {
  const url = process.env.CDN_PURGE_WEBHOOK_URL;
  if (!url) throw new Error("CDN_PURGE_WEBHOOK_URL is required for webhook provider");
  const headers = { "Content-Type": "application/json" };
  if (process.env.CDN_PURGE_WEBHOOK_AUTH) {
    headers.Authorization = process.env.CDN_PURGE_WEBHOOK_AUTH;
  }
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ paths }),
  });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`Webhook purge failed (${res.status}): ${body}`);
  }
  log(`Webhook purged ${paths.length} path(s) via ${url}`);
}

export async function purgeCdnIfBuildChanged({ force = false } = {}) {
  if (!existsSync(distPublic)) {
    warn(`No dist/public directory; skipping purge`);
    return { purged: false, reason: "no-dist" };
  }

  const fingerprint = await computeBuildFingerprint();
  const previous = await readPreviousFingerprint();

  if (!force && previous && previous === fingerprint) {
    log(`Build fingerprint unchanged (${fingerprint.slice(0, 12)}); no purge needed`);
    return { purged: false, reason: "unchanged" };
  }

  const provider = detectProvider();
  if (!provider) {
    log(
      "No CDN credentials configured (CLOUDFLARE_* or CDN_PURGE_WEBHOOK_URL); " +
        "skipping purge. Build fingerprint recorded for next run.",
    );
    await writeFingerprint(fingerprint);
    return { purged: false, reason: "no-provider" };
  }

  log(
    `Build fingerprint changed (was ${
      previous ? previous.slice(0, 12) : "none"
    } → ${fingerprint.slice(0, 12)}); purging via ${provider}`,
  );

  try {
    if (provider === "cloudflare") {
      await purgeCloudflare(PRERENDERED_ROUTE_PATHS);
    } else if (provider === "webhook") {
      await purgeWebhook(PRERENDERED_ROUTE_PATHS);
    } else {
      throw new Error(`Unknown CDN_PROVIDER: ${provider}`);
    }
  } catch (err) {
    // Do NOT fail the build on a purge error — the deploy itself succeeded
    // and operators can re-run `node scripts/purge-cdn.mjs --force` to retry.
    warn(`Purge failed: ${err instanceof Error ? err.message : err}`);
    return { purged: false, reason: "error", error: err };
  }

  await writeFingerprint(fingerprint);
  return { purged: true, provider, fingerprint };
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === __filename;

if (isMain) {
  const force = process.argv.includes("--force");
  purgeCdnIfBuildChanged({ force }).catch((err) => {
    console.error("[purge-cdn] Unexpected error:", err);
    process.exit(1);
  });
}
