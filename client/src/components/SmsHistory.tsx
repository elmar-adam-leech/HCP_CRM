import { useSmsThread } from '@/hooks/useSmsThread';
import { MessageHistory } from '@/components/MessageHistory';

export interface SmsHistoryProps {
  contactType?: 'lead' | 'customer' | 'estimate';
  contactId: string;
  contactPhone?: string;
  className?: string;
  emptyStateMessage?: string;
  showHeader?: boolean;
  headerTitle?: string;
  dataTestId?: string;
}

/**
 * Unified SMS message history component
 * Handles fetching, WebSocket subscriptions, and display of SMS messages
 * Supports leads, customers, and estimates
 * Can be used in ConversationModal, TextingModal, Lead details, Customer details, etc.
 */
export function SmsHistory({
  contactType,
  contactId,
  contactPhone,
  className = '',
  emptyStateMessage = 'No messages yet',
  showHeader = false,
  headerTitle = 'Message History',
  dataTestId = 'sms-history',
}: SmsHistoryProps) {
  const { messages, isLoading } = useSmsThread({
    contactType,
    contactId,
    enabled: !!contactId,
  });

  return (
    <div className={className}>
      {showHeader && (
        <div className="mb-2">
          <h3 className="text-sm font-medium">{headerTitle}</h3>
        </div>
      )}
      <MessageHistory
        messages={messages}
        isLoading={isLoading}
        emptyStateMessage={emptyStateMessage}
        filterType="text"
        contactPhone={contactPhone}
        dataTestId={dataTestId}
      />
    </div>
  );
}
