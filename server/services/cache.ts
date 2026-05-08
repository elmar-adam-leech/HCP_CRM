import memoizee from 'memoizee';
import { storage } from '../storage';
import { CredentialService } from '../credential-service';

/**
 * Cache Service
 * 
 * Provides in-memory caching for frequently accessed data to reduce database load.
 * Uses memoizee for automatic cache expiration and size limits.
 */

// Cache user contractor relationship (permissions) for 5 minutes
// This is frequently accessed on every authenticated request
export const getUserContractorCached = memoizee(
  async (userId: string, contractorId: string) => {
    return storage.getUserContractor(userId, contractorId);
  },
  {
    promise: true,
    maxAge: 5 * 60 * 1000, // 5 minutes
    max: 1000, // Max 1000 entries
    preFetch: true, // Refresh before expiry
    normalizer: (args) => `${args[0]}-${args[1]}`, // Create unique cache key
  }
);

// Cache user's contractors list for 5 minutes
export const getUserContractorsCached = memoizee(
  async (userId: string) => {
    return storage.getUserContractors(userId);
  },
  {
    promise: true,
    maxAge: 5 * 60 * 1000, // 5 minutes
    max: 500,
    preFetch: true,
  }
);

// Cache contractor settings for 10 minutes (changes infrequently)
export const getContractorCached = memoizee(
  async (contractorId: string) => {
    return storage.getContractor(contractorId);
  },
  {
    promise: true,
    maxAge: 10 * 60 * 1000, // 10 minutes
    max: 500,
    preFetch: true,
  }
);

// Cache terminology settings for 15 minutes (changes very infrequently)
export const getTerminologySettingsCached = memoizee(
  async (contractorId: string) => {
    return storage.getTerminologySettings(contractorId);
  },
  {
    promise: true,
    maxAge: 15 * 60 * 1000, // 15 minutes
    max: 500,
    preFetch: true,
  }
);

// Cache business targets for 10 minutes
export const getBusinessTargetsCached = memoizee(
  async (contractorId: string) => {
    return storage.getBusinessTargets(contractorId);
  },
  {
    promise: true,
    maxAge: 10 * 60 * 1000, // 10 minutes
    max: 500,
    preFetch: true,
  }
);

// Cache user details for 3 minutes
export const getUserCached = memoizee(
  async (userId: string) => {
    return storage.getUser(userId);
  },
  {
    promise: true,
    maxAge: 3 * 60 * 1000, // 3 minutes
    max: 1000,
    preFetch: true,
  }
);

// Cache the supplemental user fields surfaced by /api/auth/me (60s TTL).
// These fields change on rare user actions (gmail connect/disconnect, dialpad
// number update). Mutation handlers MUST call invalidateUserCache(userId) to
// avoid stale auth payloads.
export const getUserSupplementalCached = memoizee(
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
      passkeyPromptDismissedAt: (user as { passkeyPromptDismissedAt?: Date | null }).passkeyPromptDismissedAt ?? null,
      passkeyCount,
    };
  },
  {
    promise: true,
    maxAge: 60 * 1000, // 60 seconds
    max: 2000,
  }
);

// Cache the enabled-integrations list per contractor (60s TTL).
// /api/auth/me only needs `length > 0`, but other call sites read the rows.
// Invalidated on enable/disable via invalidateContractorCache.
export const getEnabledIntegrationsCached = memoizee(
  async (contractorId: string) => {
    try {
      return await storage.getEnabledIntegrations(contractorId);
    } catch {
      return [];
    }
  },
  {
    promise: true,
    maxAge: 60 * 1000, // 60 seconds
    max: 1000,
  }
);

// Cache the joined user-contractors-with-details payload returned by
// GET /api/user/contractors. Mutation paths (add/remove/switch) MUST call
// invalidateUserCache(userId) so the dropdown reflects new memberships.
export const getUserContractorsWithDetailsCached = memoizee(
  async (userId: string) => {
    const memberships = await storage.getUserContractors(userId);
    if (memberships.length === 0) return [];
    const contractorList = await storage.getContractorsByIds(memberships.map((uc) => uc.contractorId));
    const contractorMap = new Map(contractorList.map((c) => [c.id, c]));
    return memberships.map((uc) => ({ ...uc, contractor: contractorMap.get(uc.contractorId) }));
  },
  {
    promise: true,
    maxAge: 60 * 1000, // 60 seconds
    max: 1000,
  }
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
// Manual cache invalidation via `invalidateWorkflowStepsCache` is called by
// all step-modifying routes, so a 5-minute TTL is safe and reduces DB load
// by ~5x compared to the previous 60-second TTL.
//
// Key safety note: the cache key is `workflowId` only (no `contractorId`).
// This is safe because workflowIds are globally unique UUIDs — two different
// contractors can never have the same workflowId. Do NOT add contractorId to
// the key; it is not required and would quadruple the effective cache size.
// If workflowIds are ever changed to non-unique scoped IDs, the key MUST be
// updated to `${contractorId}:${workflowId}` to preserve multi-tenant isolation.
export const getWorkflowStepsCached = memoizee(
  async (workflowId: string) => {
    return storage.getWorkflowSteps(workflowId);
  },
  {
    promise: true,
    maxAge: 5 * 60 * 1000, // 5 minutes
    max: 500,
    normalizer: (args) => args[0],
  }
);

// Invalidate a workflow's step cache when steps are created, updated, or deleted.
// Must be called from any route that modifies workflow steps.
export const invalidateWorkflowStepsCache = (workflowId: string) => {
  getWorkflowStepsCached.delete(workflowId);
};

// Cache isIntegrationEnabled for 30 seconds.
// This check runs on every contact creation and sync tick but the underlying
// setting almost never changes in the middle of a request cycle.
export const isIntegrationEnabledCached = memoizee(
  async (contractorId: string, integrationName: string) => {
    return storage.isIntegrationEnabled(contractorId, integrationName);
  },
  {
    promise: true,
    maxAge: 30 * 1000, // 30 seconds
    max: 500,
    normalizer: (args) => `${args[0]}-${args[1]}`,
  }
);

// Invalidate the integration-enabled cache when an integration is toggled on/off.
export const invalidateIntegrationEnabledCache = (contractorId: string, integrationName: string) => {
  isIntegrationEnabledCached.delete(contractorId, integrationName);
};

// Cache individual contact lookups for 60 seconds.
// Cache keys are scoped by contractorId to preserve multi-tenant isolation.
// Write operations (updateContact, deleteContact) must call the corresponding
// invalidation helper below to avoid serving stale data.
export const getContactCached = memoizee(
  async (id: string, contractorId: string) => {
    return storage.getContact(id, contractorId);
  },
  {
    promise: true,
    maxAge: 60 * 1000, // 60 seconds
    max: 2000,
    normalizer: (args) => `${args[0]}-${args[1]}`,
  }
);

// Cache credential lookups for the HCP webhook hot path (60-second TTL).
// Caching null results is intentional: a missing credential should not re-hit
// the DB on every incoming webhook request.
// Cache keys are scoped by contractorId + service + key to preserve
// multi-tenant isolation.
export const getCredentialCached = memoizee(
  async (contractorId: string, service: string, key: string): Promise<string | null> => {
    return CredentialService.getCredential(contractorId, service, key);
  },
  {
    promise: true,
    maxAge: 60 * 1000, // 60 seconds
    max: 200,
    normalizer: (args) => `${args[0]}-${args[1]}-${args[2]}`,
  }
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
