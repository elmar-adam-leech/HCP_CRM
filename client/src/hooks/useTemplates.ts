import { useQuery } from "@tanstack/react-query";
import type { Template } from "@shared/schema";

/**
 * Fetches templates filtered by type ('text' | 'email').
 * Using a shared hook instead of inline fetch() inside queryFn ensures:
 *  - The default global queryFn (with credentials: 'include') is used.
 *  - A single cache entry per type is shared across TextingModal, EmailComposerModal,
 *    and Templates page — no duplicated network requests.
 */
export function useTemplates(type: 'text' | 'email', enabled = true) {
  return useQuery<Template[]>({
    queryKey: ['/api/templates', type],
    queryFn: async () => {
      const response = await fetch(`/api/templates?type=${type}`, {
        credentials: 'include',
      });
      if (!response.ok) throw new Error('Failed to fetch templates');
      return response.json();
    },
    enabled,
  });
}
