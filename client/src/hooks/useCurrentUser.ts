import { useQuery } from "@tanstack/react-query";

export interface CurrentUser {
  id: string;
  username: string;
  name: string;
  email: string;
  role: string;
  contractorId: string;
  contractorName: string;
  dialpadDefaultNumber?: string;
  callPreference?: 'integration' | 'personal';
  gmailConnected?: boolean;
  gmailEmail?: string;
  canManageIntegrations: boolean;
  allowedIntegrations?: string[] | null;
  hasActiveCompanyIntegrations?: boolean;
  // task #738: post-first-login passkey enrollment-prompt state.
  // `passkeyPromptDismissedAt` is null until the user dismisses (or accepts)
  // the prompt; `passkeyCount` reflects how many WebAuthn credentials they
  // currently have. Both are surfaced from /api/auth/me so the SPA can decide
  // whether to show the dialog without an extra round-trip.
  passkeyPromptDismissedAt?: string | null;
  passkeyCount?: number;
}

export interface CurrentUserResponse {
  user: CurrentUser;
}

/**
 * Returns true if the given role has elevated (admin/manager) access.
 * Use this instead of repeating the three-way role check across pages.
 */
export function isAdminUser(role?: string): boolean {
  return role === 'admin' || role === 'super_admin' || role === 'manager';
}

/**
 * Returns true only for admin and super_admin roles (excludes manager).
 * Use when a gate is strictly admin-only, not manager-accessible.
 */
export function isStrictAdmin(role?: string): boolean {
  return role === 'admin' || role === 'super_admin';
}

/**
 * Hook to access the current authenticated user's data.
 * This data is cached at the app level and reused across all components.
 *
 * Intentionally does NOT supply a custom queryFn — it relies on the default
 * getQueryFn from `@/lib/queryClient`, which performs silent refresh on 401
 * via /api/auth/refresh (task #650). That recovery is essential for iOS PWAs
 * where the auth_token cookie can be evicted while the long-lived refresh
 * cookie survives.
 */
export function useCurrentUser() {
  return useQuery<CurrentUserResponse>({
    queryKey: ['/api/auth/me'],
    staleTime: 5 * 60 * 1000, // 5 minutes
    gcTime: 30 * 60 * 1000, // 30 minutes (formerly cacheTime)
    refetchOnWindowFocus: false,
    retry: 1,
  });
}
