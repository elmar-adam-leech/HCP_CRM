/**
 * @deprecated Use `useConversationThread` from `@/hooks/useConversationThread` instead.
 * This re-export is kept for backward compatibility with existing call sites.
 */
export type { ConversationThreadParams as SmsThreadParams, ConversationThreadResult as SmsThreadResult } from './useConversationThread';
export { useConversationThread as useSmsThread } from './useConversationThread';
