import { useEmailThread } from '@/hooks/useEmailThread';
import { MessageHistory } from '@/components/MessageHistory';

export interface EmailHistoryProps {
  contactType?: 'lead' | 'customer' | 'estimate';
  contactId: string;
  contactEmail?: string;
  className?: string;
  emptyStateMessage?: string;
  showHeader?: boolean;
  headerTitle?: string;
  dataTestId?: string;
}

/**
 * Unified email message history component
 * Handles fetching, WebSocket subscriptions, and display of email messages
 * Supports leads, customers, and estimates
 * Can be used in EmailComposerModal, Lead details, Customer details, Messages page, etc.
 */
export function EmailHistory({
  contactType,
  contactId,
  contactEmail,
  className = '',
  emptyStateMessage = 'No email messages yet',
  showHeader = false,
  headerTitle = 'Email History',
  dataTestId = 'email-history',
}: EmailHistoryProps) {
  const { messages, isLoading } = useEmailThread({
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
        filterType="email"
        contactPhone={contactEmail}
        dataTestId={dataTestId}
      />
    </div>
  );
}
