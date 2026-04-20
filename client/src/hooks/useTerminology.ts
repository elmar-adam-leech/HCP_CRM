import { useQuery } from "@tanstack/react-query";
import type { TerminologySettings } from "@shared/schema";

export function useTerminology() {
  return useQuery<TerminologySettings>({
    queryKey: ["/api/terminology"],
    staleTime: Infinity,
  });
}
