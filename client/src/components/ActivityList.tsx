import { useState } from "react";
import DOMPurify from "dompurify";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Clock, User, Plus } from "lucide-react";
import { format } from "date-fns";
import { LogCallDialog } from "./LogCallDialog";
import { ActivityTypeBadge } from "@/lib/activity-visuals";

interface Activity {
  id: string;
  type: 'note' | 'call' | 'email' | 'sms' | 'meeting' | 'follow_up' | 'status_change';
  title?: string;
  content: string;
  metadata?: string; // JSON string with email metadata (subject, to, from, etc.)
  leadId?: string;
  estimateId?: string;
  jobId?: string;
  customerId?: string;
  userId?: string;
  userName?: string;
  contractorId: string;
  externalId?: string | null;
  externalSource?: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ActivityListProps {
  leadId?: string;
  estimateId?: string;
  jobId?: string;
  customerId?: string;
  showAddButton?: boolean;
  className?: string;
  limit?: number;
  excludeNotes?: boolean;
}

export function ActivityList({ leadId, estimateId, jobId, customerId, showAddButton = true, className, limit, excludeNotes = false }: ActivityListProps) {
  const [isLogCallDialogOpen, setIsLogCallDialogOpen] = useState(false);

  // Note: WebSocket subscription for real-time updates is handled at the page level
  // (e.g., in Leads.tsx) to ensure the subscription persists during modal transitions

  // Query to fetch activities (non-SMS)
  const { data: allActivities = [], isLoading: isLoadingActivities } = useQuery<Activity[]>({
    queryKey: ['/api/activities', { leadId, estimateId, jobId, customerId }],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (leadId) params.append('leadId', leadId);
      if (estimateId) params.append('estimateId', estimateId);
      if (jobId) params.append('jobId', jobId);
      if (customerId) params.append('customerId', customerId);
      
      const response = await fetch(`/api/activities?${params.toString()}`);
      if (!response.ok) throw new Error('Failed to fetch activities');
      return response.json();
    },
  });

  // Query to fetch SMS messages
  interface ConversationMessage {
    id: string;
    type: string;
    content: string;
    direction?: string;
    createdAt: string;
    userName?: string;
    contactId?: string;
    estimateId?: string;
    userId?: string;
    fromNumber?: string;
    toNumber?: string;
    leadId?: string;
    customerId?: string;
    contractorId?: string;
    subject?: string;
  }
  const { data: messages = [], isLoading: isLoadingMessages } = useQuery<ConversationMessage[]>({
    queryKey: ['/api/conversations', leadId || customerId || estimateId, leadId ? 'lead' : customerId ? 'customer' : 'estimate'],
    queryFn: async () => {
      if (!leadId && !customerId && !estimateId) return [];
      const contactType = leadId ? 'lead' : customerId ? 'customer' : 'estimate';
      const contactId = leadId || customerId || estimateId;
      const response = await fetch(`/api/conversations/${contactId}/${contactType}`);
      if (!response.ok) return [];
      return response.json();
    },
    enabled: !!(leadId || customerId || estimateId),
  });

  // Convert messages (SMS and emails) to activity format
  const messageActivities = (messages as ConversationMessage[]).map((msg) => {
    const isEmail = msg.type === 'email';
    return {
      id: msg.id,
      type: isEmail ? 'email' : 'sms', // Map 'text' type to 'sms' for display
      title: isEmail 
        ? (msg.direction === 'inbound'
            ? (msg.subject ? `Email received: ${msg.subject}` : `Email received`)
            : (msg.subject ? `Email sent: ${msg.subject}` : `Email sent`))
        : (msg.direction === 'inbound' ? `Received from ${msg.fromNumber}` : `Sent to ${msg.toNumber}`),
      content: msg.content,
      metadata: isEmail ? JSON.stringify({
        from: msg.fromNumber,
        to: [msg.toNumber],
        subject: msg.subject || '',
      }) : undefined,
      leadId: msg.leadId,
      estimateId: msg.estimateId,
      customerId: msg.customerId,
      userId: msg.userId,
      userName: msg.userName,
      contractorId: msg.contractorId,
      createdAt: msg.createdAt,
      updatedAt: msg.createdAt,
    };
  });

  // Filter out SMS and email activities that came from the integration (externalId set),
  // because those already appear via the conversations endpoint (messageActivities).
  // Personal-phone SMS/email activities have no externalId and should still show here.
  //
  // Contract for writers of email-type activities: any email activity that should be
  // surfaced via the conversations stream MUST have `externalId` set when written
  // (e.g. the Gmail message id with `externalSource = 'gmail'`). Otherwise this
  // dedup will miss it and the email will appear twice — once here, and once via
  // /api/conversations. Current writers honoring this: server/sync/gmail.ts,
  // server/routes/messaging.ts, server/routes/email-sync.ts,
  // server/workflow-actions/send-email.ts.
  const nonMessageActivities = allActivities.filter(activity => {
    if ((activity.type === 'sms' || activity.type === 'email') && activity.externalId) {
      return false;
    }
    return true;
  });
  
  // Merge activities and messages (SMS + email), then sort by date
  const combinedActivities = [...nonMessageActivities, ...messageActivities] as Activity[];
  const filteredActivities = excludeNotes
    ? combinedActivities.filter(a => a.type !== 'note')
    : combinedActivities;
  const sortedActivities = filteredActivities.sort((a, b) => 
    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
  const activities = limit ? sortedActivities.slice(0, limit) : sortedActivities;
  
  const isLoading = isLoadingActivities || isLoadingMessages;

  if (isLoading) {
    return (
      <Card className={className}>
        <CardContent className="p-4">
          <div className="animate-pulse space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-16 bg-muted rounded-md"></div>
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className={className}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2">
            <Clock className="w-5 h-5" />
            Activity History
          </CardTitle>
          {showAddButton && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setIsLogCallDialogOpen(true)}
              data-testid="button-log-call"
            >
              <Plus className="w-4 h-4 mr-1" />
              Log Call
            </Button>
          )}
        </div>
      </CardHeader>
      
      <CardContent className="space-y-4">
        <LogCallDialog
          open={isLogCallDialogOpen}
          onOpenChange={setIsLogCallDialogOpen}
          leadId={leadId}
          estimateId={estimateId}
          jobId={jobId}
          customerId={customerId}
        />

        {/* Activity List */}
        {activities.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground" data-testid="text-no-activities">
            <Clock className="w-12 h-12 mx-auto mb-2 opacity-50" />
            <p>No activities recorded yet</p>
            <p className="text-sm">Activities are automatically captured from calls, messages, and other interactions</p>
          </div>
        ) : (
          <div className="space-y-3">
            {activities.map((activity) => (
              <Card key={activity.id} className="border-l-4 border-l-primary/20" data-testid={`activity-card-${activity.id}`}>
                <CardContent className="p-4">
                  <div>
                    <div className="flex items-start justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <ActivityTypeBadge type={activity.type} showLabel />
                        {activity.title && (
                          <span className="font-medium text-sm" data-testid={`activity-title-${activity.id}`}>
                            {activity.title}
                          </span>
                        )}
                      </div>
                    </div>
                    
                    {/* Show email metadata if available */}
                    {activity.type === 'email' && activity.metadata && (() => {
                      try {
                        const emailMetadata = JSON.parse(activity.metadata);
                        return (
                          <div className="text-xs text-muted-foreground mb-2 space-y-1">
                            {emailMetadata.from && (
                              <div><strong>From:</strong> {emailMetadata.from}</div>
                            )}
                            {emailMetadata.to && (
                              <div><strong>To:</strong> {Array.isArray(emailMetadata.to) ? emailMetadata.to.join(', ') : emailMetadata.to}</div>
                            )}
                            {emailMetadata.subject && (
                              <div><strong>Subject:</strong> {emailMetadata.subject}</div>
                            )}
                          </div>
                        );
                      } catch (e) {
                        return null;
                      }
                    })()}
                    
                    <div className="text-sm mb-2" data-testid={`activity-content-${activity.id}`}>
                      {activity.type === 'email' ? (
                        <div
                          className="prose prose-sm max-w-none dark:prose-invert break-words overflow-hidden [&_*]:break-words"
                          dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(activity.content) }}
                        />
                      ) : (
                        <p className="whitespace-pre-wrap break-words overflow-hidden">{activity.content}</p>
                      )}
                    </div>
                    
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <User className="w-3 h-3" />
                      {activity.userName && (
                        <span>{activity.userName} •</span>
                      )}
                      <span data-testid={`activity-timestamp-${activity.id}`}>
                        {format(new Date(activity.createdAt), "MMM d, yyyy 'at' h:mm a")}
                      </span>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}