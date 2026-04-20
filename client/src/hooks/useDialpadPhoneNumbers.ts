import { useQuery } from "@tanstack/react-query";

interface DialpadPhoneNumber {
  id: string;
  phoneNumber: string;
  displayName: string | null;
}

/**
 * Shared hook for fetching the contractor's Dialpad phone numbers.
 *
 * Using this hook instead of inline `useQuery` ensures all components share a
 * single cache entry at `/api/dialpad/phone-numbers`, preventing redundant
 * network requests across the page.
 *
 * Usage:
 *   const { data: phoneNumbers = [], isLoading } = useDialpadPhoneNumbers();
 *
 * @param enabled  Optional flag to conditionally enable the query (e.g. dialog is open).
 *                 Defaults to `true`.
 */
export function useDialpadPhoneNumbers(enabled = true) {
  return useQuery<DialpadPhoneNumber[]>({
    queryKey: ['/api/dialpad/phone-numbers'],
    enabled,
  });
}
