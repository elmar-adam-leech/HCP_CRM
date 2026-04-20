/**
 * @deprecated Use `useConversationThread` from `@/hooks/useConversationThread` instead.
 * This re-export is kept for backward compatibility with existing call sites.
 */
export type { ConversationThreadParams as EmailThreadParams, ConversationThreadResult as EmailThreadResult } from './useConversationThread';
export { useConversationThread as useEmailThread } from './useConversationThread';
