import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";

export interface AvailableFromNumber {
  id: string;
  phoneNumber: string;
  displayName?: string | null;
}

/**
 * Shared hook for the provider-agnostic "From Number" picker source.
 *
 * Fetches `/api/messages/available-from-numbers`, which merges the available
 * phone numbers from every ENABLED communication provider (Dialpad, Twilio,
 * ...) for the contractor. Uses the same queryKey shape as
 * PhoneNumberSelector so cache entries are shared across the app.
 *
 * @param action   Which capability the numbers must support ('sms' | 'call').
 * @param enabled  Optional flag to conditionally enable the query (e.g. dialog is open).
 */
export function useAvailableFromNumbers(action: "sms" | "call" = "sms", enabled = true) {
  return useQuery<AvailableFromNumber[]>({
    queryKey: ["/api/messages/available-from-numbers", action],
    // apiRequest (not raw fetch) so the request keeps the app's bearer-token
    // fallback + silent-refresh behavior in cookie-evicted PWA sessions.
    queryFn: async () => {
      const response = await apiRequest("GET", `/api/messages/available-from-numbers?action=${action}`);
      return response.json();
    },
    enabled,
  });
}
