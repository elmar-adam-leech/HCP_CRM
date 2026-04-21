import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { MessageSquare, FileText, X } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useQueryClient } from "@tanstack/react-query";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useProviderStatus } from "@/hooks/use-provider-config";
import { useTemplates } from "@/hooks/useTemplates";
import { TextingModal } from "./TextingModal";
import { applyTemplateSubstitution } from "@/lib/templateSubstitution";

interface TextButtonProps {
  recipientName: string;
  recipientPhone: string;
  variant?: "default" | "outline" | "ghost" | "destructive" | "secondary";
  size?: "default" | "sm" | "lg" | "icon";
  className?: string;
  children?: React.ReactNode;
  leadId?: string;
  customerId?: string;
  estimateId?: string;
  recipientEmail?: string;
  recipientAddress?: string;
  contactId?: string;
  status?: string;
  source?: string;
  notes?: string;
  followUpDate?: string;
  hasUnread?: boolean;
  onSent?: () => void;
  /**
   * Optional pre-filled message body. When set, opening the personal SMS
   * modal seeds messageBody with this text so the user can edit before
   * sending. Used by the Sales Process Follow-ups view to pre-fill the
   * step's templated message.
   */
  initialMessage?: string;
}

export function TextButton({
  recipientName,
  recipientPhone,
  variant = "outline",
  size = "default",
  className = "",
  children,
  leadId,
  customerId,
  estimateId,
  recipientEmail,
  recipientAddress,
  contactId,
  status,
  source,
  notes,
  followUpDate,
  hasUnread,
  onSent,
  initialMessage,
}: TextButtonProps) {
  const { data: currentUser } = useCurrentUser();
  const { sms } = useProviderStatus();
  const queryClient = useQueryClient();
  const [showPersonalModal, setShowPersonalModal] = useState(false);
  const [showTextingModal, setShowTextingModal] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState<string>("");
  const [messageBody, setMessageBody] = useState<string>("");

  const { data: templates = [] } = useTemplates("text", showPersonalModal);

  const entityType = leadId ? "lead" : customerId ? "customer" : estimateId ? "estimate" : "contact";
  const entityId = leadId || customerId || estimateId || "";

  if (!recipientPhone) {
    return null;
  }

  const usePersonal = sms.isLoading ? null : (!sms.isConfigured || currentUser?.user?.callPreference === "personal");

  const handleClick = () => {
    if (usePersonal === null) return;
    if (initialMessage) {
      setMessageBody(initialMessage);
    }
    if (usePersonal) {
      setShowPersonalModal(true);
    } else {
      setShowTextingModal(true);
    }
  };

  // Keep messageBody in sync if the consumer changes initialMessage while
  // the personal modal is open (e.g. selecting a different task row).
  useEffect(() => {
    if (showPersonalModal && initialMessage && !messageBody) {
      setMessageBody(initialMessage);
    }
  }, [showPersonalModal, initialMessage, messageBody]);

  const handleTemplateSelect = (templateId: string) => {
    if (!templateId || templateId === "__none__") {
      setSelectedTemplate("");
      setMessageBody("");
      return;
    }
    const template = templates.find((t) => t.id === templateId);
    if (template) {
      setSelectedTemplate(templateId);
      const companyName = currentUser?.user?.contractorName || "Our Company";
      const substituted = applyTemplateSubstitution(template.content, {
        customerName: recipientName,
        companyName,
        contactEmail: recipientEmail,
        contactPhone: recipientPhone,
        contactAddress: recipientAddress,
        contactId,
        status,
        source,
        notes,
        followUpDate,
      });
      setMessageBody(substituted);
    }
  };

  const logPersonalSms = (phone: string, body?: string) => {
    const contactId = leadId || customerId || (estimateId ? undefined : entityId) || undefined;
    const estId = estimateId || undefined;
    fetch("/api/messages/log-personal-sms", {
      method: "POST",
      keepalive: true,
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contactId, estimateId: estId, phone, name: recipientName, body }),
    }).catch((err) => {
      console.error("[TextButton] Failed to log personal SMS:", err);
    });
  };

  const handleOpenSms = () => {
    const url = messageBody
      ? `sms:${recipientPhone}?body=${encodeURIComponent(messageBody)}`
      : `sms:${recipientPhone}`;
    window.open(url, "_self");
    logPersonalSms(recipientPhone, messageBody || undefined);
    queryClient.invalidateQueries({ queryKey: ['/api/contacts/paginated'] });
    setShowPersonalModal(false);
    setSelectedTemplate("");
    setMessageBody("");
  };

  const handleSkip = () => {
    window.open(`sms:${recipientPhone}`, "_self");
    logPersonalSms(recipientPhone);
    queryClient.invalidateQueries({ queryKey: ['/api/contacts/paginated'] });
    setShowPersonalModal(false);
    setSelectedTemplate("");
    setMessageBody("");
  };

  const handlePersonalModalClose = (open: boolean) => {
    if (!open) {
      setShowPersonalModal(false);
      setSelectedTemplate("");
      setMessageBody("");
    }
  };

  return (
    <>
      <div className={`relative inline-flex ${className}`}>
        <Button
          variant={variant}
          size={size}
          className="w-full"
          onClick={handleClick}
          data-testid={`button-text-${entityType}-${entityId}`}
        >
          {children || (
            <>
              <MessageSquare className="h-3 w-3 mr-1 shrink-0" />
              Text
            </>
          )}
        </Button>
        {hasUnread && (
          <span className="absolute -top-1 -right-1 flex h-2.5 w-2.5" data-testid={`unread-dot-text-${entityId}`}>
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-red-500" />
          </span>
        )}
      </div>

      {/* Personal SMS modal with template picker */}
      <Dialog open={showPersonalModal} onOpenChange={handlePersonalModalClose}>
        <DialogContent
          className="sm:max-w-md"
          data-testid="modal-personal-sms"
          aria-describedby="personal-sms-description"
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <MessageSquare className="h-5 w-5" />
              Text {recipientName}
            </DialogTitle>
          </DialogHeader>
          <p id="personal-sms-description" className="text-sm text-muted-foreground">
            Choose a template to pre-fill your message, then open your SMS app.
          </p>
          <div className="grid gap-4">
            {templates.length > 0 && (
              <div className="grid gap-2">
                <Label htmlFor="personal-sms-template">Template (optional)</Label>
                <Select value={selectedTemplate} onValueChange={handleTemplateSelect}>
                  <SelectTrigger id="personal-sms-template" data-testid="select-personal-sms-template">
                    <SelectValue placeholder="Choose a template..." />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__" data-testid="select-no-template-personal">
                      <div className="flex items-center gap-2">
                        <X className="h-4 w-4" />
                        No template
                      </div>
                    </SelectItem>
                    {templates.map((template) => (
                      <SelectItem
                        key={template.id}
                        value={template.id}
                        data-testid={`select-personal-template-${template.id}`}
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
            {messageBody ? (
              <div className="grid gap-2">
                <Label>Message Preview</Label>
                <Textarea
                  value={messageBody}
                  readOnly
                  className="min-h-[80px] max-h-[160px] resize-none bg-muted/40"
                  data-testid="textarea-personal-sms-preview"
                />
              </div>
            ) : null}
            <div className="flex flex-wrap justify-end gap-2 pt-2 border-t">
              <Button
                variant="outline"
                size="sm"
                onClick={handleSkip}
                data-testid="button-personal-sms-skip"
              >
                Skip — Open SMS App
              </Button>
              <Button
                size="sm"
                onClick={handleOpenSms}
                data-testid="button-personal-sms-open"
              >
                <MessageSquare className="h-4 w-4 mr-2" />
                {messageBody ? "Open SMS App with Message" : "Open SMS App"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Integration path: TextingModal */}
      <TextingModal
        isOpen={showTextingModal}
        onClose={() => setShowTextingModal(false)}
        recipientName={recipientName}
        recipientPhone={recipientPhone}
        contactId={contactId}
        leadId={leadId}
        customerId={customerId}
        estimateId={estimateId}
        onSent={onSent}
        initialMessage={initialMessage}
      />
    </>
  );
}
