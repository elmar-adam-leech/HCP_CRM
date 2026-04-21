import { memo } from "react";
import { CallButton } from "./CallButton";
import { EmailButton } from "./EmailButton";
import { TextButton } from "./TextButton";
import { QuickNoteButton } from "./QuickNoteButton";

interface CommunicationActionButtonsProps {
  recipientName: string;
  recipientEmail: string;
  recipientPhone: string;
  onSendEmail: () => void;
  leadId?: string;
  estimateId?: string;
  jobId?: string;
  customerId?: string;
  recipientAddress?: string;
  contactId?: string;
  status?: string;
  source?: string;
  notes?: string;
  followUpDate?: string;
  hasUnreadText?: boolean;
  hasUnreadEmail?: boolean;
  onTextSent?: () => void;
  onCallCompleted?: () => void;
  showQuickNote?: boolean;
  forceInAppEmail?: boolean;
  compact?: boolean;
}

export const CommunicationActionButtons = memo(function CommunicationActionButtons({
  recipientName,
  recipientEmail,
  recipientPhone,
  onSendEmail,
  leadId,
  estimateId,
  customerId,
  recipientAddress,
  contactId,
  status,
  source,
  notes,
  followUpDate,
  hasUnreadText,
  hasUnreadEmail,
  onTextSent,
  onCallCompleted,
  showQuickNote = true,
  forceInAppEmail = false,
  compact = false,
}: CommunicationActionButtonsProps) {
  const containerClass = compact
    ? "grid grid-cols-4 gap-2"
    : "grid grid-cols-2 sm:flex sm:flex-wrap gap-2";
  const buttonClass = compact ? "w-full" : "w-full sm:w-auto";
  return (
    <div className={containerClass}>
      <CallButton
        recipientName={recipientName}
        recipientPhone={recipientPhone}
        variant="outline"
        size="sm"
        className={buttonClass}
        leadId={leadId}
        estimateId={estimateId}
        customerId={customerId}
        onCallCompleted={onCallCompleted}
      />
      <EmailButton
        recipientName={recipientName}
        recipientEmail={recipientEmail}
        variant="outline"
        size="sm"
        className={buttonClass}
        onSendEmail={onSendEmail}
        leadId={leadId}
        estimateId={estimateId}
        customerId={customerId}
        hasUnread={hasUnreadEmail}
        forceInAppCompose={forceInAppEmail}
      />
      <TextButton
        recipientName={recipientName}
        recipientPhone={recipientPhone}
        variant="outline"
        size="sm"
        className={buttonClass}
        leadId={leadId}
        estimateId={estimateId}
        recipientEmail={recipientEmail}
        recipientAddress={recipientAddress}
        contactId={contactId}
        status={status}
        source={source}
        notes={notes}
        followUpDate={followUpDate}
        hasUnread={hasUnreadText}
        onSent={onTextSent}
      />
      {showQuickNote && (
        <QuickNoteButton
          leadId={leadId}
          estimateId={estimateId}
          variant="outline"
          size="sm"
          className={buttonClass}
        />
      )}
    </div>
  );
});
