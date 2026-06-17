import { db } from "../db";
import { contractorIntegrations } from "@shared/schema";
import { and, eq } from "drizzle-orm";

/**
 * Cached "does any contractor have this integration enabled?" gate.
 *
 * Background loops that only do work for a specific integration (the Dialpad
 * event-recovery poller, the Dialpad/HCP health checkers) used to run their
 * heavy queries on every tick regardless of whether the integration is
 * configured anywhere. This helper lets those loops short-circuit cheaply.
 *
 * The result is cached per integration name for `ttlMs` (default 5 min) so the
 * common case is a memory read, not a DB round-trip. Newly-connected
 * integrations are picked up within one TTL automatically; callers that need
 * immediate pickup (e.g. a webhook arriving for a freshly-enabled integration)
 * can force a re-check via `invalidateIntegrationPresence(name)`.
 */

const DEFAULT_TTL_MS = 5 * 60_000;

interface CacheEntry {
  value: boolean;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

export async function hasAnyEnabledIntegration(
  name: string,
  ttlMs: number = DEFAULT_TTL_MS,
): Promise<boolean> {
  const now = Date.now();
  const cached = cache.get(name);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const rows = await db
    .select({ contractorId: contractorIntegrations.contractorId })
    .from(contractorIntegrations)
    .where(
      and(
        eq(contractorIntegrations.integrationName, name),
        eq(contractorIntegrations.isEnabled, true),
      ),
    )
    .limit(1);

  const value = rows.length > 0;
  cache.set(name, { value, expiresAt: now + ttlMs });
  return value;
}

export function invalidateIntegrationPresence(name?: string): void {
  if (name === undefined) {
    cache.clear();
  } else {
    cache.delete(name);
  }
}

/** Test-only: drop all cached entries. */
export function _resetIntegrationPresenceForTests(): void {
  cache.clear();
}
