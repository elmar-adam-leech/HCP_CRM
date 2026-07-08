import { storage } from '../storage';
import { CredentialService } from '../credential-service';
import { memoizeAsync } from '../utils/lru-ttl-cache';

/**
 * Cache Service
 *
 * Provides in-memory caching for frequently accessed data to reduce database load.
 * Backed by a tiny in-repo LRU+TTL helper (see server/utils/lru-ttl-cache.ts) —
 * replaces the previous `memoizee` dependency (task #774).
 */

// Cache user contractor relationship (permissions) for 5 minutes
// This is frequently accessed on every authenticated request
export const getUserContractorCached = memoizeAsync(
  async (userId: string, contractorId: string) => {
    return storage.getUserContractor(userId, contractorId);
  },
  {
    maxAge: 5 * 60 * 1000, // 5 minutes
    max: 1000,
    normalizer: (args) => `${args[0]}-${args[1]}`,
  },
);

// Cache user's contractors list for 5 minutes
export const getUserContractorsCached = memoizeAsync(
  async (userId: string) => {
    return storage.getUserContractors(userId);
  },
  {
    maxAge: 5 * 60 * 1000,
    max: 500,
  },
);

// Cache contractor settings for 10 minutes (changes infrequently)
export const getContractorCached = memoizeAsync(
  async (contractorId: string) => {
    return storage.getContractor(contractorId);
  },
  {
    maxAge: 10 * 60 * 1000,
    max: 500,
  },
);

// Cache terminology settings for 15 minutes (changes very infrequently)
export const getTerminologySettingsCached = memoizeAsync(
  async (contractorId: string) => {
    return storage.getTerminologySettings(contractorId);
  },
  {
    maxAge: 15 * 60 * 1000,
    max: 500,
  },
);

// Cache business targets for 10 minutes
export const getBusinessTargetsCached = memoizeAsync(
  async (contractorId: string) => {
    return storage.getBusinessTargets(contractorId);
  },
  {
    maxAge: 10 * 60 * 1000,
    max: 500,
  },
);

// Cache user details for 3 minutes
export const getUserCached = memoizeAsync(
  async (userId: string) => {
    return storage.getUser(userId);
  },
  {
    maxAge: 3 * 60 * 1000,
    max: 1000,
  },
);

// Cache the supplemental user fields surfaced by /api/auth/me (60s TTL).
// These fields change on rare user actions (gmail connect/disconnect, dialpad
// number update). Mutation handlers MUST call invalidateUserCache(userId) to
// avoid stale auth payloads.
export const getUserSupplementalCached = memoizeAsync(
  async (userId: string) => {
    const user = await storage.getUser(userId);
    if (!user) return null;
    // task #738: also surface passkey enrollment-prompt state and the
    // user's current passkey count, so the SPA can decide whether to
    // show the post-first-login enrollment dialog without a second
    // network round-trip. Both fields change rarely (passkey
    // register/remove + dismiss action) and the existing 60s TTL is
    // acceptable — a fresh dismissal becomes visible on the next /me.
    let passkeyCount = 0;
    try {
      const { db } = await import("../db");
      const { webauthnCredentials } = await import("@shared/schema");
      const { eq, sql } = await import("drizzle-orm");
      const rows = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(webauthnCredentials)
        .where(eq(webauthnCredentials.userId, userId));
      passkeyCount = Number(rows[0]?.count ?? 0);
    } catch {
      passkeyCount = 0;
    }
    return {
      dialpadDefaultNumber: user.dialpadDefaultNumber || undefined,
      gmailConnected: user.gmailConnected || false,
      gmailEmail: user.gmailEmail || undefined,
      googleCalendarConnected: user.googleCalendarConnected || false,
      googleCalendarEmail: user.googleCalendarEmail || undefined,
      passkeyPromptDismissedAt: (user as { passkeyPromptDismissedAt?: Date | null }).passkeyPromptDismissedAt ?? null,
      passkeyCount,
    };
  },
  {
    maxAge: 60 * 1000,
    max: 2000,
  },
);

// Cache the enabled-integrations list per contractor (60s TTL).
// /api/auth/me only needs `length > 0`, but other call sites read the rows.
// Invalidated on enable/disable via invalidateContractorCache.
export const getEnabledIntegrationsCached = memoizeAsync(
  async (contractorId: string) => {
    try {
      return await storage.getEnabledIntegrations(contractorId);
    } catch {
      return [];
    }
  },
  {
    maxAge: 60 * 1000,
    max: 1000,
  },
);

// Cache the joined user-contractors-with-details payload returned by
// GET /api/user/contractors. Mutation paths (add/remove/switch) MUST call
// invalidateUserCache(userId) so the dropdown reflects new memberships.
export const getUserContractorsWithDetailsCached = memoizeAsync(
  async (userId: string) => {
    const memberships = await storage.getUserContractors(userId);
    if (memberships.length === 0) return [];
    const contractorList = await storage.getContractorsByIds(memberships.map((uc) => uc.contractorId));
    const contractorMap = new Map(contractorList.map((c) => [c.id, c]));
    return memberships.map((uc) => ({ ...uc, contractor: contractorMap.get(uc.contractorId) }));
  },
  {
    maxAge: 60 * 1000,
    max: 1000,
  },
);

/**
 * Cache invalidation helpers
 * Call these when data changes to ensure cache consistency
 */
export const cacheInvalidation = {
  // Invalidate user contractor cache when permissions change
  invalidateUserContractor: (userId: string, contractorId: string) => {
    getUserContractorCached.delete(userId, contractorId);
    getUserContractorsCached.delete(userId);
  },

  // Invalidate all caches for a user
  invalidateUser: (userId: string) => {
    getUserCached.delete(userId);
    getUserContractorsCached.delete(userId);
    getUserSupplementalCached.delete(userId);
    getUserContractorsWithDetailsCached.delete(userId);
  },

  // Invalidate contractor settings cache
  invalidateContractor: (contractorId: string) => {
    getContractorCached.delete(contractorId);
    getTerminologySettingsCached.delete(contractorId);
    getBusinessTargetsCached.delete(contractorId);
    getEnabledIntegrationsCached.delete(contractorId);
  },

  // Invalidate terminology settings cache specifically
  invalidateTerminologySettings: (contractorId: string) => {
    getTerminologySettingsCached.delete(contractorId);
  },

  // Invalidate a single contact's cache entry when it is written or deleted.
  // Must be called from any storage method that mutates a contact row.
  invalidateContact: (id: string, contractorId: string) => {
    getContactCached.delete(id, contractorId);
  },

  // Clear all caches
  clearAll: () => {
    getUserContractorCached.clear();
    getUserContractorsCached.clear();
    getContractorCached.clear();
    getTerminologySettingsCached.clear();
    getBusinessTargetsCached.clear();
    getUserCached.clear();
    getContactCached.clear();
    isIntegrationEnabledCached.clear();
    getUserSupplementalCached.clear();
    getEnabledIntegrationsCached.clear();
    getUserContractorsWithDetailsCached.clear();
  },
};

// Convenience aliases that match the naming in task #595's spec.
export const invalidateUserCache = (userId: string) => cacheInvalidation.invalidateUser(userId);
export const invalidateContractorCache = (contractorId: string) => cacheInvalidation.invalidateContractor(contractorId);

// Cache workflow steps for 5 minutes.
// Workflow steps are fetched on every execution but rarely change mid-run.
// All step-modifying routes in server/routes/workflows.ts (step create, bulk
// replace via the workflow-builder save, step update, step delete, and
// workflow delete) call `invalidateWorkflowStepsCache` immediately after the
// write, so a 5-minute TTL is safe and reduces DB load by ~5x compared to the
// previous 60-second TTL. If you add any new code path that mutates workflow
// steps, you MUST call `invalidateWorkflowStepsCache(workflowId)` after the
// write or runs within the TTL window will use stale steps.
//
// Multi-process note: this is an in-memory cache, so invalidation only affects
// the current process. That is fine today because (a) the web app is the only
// long-lived process serving workflow runs, and (b) the standalone scheduled
// worker (server/worker.ts) starts fresh per invocation, so its cache never
// outlives a single run. No cross-process invalidation bus is needed.
//
// Key safety note: the cache key is `workflowId` only (no `contractorId`).
// This is safe because workflowIds are globally unique UUIDs — two different
// contractors can never have the same workflowId. Do NOT add contractorId to
// the key; it is not required and would quadruple the effective cache size.
// If workflowIds are ever changed to non-unique scoped IDs, the key MUST be
// updated to `${contractorId}:${workflowId}` to preserve multi-tenant isolation.
export const getWorkflowStepsCached = memoizeAsync(
  async (workflowId: string) => {
    return storage.getWorkflowSteps(workflowId);
  },
  {
    maxAge: 5 * 60 * 1000,
    max: 500,
    normalizer: (args) => args[0],
  },
);

// Invalidate a workflow's step cache when steps are created, updated, or deleted.
// Must be called from any route that modifies workflow steps.
export const invalidateWorkflowStepsCache = (workflowId: string) => {
  getWorkflowStepsCached.delete(workflowId);
};

// Cache isIntegrationEnabled for 30 seconds.
// This check runs on every contact creation and sync tick but the underlying
// setting almost never changes in the middle of a request cycle.
export const isIntegrationEnabledCached = memoizeAsync(
  async (contractorId: string, integrationName: string) => {
    return storage.isIntegrationEnabled(contractorId, integrationName);
  },
  {
    maxAge: 30 * 1000,
    max: 500,
    normalizer: (args) => `${args[0]}-${args[1]}`,
  },
);

// Invalidate the integration-enabled cache when an integration is toggled on/off.
export const invalidateIntegrationEnabledCache = (contractorId: string, integrationName: string) => {
  isIntegrationEnabledCached.delete(contractorId, integrationName);
};

// Cache individual contact lookups for 60 seconds.
// Cache keys are scoped by contractorId to preserve multi-tenant isolation.
// Write operations (updateContact, deleteContact) must call the corresponding
// invalidation helper below to avoid serving stale data.
export const getContactCached = memoizeAsync(
  async (id: string, contractorId: string) => {
    return storage.getContact(id, contractorId);
  },
  {
    maxAge: 60 * 1000,
    max: 2000,
    normalizer: (args) => `${args[0]}-${args[1]}`,
  },
);

// Cache credential lookups for the HCP webhook hot path (60-second TTL).
// Caching null results is intentional: a missing credential should not re-hit
// the DB on every incoming webhook request.
// Cache keys are scoped by contractorId + service + key to preserve
// multi-tenant isolation.
export const getCredentialCached = memoizeAsync(
  async (contractorId: string, service: string, key: string): Promise<string | null> => {
    return CredentialService.getCredential(contractorId, service, key);
  },
  {
    maxAge: 60 * 1000,
    max: 200,
    normalizer: (args) => `${args[0]}-${args[1]}-${args[2]}`,
  },
);

// Invalidate a specific credential from the cache (call when a credential is updated or deleted).
export const invalidateCredentialCache = (contractorId: string, service: string, key: string) => {
  getCredentialCached.delete(contractorId, service, key);
};

// Export cache statistics for monitoring
export const getCacheStats = () => {
  return {
    userContractors: {
      size: getUserContractorCached.length,
      maxAge: '5 minutes',
    },
    contractors: {
      size: getContractorCached.length,
      maxAge: '10 minutes',
    },
    terminology: {
      size: getTerminologySettingsCached.length,
      maxAge: '15 minutes',
    },
    users: {
      size: getUserCached.length,
      maxAge: '3 minutes',
    },
    workflowSteps: {
      size: getWorkflowStepsCached.length,
      maxAge: '5 minutes',
    },
    contacts: {
      size: getContactCached.length,
      maxAge: '60 seconds',
    },
  };
};
