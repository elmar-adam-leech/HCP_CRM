import { useState, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSmsThread } from "@/hooks/useSmsThread";
import { useMarkConversationRead } from "@/hooks/useMarkConversationRead";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RichTextEditor, richTextIsEmpty } from "@/components/RichTextEditor";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PhoneNumberSelector } from "@/components/PhoneNumberSelector";
import { MessageHistory } from "@/components/MessageHistory";
import { useToast } from "@/hooks/use-toast";
import { useSendSms } from "@/hooks/useSendSms";
import {
  Mail,
  MessageSquare,
  Phone,
  User,
  Send,
  AlertTriangle
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import type { Message } from "@shared/schema";

interface FromAddress {
  email: string;
  label: string;
  type: 'personal' | 'shared';
}

interface Conversation {
  contactId: string;
  contactName: string;
  contactPhone?: string;
  contactEmail?: string;
  lastMessage: Message;
  unreadCount: number;
  totalMessages: number;
}

interface ConversationModalProps {
  isOpen: boolean;
  onClose: () => void;
  conversation: Conversation | null;
}

export function ConversationModal({ isOpen, onClose, conversation }: ConversationModalProps) {
  const [messageTypeFilter, setMessageTypeFilter] = useState<"text" | "email">("text");
  const [smsText, setSmsText] = useState("");
  const [emailSubject, setEmailSubject] = useState("");
  const [emailBody, setEmailBody] = useState("");
  const [selectedFromNumber, setSelectedFromNumber] = useState<string>("");
  const [selectedFromEmail, setSelectedFromEmail] = useState<string>("");
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { sendSms, isLoading: isSendingSms } = useSendSms();
  const { data: currentUser } = useCurrentUser();

  const { data: fromAddresses = [] } = useQuery<FromAddress[]>({
    queryKey: ['/api/messages/from-addresses'],
    enabled: !!conversation && isOpen,
  });

  const showGmailWarning = fromAddresses.length === 0 && !currentUser?.user?.gmailConnected;

  // Use the unified SMS thread hook (handles fetching + WebSocket)
  // contactType is no longer required with the unified contacts API
  const { messages: conversationMessages, isLoading: messagesLoading } = useSmsThread({
    contactId: conversation?.contactId || '',
    enabled: !!conversation && isOpen,
  });

  useMarkConversationRead(conversation?.contactId, isOpen);

  useEffect(() => {
    if (!isOpen) {
      setSelectedFromNumber("");
    }
  }, [isOpen]);

  const sendEmailMutation = useMutation({
    mutationFn: async ({ subject, body }: { subject: string; body: string }) => {
      const resolvedFrom = selectedFromEmail || fromAddresses[0]?.email;
      const response = await fetch('/api/messages/send-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          subject,
          content: body,
          to: conversation?.contactEmail,
          contactId: conversation?.contactId,
          fromAddress: resolvedFrom,
        }),
      });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.message || 'Failed to send email');
      }
      return response.json();
    },
    onSuccess: () => {
      toast({ title: "Email sent successfully" });
      setEmailSubject("");
      setEmailBody("");
      // Refresh this contact's message thread and the main conversations list
      // so the "last message" snippet in Messages.tsx updates immediately.
      queryClient.invalidateQueries({
        queryKey: ['/api/conversations', conversation?.contactId]
      });
      queryClient.invalidateQueries({ queryKey: ['/api/conversations'] });
    },
    onError: (error: any) => {
      toast({
        title: "Failed to send email",
        description: error.message || "Please try again",
        variant: "destructive"
      });
    },
  });

  const handleSendSms = () => {
    if (!smsText.trim() || !conversation?.contactPhone || !selectedFromNumber) return;

    sendSms({
      content: smsText,
      toNumber: conversation.contactPhone,
      fromNumber: selectedFromNumber,
      contactId: conversation.contactId,
    });

    // Clear the input on successful send (handled by the custom hook)
    setSmsText("");
  };

  const hasEmail = !!conversation?.contactEmail;

  const handleSendEmail = () => {
    if (!emailSubject.trim() || richTextIsEmpty(emailBody) || !hasEmail) return;
    sendEmailMutation.mutate({ subject: emailSubject, body: emailBody });
  };

  if (!conversation) return null;

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="w-full max-w-[90vw] sm:max-w-2xl lg:max-w-4xl h-[90vh] sm:h-[95vh] p-0 flex flex-col">
        <DialogHeader className="px-4 sm:px-6 py-3 border-b shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 sm:w-12 sm:h-12 rounded-full bg-muted flex items-center justify-center">
              <User className="h-5 w-5 sm:h-6 sm:w-6 text-muted-foreground" />
            </div>
            <div className="min-w-0 flex-1">
              <DialogTitle className="text-base sm:text-lg font-semibold truncate">
                {conversation.contactName}
              </DialogTitle>
              <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-4 text-xs sm:text-sm text-muted-foreground">
                {conversation.contactPhone && (
                  <div className="flex items-center gap-1">
                    <Phone className="h-3 w-3 sm:h-4 sm:w-4" />
                    <span className="truncate">{conversation.contactPhone}</span>
                  </div>
                )}
                {conversation.contactEmail && (
                  <div className="flex items-center gap-1">
                    <Mail className="h-3 w-3 sm:h-4 sm:w-4" />
                    <span className="truncate">{conversation.contactEmail}</span>
                  </div>
                )}
              </div>
            </div>
          </div>
        </DialogHeader>
        <div className="flex-1 flex flex-col min-h-0">
          <Tabs value={messageTypeFilter} onValueChange={(value) => setMessageTypeFilter(value as "text" | "email")} className="flex-1 flex flex-col min-h-0">
            <div className="px-4 sm:px-6 py-2 sm:py-3 shrink-0">
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="text" className="flex items-center gap-1 sm:gap-2 text-xs sm:text-sm">
                  <MessageSquare className="h-3 w-3 sm:h-4 sm:w-4" />
                  <span className="hidden sm:inline">SMS Messages</span>
                  <span className="sm:hidden">SMS</span>
                  ({conversationMessages.filter(msg => msg.type === 'text').length})
                </TabsTrigger>
                <TabsTrigger value="email" className="flex items-center gap-1 sm:gap-2 text-xs sm:text-sm">
                  <Mail className="h-3 w-3 sm:h-4 sm:w-4" />
                  <span className="hidden sm:inline">Email Messages</span>
                  <span className="sm:hidden">Email</span>
                  ({conversationMessages.filter(msg => msg.type === 'email').length})
                </TabsTrigger>
              </TabsList>
            </div>

            <TabsContent value="text" className="data-[state=active]:flex data-[state=inactive]:hidden flex-1 flex-col min-h-0 p-0 m-0 overflow-hidden">
              <div className="flex-1 min-h-0 overflow-hidden px-4 sm:px-6 pt-3 pb-3">
                <MessageHistory
                  messages={conversationMessages}
                  isLoading={messagesLoading}
                  emptyStateMessage="No SMS messages in this conversation"
                  filterType="text"
                  dataTestId="text-message-history"
                  contactPhone={conversation.contactPhone}
                />
              </div>

              {/* Phone Number Selection */}
              <div className="shrink-0 px-4 sm:px-6 py-2 border-t bg-background">
                <PhoneNumberSelector
                  value={selectedFromNumber}
                  onValueChange={setSelectedFromNumber}
                  dataTestId="select-from-number"
                />
              </div>

              {/* Message Input - Bottom of Popup */}
              <div className="shrink-0 px-4 sm:px-6 py-3 border-t bg-muted/30">
                <div className="flex gap-2">
                  <Input
                    placeholder="Type your message..."
                    value={smsText}
                    onChange={(e) => setSmsText(e.target.value)}
                    onKeyPress={(e) => e.key === 'Enter' && handleSendSms()}
                    className="flex-1 text-sm"
                    data-testid="input-sms-message"
                  />
                  <Button
                    onClick={handleSendSms}
                    disabled={!smsText.trim() || isSendingSms || !selectedFromNumber}
                    size="icon"
                    data-testid="button-send-sms"
                  >
                    <Send className="h-3 w-3 sm:h-4 sm:w-4" />
                  </Button>
                </div>
              </div>
            </TabsContent>

            <TabsContent value="email" className="data-[state=active]:flex data-[state=inactive]:hidden flex-1 flex-col min-h-0 p-0 m-0 overflow-hidden">
              <div className="flex-1 min-h-0 overflow-hidden px-4 sm:px-6 pt-3 pb-3">
                <MessageHistory
                  messages={conversationMessages}
                  isLoading={messagesLoading}
                  emptyStateMessage="No email messages in this conversation"
                  filterType="email"
                  dataTestId="email-message-history"
                  contactPhone={conversation.contactPhone}
                />
              </div>

              {/* Email Input Section */}
              <div className="shrink-0 px-4 sm:px-6 py-3 border-t bg-muted/30 space-y-3">
                {!hasEmail && (
                  <p className="text-sm text-muted-foreground" data-testid="no-email-message">
                    No email address on file for this contact.
                  </p>
                )}
                {showGmailWarning && (
                  <Alert variant="destructive" className="py-2">
                    <AlertTriangle className="h-4 w-4" />
                    <AlertDescription className="text-xs">
                      No email account connected. Connect Gmail in Settings to send emails.
                    </AlertDescription>
                  </Alert>
                )}
                {fromAddresses.length > 1 ? (
                  <Select
                    value={selectedFromEmail || fromAddresses[0]?.email || ''}
                    onValueChange={setSelectedFromEmail}
                  >
                    <SelectTrigger className="text-sm" data-testid="select-from-email">
                      <SelectValue placeholder="Send from..." />
                    </SelectTrigger>
                    <SelectContent>
                      {fromAddresses.map((addr) => (
                        <SelectItem key={addr.email} value={addr.email}>
                          {addr.label} ({addr.email})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : fromAddresses.length === 1 ? (
                  <Input
                    readOnly
                    className="text-sm bg-muted/50"
                    value={`${fromAddresses[0].label} (${fromAddresses[0].email})`}
                    data-testid="text-from-email-readonly"
                  />
                ) : null}
                <Input
                  placeholder="Subject"
                  value={emailSubject}
                  onChange={(e) => setEmailSubject(e.target.value)}
                  className="w-full text-sm"
                  data-testid="input-email-subject"
                  disabled={!hasEmail}
                />
                <div className="flex gap-2">
                  <div className="flex-1">
                    <RichTextEditor
                      value={emailBody}
                      onChange={setEmailBody}
                      placeholder="Type your email message..."
                      ariaLabel="Email message"
                      disabled={!hasEmail}
                      dataTestId="textarea-email-body"
                    />
                  </div>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="self-end">
                        <Button
                          onClick={handleSendEmail}
                          disabled={!hasEmail || !emailSubject.trim() || richTextIsEmpty(emailBody) || sendEmailMutation.isPending || showGmailWarning}
                          size="icon"
                          data-testid="button-send-email"
                        >
                          <Send className="h-3 w-3 sm:h-4 sm:w-4" />
                        </Button>
                      </span>
                    </TooltipTrigger>
                    {!hasEmail && (
                      <TooltipContent>
                        No email address on file for this contact
                      </TooltipContent>
                    )}
                  </Tooltip>
                </div>
              </div>
            </TabsContent>
          </Tabs>
        </div>
      </DialogContent>
    </Dialog>
  );
}