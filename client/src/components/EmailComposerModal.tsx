import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { ResponsiveModal } from "@/components/ui/responsive-modal";
import { Button } from "@/components/ui/button";
import { RichTextEditor, richTextIsEmpty } from "@/components/RichTextEditor";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmailHistory } from "@/components/EmailHistory";
import { Mail, Send, X, FileText } from "lucide-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTemplates } from "@/hooks/useTemplates";
import { useToast } from "@/hooks/use-toast";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { applyTemplateSubstitution, plainTextToHtml } from "@/lib/templateSubstitution";
import { useMarkConversationRead } from "@/hooks/useMarkConversationRead";

interface FromAddress {
  email: string;
  label: string;
  type: 'personal' | 'shared';
}

interface EmailComposerModalProps {
  isOpen: boolean;
  onClose: () => void;
  recipientName: string;
  recipientEmail: string;
  recipientPhone?: string;
  recipientAddress?: string;
  companyName?: string;
  contactId?: string;
  leadId?: string;
  customerId?: string;
  estimateId?: string;
  onSent?: () => void;
  /**
   * Optional pre-filled subject. Seeds the subject input on open so callers
   * (e.g. the Sales Process Follow-ups view) can pre-populate from a step
   * template. The user can still edit before sending.
   */
  initialSubject?: string;
  /**
   * Optional pre-filled body content. Seeds the message textarea on open.
   */
  initialContent?: string;
  /**
   * Optional rep-facing guidance ("why this step") shown as a banner above
   * the message field. Sourced from the linked sales-process step. Hidden
   * when empty. Task #729.
   */
  guidance?: string | null;
}

export function EmailComposerModal({
  isOpen,
  onClose,
  recipientName,
  recipientEmail,
  recipientPhone,
  recipientAddress,
  companyName = "Our Company",
  contactId,
  leadId,
  customerId,
  estimateId,
  onSent,
  initialSubject,
  initialContent,
  guidance,
}: EmailComposerModalProps) {
  const [, navigate] = useLocation();
  const [subject, setSubject] = useState(initialSubject ?? "");
  const [content, setContent] = useState(initialContent ? plainTextToHtml(initialContent) : "");
  const [selectedTemplate, setSelectedTemplate] = useState<string>("");
  const [selectedFromAddress, setSelectedFromAddress] = useState<string>("");
  const { toast } = useToast();

  // When the modal opens (or initial values change while open), seed the
  // subject/content fields. We only seed if the field is currently empty so
  // an in-progress edit isn't clobbered by a parent re-render.
  useEffect(() => {
    if (!isOpen) return;
    if (initialSubject && !subject) setSubject(initialSubject);
    if (initialContent && richTextIsEmpty(content)) setContent(plainTextToHtml(initialContent));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, initialSubject, initialContent]);

  const { data: currentUser } = useCurrentUser();

  const { data: fromAddresses = [] } = useQuery<FromAddress[]>({
    queryKey: ['/api/messages/from-addresses'],
    enabled: isOpen,
  });

  const derivedContactId = contactId || leadId || customerId || estimateId || null;

  useMarkConversationRead(derivedContactId ?? undefined, isOpen, 'email');
  const contactType: 'lead' | 'customer' | 'estimate' | undefined =
    contactId ? undefined : (leadId ? 'lead' : customerId ? 'customer' : estimateId ? 'estimate' : undefined);

  // Shared templates hook — uses the global queryFn (credentials: 'include')
  // and shares the cache with the Templates page to avoid duplicate network requests.
  const { data: templates = [] } = useTemplates('email', isOpen);

  const sendEmailMutation = useMutation({
    mutationFn: async (data: {
      to: string;
      subject: string;
      content: string;
      contactId?: string;
      leadId?: string;
      customerId?: string;
      estimateId?: string;
      fromAddress?: string;
    }) => {
      return apiRequest('POST', '/api/messages/send-email', data);
    },
    onSuccess: () => {
      toast({
        title: "Email sent",
        description: "Your email has been sent successfully",
      });
      
      setSubject("");
      setContent("");
      setSelectedTemplate("");
      setSelectedFromAddress("");
      
      queryClient.invalidateQueries({ queryKey: ['/api/activities'] });
      queryClient.invalidateQueries({ queryKey: ['/api/conversations'] });
      queryClient.invalidateQueries({ queryKey: ['/api/contacts/paginated'] });
      
      onSent?.();
    },
    onError: (error: any) => {
      toast({
        title: "Failed to send email",
        description: error.message || "There was an error sending your email",
        variant: "destructive",
      });
    },
  });

  const handleSendEmail = async () => {
    if (!subject.trim()) {
      toast({
        title: "Subject required",
        description: "Please enter an email subject",
        variant: "destructive",
      });
      return;
    }

    if (richTextIsEmpty(content)) {
      toast({
        title: "Content required",
        description: "Please enter email content",
        variant: "destructive",
      });
      return;
    }

    if (!recipientEmail) {
      toast({
        title: "Email address required",
        description: "Recipient email address is required",
        variant: "destructive",
      });
      return;
    }

    if (fromAddresses.length === 0) {
      toast({
        title: "No email account available",
        description: "Please connect your Gmail account or ask an admin to set up a shared company email in Settings",
        variant: "destructive",
      });
      return;
    }

    const resolvedFrom = selectedFromAddress || fromAddresses[0]?.email;
    sendEmailMutation.mutate({
      to: recipientEmail,
      subject: subject.trim(),
      content: content,
      contactId: derivedContactId || undefined,
      leadId,
      customerId,
      estimateId,
      fromAddress: resolvedFrom,
    });
  };

  const handleClose = () => {
    setSubject("");
    setContent("");
    setSelectedTemplate("");
    setSelectedFromAddress("");
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
        contactEmail: recipientEmail,
        contactPhone: recipientPhone ?? "",
        contactAddress: recipientAddress ?? "",
        contactId: contactId ?? "",
      });
      setContent(plainTextToHtml(substitutedContent));
      
      // Prefer template.subject (with substitution), fall back to template.title
      const templateSubject = template.subject
        ? applyTemplateSubstitution(template.subject, {
            customerName: recipientName,
            companyName: companyName,
            contactEmail: recipientEmail,
            contactPhone: recipientPhone ?? "",
            contactAddress: recipientAddress ?? "",
            contactId: contactId ?? "",
          })
        : template.title;
      if (!subject) {
        setSubject(templateSubject);
      }
    }
  };

  const showGmailWarning = fromAddresses.length === 0 && !currentUser?.user?.gmailConnected;

  return (
    <ResponsiveModal
      open={isOpen}
      onOpenChange={(open) => { if (!open) handleClose(); }}
      dataTestId="modal-email-composer"
      ariaDescribedBy="email-composer-modal-description"
      desktopContentClassName="w-full max-w-[600px] h-[85vh]"
      titleClassName="flex items-center gap-2"
      titleTestId="email-modal-title"
      title={<><Mail className="h-5 w-5" />Email to {recipientName}</>}
    >
        <div className="flex-1 flex flex-col min-h-0 p-4 sm:p-6 gap-4">
          {/* Gmail Connection Warning */}
          {showGmailWarning && (
            <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-md p-3 shrink-0">
              <p className="text-sm text-yellow-800 dark:text-yellow-200">
                Gmail is not connected. Please connect your Gmail account in{' '}
                <button
                  onClick={() => {
                    handleClose();
                    navigate('/settings?tab=integrations');
                  }}
                  className="underline font-medium hover:text-yellow-900 dark:hover:text-yellow-100"
                >
                  Settings
                </button>
                {' '}to send emails.
              </p>
            </div>
          )}

          {/* From Address Selector */}
          {fromAddresses.length > 1 ? (
            <div className="grid gap-2 shrink-0">
              <Label htmlFor="from-address">From</Label>
              <Select
                value={selectedFromAddress || fromAddresses[0]?.email || ''}
                onValueChange={setSelectedFromAddress}
              >
                <SelectTrigger data-testid="select-from-address">
                  <SelectValue placeholder="Select sender..." />
                </SelectTrigger>
                <SelectContent>
                  {fromAddresses.map((addr) => (
                    <SelectItem key={addr.email} value={addr.email}>
                      {addr.label} ({addr.email})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : fromAddresses.length === 1 ? (
            <div className="grid gap-2 shrink-0">
              <Label>From</Label>
              <Input
                value={`${fromAddresses[0].label} (${fromAddresses[0].email})`}
                disabled
                className="bg-muted"
                data-testid="input-from-address"
              />
            </div>
          ) : null}

          {/* Recipient Email */}
          <div className="grid gap-2 shrink-0">
            <Label htmlFor="recipient-email">To</Label>
            <Input
              id="recipient-email"
              type="email"
              value={recipientEmail}
              disabled
              className="bg-muted"
              data-testid="input-recipient-email"
            />
          </div>

          {/* Email History */}
          {derivedContactId && (
            <EmailHistory
              contactType={contactType}
              contactId={derivedContactId}
              contactEmail={recipientEmail}
              className="flex-1 min-h-0"
              emptyStateMessage="No email messages yet"
              dataTestId="email-message-history"
            />
          )}

          {/* Template Selection */}
          {templates.length > 0 && (
            <div className="grid gap-2 shrink-0">
              <Label htmlFor="template-select">Use Template</Label>
              <Select value={selectedTemplate} onValueChange={handleTemplateSelect}>
                <SelectTrigger data-testid="select-email-template">
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
              data-testid="email-composer-guidance"
            >
              <div className="font-medium uppercase tracking-wide mb-1">Why this step</div>
              {guidance}
            </div>
          )}

          {/* Subject Field */}
          <div className="grid gap-2 shrink-0">
            <Label htmlFor="email-subject">Subject</Label>
            <Input
              id="email-subject"
              type="text"
              placeholder="Enter email subject..."
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              data-testid="input-email-subject"
            />
          </div>

          {/* Message Content */}
          <div className="grid gap-2 shrink-0">
            <Label htmlFor="email-content">Message</Label>
            <RichTextEditor
              value={content}
              onChange={setContent}
              placeholder="Type your message here..."
              ariaLabel="Email message"
              dataTestId="textarea-email-content"
            />
            {selectedTemplate && (
              <div className="text-xs text-muted-foreground">
                Variables like {"{{"}contact.name{"}}"} are automatically replaced with real values when sent.
              </div>
            )}
          </div>

          {/* Action Buttons */}
          <div className="flex flex-wrap justify-end gap-2 shrink-0 pt-2 border-t">
            <Button 
              variant="outline" 
              size="sm"
              className="w-full sm:w-auto"
              onClick={handleClose} 
              data-testid="button-cancel-email"
            >
              Cancel
            </Button>
            <Button
              size="sm"
              className="w-full sm:w-auto"
              onClick={handleSendEmail}
              disabled={!subject.trim() || richTextIsEmpty(content) || sendEmailMutation.isPending || showGmailWarning}
              data-testid="button-send-email"
            >
              {sendEmailMutation.isPending ? (
                <>Sending...</>
              ) : (
                <>
                  <Send className="h-4 w-4 mr-2 shrink-0" />
                  Send Email
                </>
              )}
            </Button>
          </div>
        </div>
    </ResponsiveModal>
  );
}
