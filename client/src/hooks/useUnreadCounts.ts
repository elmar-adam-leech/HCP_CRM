import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useWebSocketInvalidation } from "./useWebSocketInvalidation";

type UnreadCounts = Record<string, { text: number; email: number }>;

export function useUnreadCountsByContacts(contactIds: string[]): UnreadCounts {
  const deduped = [...new Set(contactIds.filter(Boolean))];

  const { data } = useQuery<UnreadCounts>({
    queryKey: ["/api/messages/unread-counts", ...deduped.slice().sort()],
    queryFn: async () => {
      if (deduped.length === 0) return {};
      const res = await apiRequest("POST", "/api/messages/unread-counts", { contactIds: deduped });
      return res.json();
    },
    enabled: deduped.length > 0,
    staleTime: 30_000,
  });

  useWebSocketInvalidation([
    { types: ["new_message", "messages_read"], queryKeys: ["/api/messages/unread-counts"] },
  ]);

  return data ?? {};
}
