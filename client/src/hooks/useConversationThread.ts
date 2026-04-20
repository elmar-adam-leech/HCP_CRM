/**
 * useConversationThread — unified hook for fetching and subscribing to a contact's
 * message thread (either SMS or email).
 *
 * This replaces the former useEmailThread and useSmsThread hooks which were nearly
 * identical. Both old hooks are kept as thin re-exports for backward compatibility.
 *
 * WebSocket events handled:
 *   - `new_message`      — a new outbound or inbound message was created for this contact
 *   - `message_update`   — an existing message's status changed (e.g. delivered → failed)
 *   - `message_updated`  — legacy alias for the same event used by some server paths
 *
 * When any of the above events arrive and the `contactId` and `contactType` match the
 * current thread, the React Query cache is invalidated so the list re-fetches automatically.
 *
 * @param contactType - The entity type the contact belongs to ('lead' | 'customer' | 'estimate').
 *                      Optional for SMS; required for email (to select the right endpoint).
 * @param contactId   - The contact's UUID.
 * @param enabled     - Set to false to skip the query and WebSocket subscription.
 */
import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useWebSocketContext } from '@/contexts/WebSocketContext';
import type { Message } from '@shared/schema';

export interface ConversationThreadParams {
  contactType?: 'lead' | 'customer' | 'estimate';
  contactId: string;
  enabled?: boolean;
}

export interface ConversationThreadResult {
  messages: Message[];
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
}

export function useConversationThread({
  contactType,
  contactId,
  enabled = true,
}: ConversationThreadParams): ConversationThreadResult {
  const queryClient = useQueryClient();
  const { subscribe } = useWebSocketContext();

  const endpoint = contactType
    ? `/api/conversations/${contactId}/${contactType}`
    : `/api/conversations/${contactId}`;

  const queryKey = contactType
    ? ['/api/conversations', contactId, contactType]
    : ['/api/conversations', contactId];

  const { data: messages = [], isLoading, error, refetch } = useQuery<Message[]>({
    queryKey,
    queryFn: async () => {
      const response = await fetch(endpoint, { credentials: 'include' });
      if (!response.ok) throw new Error('Failed to fetch messages');
      return response.json();
    },
    enabled: enabled && !!contactId,
  });

  useEffect(() => {
    if (!enabled || !contactId) return;

    const unsubscribe = subscribe((message) => {
      if (
        message.type === 'new_message' ||
        message.type === 'message_update' ||
        message.type === 'message_updated'
      ) {
        const matchesContact = message.contactId === contactId;
        const matchesType = !contactType || message.contactType === contactType;

        if (matchesContact && matchesType) {
          queryClient.invalidateQueries({ queryKey });
        }
      }
    });

    return unsubscribe;
  }, [subscribe, contactId, contactType, enabled, queryClient]);

  return {
    messages,
    isLoading,
    error: error as Error | null,
    refetch,
  };
}
