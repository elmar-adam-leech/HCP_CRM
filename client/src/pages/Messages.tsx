import { useState, useCallback, memo, type ElementType } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TextingModal } from "@/components/TextingModal";
import { EmailComposerModal } from "@/components/EmailComposerModal";
import { ConversationModal } from "@/components/ConversationModal";
import { PageHeader } from "@/components/ui/page-header-v2";
import { PageLayout } from "@/components/ui/page-layout";
import { 
  Search, 
  MessageSquare, 
  Mail, 
  User, 
  CalendarIcon,
  Inbox
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { format } from "date-fns";
import { cn } from "@/lib/utils";
import type { Message } from "@shared/schema";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useWebSocketInvalidation } from "@/hooks/useWebSocketInvalidation";

interface Conversation {
  contactId: string;
  contactName: string;
  contactPhone?: string;
  contactEmail?: string;
  lastMessage: Message;
  unreadCount: number;
  totalMessages: number;
}

/** Single row in the conversations list. Memoized to avoid re-rendering when
 *  unrelated state changes (e.g. filter dropdowns opening/closing). */
const ConversationItem = memo(function ConversationItem({
  conversation,
  formatTimestamp,
  getMessageTypeIcon,
  getStatusBadgeVariant,
  onOpen,
  onText,
}: {
  conversation: Conversation;
  formatTimestamp: (ts: string | Date) => string;
  getMessageTypeIcon: (type: "text" | "email") => ElementType;
  getStatusBadgeVariant: (status: "sent" | "delivered" | "failed") => "outline" | "default" | "destructive" | "secondary";
  onOpen: (c: Conversation) => void;
  onText: (c: Conversation) => void;
}) {
  const TypeIcon = getMessageTypeIcon(conversation.lastMessage.type as "text" | "email");
  const hasUnread = conversation.unreadCount > 0;
  return (
    <div
      className={cn(
        "p-4 cursor-pointer hover-elevate border-b border-border/50 last:border-0",
        hasUnread && "border-l-2 border-l-primary"
      )}
      onClick={() => onOpen(conversation)}
      data-testid={`conversation-${conversation.contactId}`}
    >
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center shrink-0">
          <User className="h-5 w-5 text-muted-foreground" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-1 mb-1">
            <div className="flex items-center gap-2 min-w-0">
              <h4 className={cn("text-sm truncate", hasUnread ? "font-semibold" : "font-medium")}>
                {conversation.contactName}
              </h4>
              {hasUnread && (
                <Badge variant="default" className="text-xs shrink-0 no-default-hover-elevate no-default-active-elevate">
                  {conversation.unreadCount}
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-1 text-xs text-muted-foreground shrink-0">
              <TypeIcon className="h-3 w-3" />
              <span>{formatTimestamp(conversation.lastMessage.createdAt)}</span>
            </div>
          </div>
          <p className={cn("text-sm line-clamp-2 mb-2", hasUnread ? "text-foreground" : "text-muted-foreground")}>
            {conversation.lastMessage.content}
          </p>
          <div className="flex items-center justify-between gap-1">
            <div className="flex items-center gap-1 flex-wrap">
              <Badge
                variant={getStatusBadgeVariant((conversation.lastMessage.status ?? 'sent') as "sent" | "delivered" | "failed")}
                className="text-xs"
              >
                {conversation.lastMessage.status}
              </Badge>
              <span className="text-xs text-muted-foreground">
                {conversation.totalMessages} message{conversation.totalMessages !== 1 ? 's' : ''}
              </span>
            </div>
            {conversation.contactPhone && (
              <Button
                variant="ghost"
                size="icon"
                onClick={(e) => { e.stopPropagation(); onText(conversation); }}
                data-testid={`button-text-${conversation.contactId}`}
              >
                <MessageSquare className="h-3 w-3" />
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});

// Pure helper functions — defined at module scope so ConversationItem's memo
// never invalidates due to new function references from the parent.
const formatTimestamp = (timestamp: string | Date) => {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffHours = diffMs / (1000 * 60 * 60);
  const diffDays = diffHours / 24;
  if (diffHours < 1) return `${Math.floor(diffMs / (1000 * 60))}m ago`;
  if (diffHours < 24) return `${Math.floor(diffHours)}h ago`;
  if (diffDays < 7) return `${Math.floor(diffDays)}d ago`;
  return date.toLocaleDateString();
};

const getMessageTypeIcon = (type: "text" | "email"): ElementType =>
  type === "text" ? MessageSquare : Mail;

const getStatusBadgeVariant = (status: "sent" | "delivered" | "failed"): "outline" | "default" | "destructive" | "secondary" => {
  switch (status) {
    case "sent": return "outline";
    case "delivered": return "default";
    case "failed": return "destructive";
    default: return "secondary";
  }
};

export default function Messages() {
  const { data: currentUserData } = useCurrentUser();
  const contractorName = currentUserData?.user?.contractorName || '';

  const [searchQuery, setSearchQuery] = useState("");
  const [filterType, setFilterType] = useState<"all" | "text" | "email">("all");
  const [filterStatus, setFilterStatus] = useState<"all" | "sent" | "delivered" | "failed">("all");
  const [dateFrom, setDateFrom] = useState<Date | undefined>();
  const [dateTo, setDateTo] = useState<Date | undefined>();
  const [inboxTab, setInboxTab] = useState<"unread" | "all">("unread");
  const [conversationModal, setConversationModal] = useState<{
    isOpen: boolean;
    conversation?: Conversation;
  }>({ isOpen: false });
  const [textingModal, setTextingModal] = useState<{
    isOpen: boolean;
    conversation?: Conversation;
  }>({ isOpen: false });
  const [emailModal, setEmailModal] = useState<{
    isOpen: boolean;
    conversation?: Conversation;
  }>({ isOpen: false });

  useWebSocketInvalidation([
    { types: ['new_message', 'message_update', 'messages_read'], queryKeys: ['/api/conversations'] },
    { types: ['new_message', 'messages_read'], queryKeys: ['/api/messages/unread-count'] },
  ]);

  const { data: unreadData } = useQuery<{ unreadCount: number }>({
    queryKey: ['/api/messages/unread-count'],
  });
  const unreadCount = unreadData?.unreadCount ?? 0;

  const isUnreadTab = inboxTab === "unread";

  const { data: filteredConversations = [], isLoading: conversationsLoading } = useQuery<Conversation[]>({
    queryKey: ['/api/conversations', { 
      search: searchQuery || undefined,
      type: filterType !== 'all' ? filterType : undefined,
      status: filterStatus !== 'all' ? filterStatus : undefined,
      dateFrom: dateFrom ? dateFrom.toISOString() : undefined,
      dateTo: dateTo ? dateTo.toISOString() : undefined,
      unreadOnly: isUnreadTab || undefined,
    }],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (searchQuery) params.append('search', searchQuery);
      if (filterType !== 'all') params.append('type', filterType);
      if (filterStatus !== 'all') params.append('status', filterStatus);
      if (dateFrom) params.append('dateFrom', dateFrom.toISOString());
      if (dateTo) params.append('dateTo', dateTo.toISOString());
      if (isUnreadTab) params.append('unreadOnly', 'true');
      const qs = params.toString();
      return (await apiRequest('GET', `/api/conversations${qs ? `?${qs}` : ''}`)).json();
    },
  });

  const displayedConversations = filteredConversations;

  const handleStartConversation = useCallback((conversation: Conversation) => {
    setTextingModal({ isOpen: true, conversation });
  }, []);

  const handleOpenConversation = useCallback((c: Conversation) => {
    setConversationModal({ isOpen: true, conversation: c });
  }, []);

  return (
    <PageLayout>
      <PageHeader 
        title="Messages" 
        description="Unified communications hub for all customer interactions"
      />

      {/* Search and Filters */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center mb-6">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search conversations..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
            data-testid="input-search-messages"
          />
        </div>
        <div className="flex gap-2 flex-wrap">
          <Select value={filterType} onValueChange={(value: string) => setFilterType(value as typeof filterType)}>
            <SelectTrigger className="w-32" data-testid="select-filter-type">
              <SelectValue placeholder="Type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Types</SelectItem>
              <SelectItem value="text">Text</SelectItem>
              <SelectItem value="email">Email</SelectItem>
            </SelectContent>
          </Select>
          <Select value={filterStatus} onValueChange={(value: string) => setFilterStatus(value as typeof filterStatus)}>
            <SelectTrigger className="w-32" data-testid="select-filter-status">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Status</SelectItem>
              <SelectItem value="sent">Sent</SelectItem>
              <SelectItem value="delivered">Delivered</SelectItem>
              <SelectItem value="failed">Failed</SelectItem>
            </SelectContent>
          </Select>
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                className={cn(
                  "w-36 justify-start text-left font-normal",
                  !dateFrom && "text-muted-foreground"
                )}
                data-testid="button-date-from"
              >
                <CalendarIcon className="mr-2 h-4 w-4" />
                {dateFrom ? format(dateFrom, "MMM dd") : "From date"}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0">
              <Calendar
                mode="single"
                selected={dateFrom}
                onSelect={setDateFrom}
                initialFocus
              />
            </PopoverContent>
          </Popover>
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                className={cn(
                  "w-36 justify-start text-left font-normal",
                  !dateTo && "text-muted-foreground"
                )}
                data-testid="button-date-to"
              >
                <CalendarIcon className="mr-2 h-4 w-4" />
                {dateTo ? format(dateTo, "MMM dd") : "To date"}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0">
              <Calendar
                mode="single"
                selected={dateTo}
                onSelect={setDateTo}
                initialFocus
              />
            </PopoverContent>
          </Popover>
          {(dateFrom || dateTo) && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setDateFrom(undefined);
                setDateTo(undefined);
              }}
              data-testid="button-clear-dates"
            >
              Clear dates
            </Button>
          )}
        </div>
      </div>

      {/* Inbox Tabs */}
      <div className="mb-4">
        <Tabs value={inboxTab} onValueChange={(v) => setInboxTab(v as "unread" | "all")}>
          <TabsList>
            <TabsTrigger value="unread" className="flex items-center gap-2" data-testid="tab-unread">
              <Inbox className="h-4 w-4" />
              Unread
              {unreadCount > 0 && (
                <Badge variant="default" className="text-xs no-default-hover-elevate no-default-active-elevate">
                  {unreadCount}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="all" data-testid="tab-all">
              All
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 max-w-4xl mx-auto">
        {/* Conversations List */}
        <Card className="h-full">
            <CardHeader className="pb-3">
              <CardTitle className="text-base font-medium">
                {inboxTab === "unread" ? "Unread Conversations" : "All Conversations"} ({displayedConversations.length})
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <ScrollArea className="h-[600px]">
                {conversationsLoading ? (
                  <div className="p-4 text-center text-muted-foreground" data-testid="loading-conversations">
                    Loading conversations...
                  </div>
                ) : displayedConversations.length === 0 ? (
                  <div className="p-4 text-center text-muted-foreground" data-testid="no-conversations">
                    {inboxTab === "unread"
                      ? "No unread conversations"
                      : searchQuery || filterType !== "all" || filterStatus !== "all" 
                        ? "No conversations match your criteria" 
                        : "No conversations yet"}
                  </div>
                ) : (
                  <div className="space-y-1">
                    {displayedConversations.map((conversation) => (
                      <ConversationItem
                        key={conversation.contactId}
                        conversation={conversation}
                        formatTimestamp={formatTimestamp}
                        getMessageTypeIcon={getMessageTypeIcon}
                        getStatusBadgeVariant={getStatusBadgeVariant}
                        onOpen={handleOpenConversation}
                        onText={handleStartConversation}
                      />
                    ))}
                  </div>
                )}
              </ScrollArea>
            </CardContent>
          </Card>
        </div>

      {/* Texting Modal */}
      <TextingModal
        isOpen={textingModal.isOpen}
        onClose={() => setTextingModal({ isOpen: false })}
        recipientName={textingModal.conversation?.contactName || ''}
        recipientPhone={textingModal.conversation?.contactPhone || ''}
        companyName={contractorName}
        contactId={textingModal.conversation?.contactId}
      />

      {/* Email Composer Modal */}
      <EmailComposerModal
        isOpen={emailModal.isOpen}
        onClose={() => setEmailModal({ isOpen: false })}
        recipientName={emailModal.conversation?.contactName || ''}
        recipientEmail={emailModal.conversation?.contactEmail || ''}
        recipientPhone={emailModal.conversation?.contactPhone || ''}
        companyName={contractorName}
        contactId={emailModal.conversation?.contactId}
      />

      {/* Conversation Modal */}
      <ConversationModal
        isOpen={conversationModal.isOpen}
        onClose={() => setConversationModal({ isOpen: false })}
        conversation={conversationModal.conversation || null}
      />
    </PageLayout>
  );
}