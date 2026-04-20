import { queryClient } from "@/lib/queryClient";

// Centralized query invalidation helpers.
//
// Problem this solves: Every mutation's onSuccess callback across Leads.tsx,
// Jobs.tsx, Estimates.tsx, and Customers.tsx was manually listing the same 3-5
// query keys to invalidate. When a new related query was added, it had to be
// added to every onSuccess call individually.
//
// Usage:
//   import { invalidateContacts } from "@/hooks/useInvalidations";
//   // Inside useMutation onSuccess:
//   invalidateContacts(contactId);
//
// When to update this file:
//   Add a new query key here if it should always be invalidated together with
//   the existing keys for that entity type. Do NOT add one-off keys here —
//   those belong in the specific mutation's onSuccess handler.

/** Invalidate all contact-related queries. Pass contactId for per-contact cache. */
export function invalidateContacts(contactId?: string) {
  queryClient.invalidateQueries({ queryKey: ["/api/contacts/paginated"] });
  queryClient.invalidateQueries({ queryKey: ["/api/contacts/status-counts"] });
  queryClient.invalidateQueries({ queryKey: ["/api/contacts"] });
  queryClient.invalidateQueries({ queryKey: ["/api/contacts/follow-ups"] });
  queryClient.invalidateQueries({ queryKey: ["/api/follow-ups/unified"] });
  if (contactId) {
    queryClient.invalidateQueries({ queryKey: ["/api/contacts", contactId] });
  }
}

/** Invalidate all job-related queries. */
export function invalidateJobs() {
  queryClient.invalidateQueries({ queryKey: ["/api/jobs/paginated"] });
}

/** Invalidate all estimate-related queries. */
export function invalidateEstimates() {
  queryClient.invalidateQueries({ queryKey: ["/api/estimates/paginated"] });
  queryClient.invalidateQueries({ queryKey: ["/api/estimates/status-counts"] });
  queryClient.invalidateQueries({ queryKey: ["/api/estimates"] });
  queryClient.invalidateQueries({ queryKey: ["/api/estimates/follow-ups"] });
}

/** Invalidate activity feed queries (used when notes/activities are created). */
export function invalidateActivities() {
  queryClient.invalidateQueries({ queryKey: ["/api/activities"] });
}

/** Convenience: invalidate contacts + activities together (common after status changes). */
export function invalidateContactsAndActivities(contactId?: string) {
  invalidateContacts(contactId);
  invalidateActivities();
}

// WebSocket invalidation key sets — used by useWebSocketInvalidation() in each page.
// Centralizing these prevents silent misses when a new endpoint is added.
export const CONTACT_WS_INVALIDATIONS = [
  { types: ["new_activity", "activity_update"] as string[], queryKeys: ["/api/activities"] },
  { types: ["new_message", "message_update", "message_updated"] as string[], queryKeys: ["/api/conversations"] },
  {
    types: ["contact_created", "contact_updated", "contact_deleted"] as string[],
    queryKeys: [
      "/api/contacts/paginated",
      "/api/contacts/status-counts",
      "/api/contacts/follow-ups",
      "/api/contacts",
    ],
  },
];

export const ESTIMATE_WS_INVALIDATIONS = [
  {
    types: ["new_estimate", "estimate_created", "estimate_updated", "estimate_deleted"] as string[],
    queryKeys: [
      "/api/estimates/paginated",
      "/api/estimates/status-counts",
      "/api/estimates",
      "/api/estimates/follow-ups",
    ],
  },
];

export const JOB_WS_INVALIDATIONS = [
  {
    types: ["new_job", "job_created", "job_updated", "job_deleted"] as string[],
    queryKeys: ["/api/jobs/paginated"],
  },
  { types: ["contact_updated"] as string[], queryKeys: ["/api/jobs/paginated"] },
];
