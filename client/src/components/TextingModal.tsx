import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { ResponsiveModal } from "@/components/ui/responsive-modal";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PhoneNumberSelector } from "@/components/PhoneNumberSelector";
import { SmsHistory } from "@/components/SmsHistory";
import { MessageSquare, Send, X, FileText } from "lucide-react";
import { useTemplates } from "@/hooks/useTemplates";
import { useToast } from "@/hooks/use-toast";
import { useSendSms, formatForDialpad } from "@/hooks/useSendSms";
import { useProviderStatus } from "@/hooks/use-provider-config";
import { useMarkConversationRead } from "@/hooks/useMarkConversationRead";
import { ProviderIntegrationPrompt } from "./ProviderIntegrationPrompt";
import { applyTemplateSubstitution } from "@/lib/templateSubstitution";
import { formatPhoneNumber } from "@/lib/utils";

interface TextingModalProps {
  isOpen: boolean;
  onClose: () => void;
  recipientName: string;
  recipientPhone: string;
  recipientEmail?: string;
  companyName?: string;
  contactId?: string;
  leadId?: string;
  customerId?: string;
  estimateId?: string;
  onSent?: () => void;
  /**
   * Optional pre-filled message body. When supplied, the textarea is
   * seeded on open so the user can edit before sending. Used by the
   * Sales Process Follow-ups view to pre-populate the step's templated
   * SMS for provider-backed sending.
   */
  initialMessage?: string;
  /**
   * Optional rep-facing guidance ("why this step") shown as a banner above
   * the textarea. Sourced from the linked sales-process step. Hidden when
   * empty. Task #729.
   */
  guidance?: string | null;
}

export function TextingModal({
  isOpen,
  onClose,
  recipientName,
  recipientPhone,
  recipientEmail: _recipientEmail,
  companyName = "Our Company",
  contactId,
  leadId,
  customerId,
  estimateId,
  onSent,
  initialMessage,
  guidance,
}: TextingModalProps) {
  const [, navigate] = useLocation();
  const [message, setMessage] = useState(initialMessage ?? "");
  const [selectedTemplate, setSelectedTemplate] = useState<string>("");
  const [selectedFromNumber, setSelectedFromNumber] = useState<string>("");
  const { toast } = useToast();
  const providerStatus = useProviderStatus();
  const { sendSmsAsync, isLoading: isSendingSms } = useSendSms();

  const derivedContactId = contactId || leadId || customerId || estimateId || null;

  useMarkConversationRead(derivedContactId ?? undefined, isOpen, 'text');
  const contactType: 'lead' | 'customer' | 'estimate' | undefined =
    contactId ? undefined : (leadId ? 'lead' : customerId ? 'customer' : estimateId ? 'estimate' : undefined);

  // Shared templates hook — uses the global queryFn (credentials: 'include')
  // and shares the cache with the Templates page to avoid duplicate network requests.
  const { data: templates = [] } = useTemplates('text', isOpen);

  // Reset selected number when modal closes so PhoneNumberSelector
  // can re-apply the correct default (org default → user default → first available)
  // on the next open. Do NOT pre-set from the user's personal dialpadDefaultNumber
  // here — that bypassed the org-default fallback chain in PhoneNumberSelector.
  useEffect(() => {
    if (!isOpen) {
      setSelectedFromNumber("");
    }
  }, [isOpen]);

  // Seed the textarea on open from initialMessage. We only seed when the
  // textarea is currently empty so we don't clobber an in-progress edit
  // if the parent re-renders.
  useEffect(() => {
    if (isOpen && initialMessage && !message) {
      setMessage(initialMessage);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, initialMessage]);

  const handleSendMessage = async () => {
    if (!message.trim()) {
      toast({
        title: "Message required",
        description: "Please enter a message to send",
        variant: "destructive",
      });
      return;
    }

    if (!recipientPhone) {
      toast({
        title: "Phone number required",
        description: "Recipient phone number is required for text messages",
        variant: "destructive",
      });
      return;
    }

    if (!selectedFromNumber) {
      toast({
        title: "From number required",
        description: "Please select a phone number to send from",
        variant: "destructive",
      });
      return;
    }

    const formattedTo = formatForDialpad(recipientPhone);
    const formattedFrom = formatForDialpad(selectedFromNumber);

    if (!formattedTo || !formattedFrom) {
      toast({
        title: "Invalid phone number",
        description: "Please ensure both sender and recipient phone numbers are valid (e.g., 10-digit US number or +1 followed by 10 digits)",
        variant: "destructive",
      });
      return;
    }

    try {
      const result = await sendSmsAsync({
        content: message.trim(),
        toNumber: recipientPhone,
        fromNumber: selectedFromNumber,
        contactId: derivedContactId || undefined,
        leadId,
        customerId,
        estimateId,
      });
      
      if (result.success) {
        setMessage("");
        setSelectedTemplate("");
        setSelectedFromNumber("");
        if (onSent) {
          onSent();
        }
      }
    } catch (error) {
      // Error is already handled by the hook
    }
  };

  const handleClose = () => {
    setMessage("");
    setSelectedTemplate("");
    setSelectedFromNumber("");
    onClose();
  };

  // Handle template selection
  const handleTemplateSelect = (templateId: string) => {
    if (!templateId || templateId === "__none__") {
      setSelectedTemplate("");
      return;
    }
    const template = templates.find(t => t.id === templateId);
    if (template) {
      setSelectedTemplate(templateId);
      const substitutedContent = applyTemplateSubstitution(template.content, {
        customerName: recipientName,
        companyName: companyName,
        contactId: derivedContactId || undefined,
      });
      setMessage(substitutedContent);
    }
  };

  return (
    <ResponsiveModal
      open={isOpen}
      onOpenChange={(open) => { if (!open) handleClose(); }}
      dataTestId="modal-texting"
      ariaDescribedBy="texting-modal-description"
      desktopContentClassName="w-full max-w-[600px] h-[85vh] max-h-[85vh]"
      titleClassName="flex items-center gap-2"
      titleTestId="text-modal-title"
      title={<><MessageSquare className="h-5 w-5" />Message {recipientName}</>}
    >
        <div className="flex-1 flex flex-col min-h-0 p-4 sm:p-6 gap-4">
          {/* Provider Configuration Check */}
          {(() => {
            if (providerStatus.isLoading) {
              return <div className="text-center py-8">Loading provider status...</div>;
            }

            if (!providerStatus.sms.isConfigured) {
              return (
                <ProviderIntegrationPrompt
                  type="sms"
                  availableProviders={providerStatus.sms.availableProviders || []}
                  onSetupClick={() => {
                    // Close the modal first
                    onClose();
                    // Navigate to Settings page Communication section
                    navigate('/settings?tab=integrations');
                  }}
                />
              );
            }

            return (
              <>
          {/* Phone Number Info */}
          <PhoneNumberSelector
            value={selectedFromNumber}
            onValueChange={setSelectedFromNumber}
            dataTestId="select-from-number"
          />
          <div className="grid gap-2">
            <Label htmlFor="recipient-phone">To Number</Label>
            <Input
              id="recipient-phone"
              value={formatPhoneNumber(recipientPhone)}
              disabled
              data-testid="input-recipient-phone"
            />
          </div>
          {/* Message History */}
          {derivedContactId && (
            <SmsHistory
              contactType={contactType}
              contactId={derivedContactId}
              className="max-h-[28vh] overflow-y-auto sm:flex-1 sm:max-h-none sm:min-h-0"
              emptyStateMessage="No messages yet"
              dataTestId="text-message-history"
            />
          )}
          {/* Template Selection */}
          {templates.length > 0 && (
            <div className="grid gap-2">
              <Label htmlFor="template-select">Use Template</Label>
              <Select value={selectedTemplate} onValueChange={handleTemplateSelect}>
                <SelectTrigger data-testid="select-message-template">
                  <SelectValue placeholder="Choose a template..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__" data-testid="select-no-template">
                    <div className="flex items-center gap-2">
                      <X className="h-4 w-4" />
                      No template
                    </div>
                  </SelectItem>
                  {templates.map((template) => (
                    <SelectItem
                      key={template.id}
                      value={template.id}
                      data-testid={`select-template-${template.id}`}
                    >
                      <div className="flex items-center gap-2">
                        <FileText className="h-4 w-4" />
                        {template.title}
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {/* Step guidance banner (task #729) */}
          {guidance && guidance.trim() && (
            <div
              className="rounded-md border bg-muted/40 p-2 text-xs text-muted-foreground whitespace-pre-wrap"
              data-testid="texting-modal-guidance"
            >
              <div className="font-medium uppercase tracking-wide mb-1">Why this step</div>
              {guidance}
            </div>
          )}
          {/* New Message */}
          <div className="grid gap-2 shrink-0">
            <Label htmlFor="new-message">Message</Label>
            <Textarea
              id="new-message"
              placeholder="Type your message here..."
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              className="min-h-[100px] max-h-[120px] resize-none"
              data-testid="textarea-new-message"
            />
            {selectedTemplate && (
              <div className="text-xs text-muted-foreground">
                Variables like {"{{"}contact.name{"}}"} and {"{{"}booking_link{"}}"} are automatically replaced with real values when sent.
              </div>
            )}
          </div>
          <div className="flex flex-wrap justify-end gap-2 shrink-0 pt-2 border-t">
            <Button 
              variant="outline" 
              size="sm"
              className="w-full sm:w-auto"
              onClick={handleClose} 
              data-testid="button-cancel"
            >
              Cancel
            </Button>
            <Button
              size="sm"
              className="w-full sm:w-auto"
              onClick={handleSendMessage}
              disabled={!message.trim() || isSendingSms}
              data-testid="button-send-text"
            >
              {isSendingSms ? (
                <>Sending...</>
              ) : (
                <>
                  <Send className="h-4 w-4 mr-2 shrink-0" />
                  Send Text
                </>
              )}
            </Button>
          </div>
              </>
            );
          })()}
        </div>
    </ResponsiveModal>
  );
}