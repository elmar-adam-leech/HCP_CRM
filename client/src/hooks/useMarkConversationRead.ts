import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";

export function useMarkConversationRead(
  contactId: string | undefined,
  isOpen: boolean,
  messageType?: 'text' | 'email'
): void {
  const queryClient = useQueryClient();
  const markedReadRef = useRef<string | null>(null);

  useEffect(() => {
    if (!isOpen) {
      markedReadRef.current = null;
    }
  }, [isOpen]);

  useEffect(() => {
    const cacheKey = messageType ? `${contactId}:${messageType}` : contactId ?? null;
    if (isOpen && contactId && markedReadRef.current !== cacheKey) {
      markedReadRef.current = cacheKey;
      const body = messageType ? { type: messageType } : undefined;
      apiRequest('POST', `/api/conversations/${contactId}/read`, body)
        .then(() => {
          queryClient.invalidateQueries({ queryKey: ['/api/conversations'] });
          queryClient.invalidateQueries({ queryKey: ['/api/messages/unread-count'] });
          queryClient.invalidateQueries({ queryKey: ['/api/messages/unread-counts'] });
        })
        .catch(() => {
          markedReadRef.current = null;
        });
    }
  }, [isOpen, contactId, messageType, queryClient]);
}
