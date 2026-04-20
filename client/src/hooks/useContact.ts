import { useQuery } from "@tanstack/react-query";
import type { Contact } from "@shared/schema";

/**
 * Fetches a single contact by ID.
 * Using a shared hook ensures:
 *  - A consistent queryKey (['/api/contacts', id]) is used everywhere,
 *    so cache invalidation via invalidateQueries({ queryKey: ['/api/contacts'] })
 *    correctly busts all per-contact cache entries.
 *  - EstimateCard, JobCard, and contact-combobox share the same cache entry
 *    for the same contact ID — no duplicated network requests.
 */
export function useContact(id: string | null | undefined) {
  return useQuery<Contact>({
    queryKey: ['/api/contacts', id],
    enabled: !!id,
  });
}
