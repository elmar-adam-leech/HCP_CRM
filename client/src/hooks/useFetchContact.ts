import type { Contact } from "@shared/schema";
import { queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

/**
 * Returns a `fetchContact` function that fetches a single contact by ID.
 *
 * Uses `queryClient.fetchQuery` instead of a raw `fetch` call so results are
 * cached in the React Query store. Subsequent calls with the same `contactId`
 * within the query's `staleTime` window are served instantly from cache.
 *
 * Use this hook in imperative event handlers (onClick, onSubmit, etc.) where
 * `useQuery` cannot be called conditionally. For declarative rendering prefer
 * `useQuery({ queryKey: ['/api/contacts', id] })` directly.
 */
export function useFetchContact() {
  const { toast } = useToast();

  const fetchContact = async (contactId: string): Promise<Contact | null> => {
    try {
      return await queryClient.fetchQuery<Contact>({
        queryKey: ['/api/contacts', contactId],
      });
    } catch {
      toast({
        title: "Error",
        description: "Failed to load contact information",
        variant: "destructive",
      });
      return null;
    }
  };

  return { fetchContact };
}
