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
 */
export function useCurrentUser() {
  return useQuery<CurrentUserResponse>({
    queryKey: ['/api/auth/me'],
    queryFn: async () => {
      const response = await fetch('/api/auth/me', {
        credentials: 'include'
      });
      if (!response.ok) {
        throw new Error('Failed to fetch user info');
      }
      return response.json();
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
    gcTime: 30 * 60 * 1000, // 30 minutes (formerly cacheTime)
    refetchOnWindowFocus: false,
    retry: 1,
  });
}
