import { useQuery } from "@tanstack/react-query";
import { useWebSocketInvalidation } from "./useWebSocketInvalidation";

export type UnreadSummary = {
  messages: boolean;
  leads: boolean;
  estimates: boolean;
};

export function useUnreadSummary(): UnreadSummary {
  const { data } = useQuery<UnreadSummary>({
    queryKey: ["/api/messages/unread-summary"],
    staleTime: 30_000,
  });

  useWebSocketInvalidation([
    { types: ["new_message", "messages_read"], queryKeys: ["/api/messages/unread-summary"] },
  ]);

  return data ?? { messages: false, leads: false, estimates: false };
}
