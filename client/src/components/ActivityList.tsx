import { useState } from "react";
import DOMPurify from "dompurify";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Clock,
  User,
  Plus,
  ExternalLink,
  PhoneIncoming,
  PhoneOutgoing,
  PhoneMissed,
  Voicemail,
} from "lucide-react";
import { format } from "date-fns";
import { LogCallDialog } from "./LogCallDialog";
import { ActivityTypeBadge } from "@/lib/activity-visuals";

type RecordingDetail = {
  id?: string | number;
  url?: string;
  duration?: number;
  start_time?: number;
  recording_type?: string;
};

/**
 * Resolve playable + share URLs for a call activity. Mirrors the helper in
 * RecentActivityTimeline.tsx: prefer the persisted recording id (proxied
 * through our authenticated playback endpoint), and never try to play a
 * Dialpad share-page URL inline since browsers can't render it.
 */
function resolveCallRecording(meta: Record<string, unknown> | null | undefined): {
  playableUrl: string | null;
  shareUrl: string | null;
} {
  if (!meta) return { playableUrl: null, shareUrl: null };
  const details = Array.isArray((meta as { recording_details?: unknown }).recording_details)
    ? ((meta as { recording_details: RecordingDetail[] }).recording_details)
    : null;
  const rawId = details?.find(
    (d) => d?.id !== undefined && d?.id !== null && String(d.id).length > 0,
  )?.id;
  const recordingId = rawId !== undefined && rawId !== null ? String(rawId) : null;

  // Twilio recordings stream through their own authenticated proxy and never
  // through the Dialpad one. Identify them by the provider tag or the Twilio
  // recording SID format (RE…). They have no external share page to open.
  const provider = typeof (meta as { provider?: unknown }).provider === 'string'
    ? (meta as { provider: string }).provider
    : null;
  const isTwilio = provider === 'twilio' || (recordingId ? /^RE[a-zA-Z0-9]+$/.test(recordingId) : false);
  if (isTwilio) {
    return {
      playableUrl: recordingId ? `/api/twilio/recordings/${encodeURIComponent(recordingId)}` : null,
      shareUrl: null,
    };
  }

  const shareUrl = typeof (meta as { recording_url?: unknown }).recording_url === 'string'
    ? ((meta as { recording_url: string }).recording_url)
    : null;
  const isShareLink = shareUrl ? /^https?:\/\/(www\.)?dialpad\.com\/r\//i.test(shareUrl) : false;
  const playableUrl = recordingId
    ? `/api/dialpad/recordings/${encodeURIComponent(recordingId)}`
    : (shareUrl && !isShareLink ? shareUrl : null);
  return { playableUrl, shareUrl };
}

const formatCallDuration = (seconds: number): string => {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const rem = seconds % 60;
  return rem > 0 ? `${mins}m ${rem}s` : `${mins}m`;
};

const getCallIcon = (direction?: string, outcome?: string) => {
  if (outcome === 'voicemail') return <Voicemail className="w-3 h-3" />;
  if (outcome === 'missed' || outcome === 'cancelled') return <PhoneMissed className="w-3 h-3" />;
  if (direction === 'outbound') return <PhoneOutgoing className="w-3 h-3" />;
  return <PhoneIncoming className="w-3 h-3" />;
};

interface Activity {
  id: string;
  type: 'note' | 'call' | 'email' | 'sms' | 'meeting' | 'follow_up' | 'status_change';
  title?: string;
  content: string;
  // Activity.metadata may arrive as either a JSON string (legacy text column)
  // or an already-parsed object (jsonb-style). Both are tolerated below.
  metadata?: string | Record<string, unknown>;
  leadId?: string;
  estimateId?: string;
  jobId?: string;
  customerId?: string;
  userId?: string;
  userName?: string;
  contractorId: string;
  externalId?: string | null;
  externalSource?: string | null;
  // Inbound/outbound marker, used only by the attribution fallback below.
  // For SMS this comes from the conversation message; for email it's parsed
  // out of the `metadata` JSON (set by both Gmail sync and outbound sends).
  direction?: 'inbound' | 'outbound';
  createdAt: string;
  updatedAt: string;
}

// Compute the "who did this" label for the activity row. Returns the user's
// real name when one is attached to the activity; otherwise derives a sensible
// fallback from the activity type, direction, and external source so every row
// has a clear author instead of just a date.
function getActorLabel(activity: Activity): string {
  if (activity.userName) return activity.userName;

  // Inbound messages from the customer (SMS or email) are not authored by an
  // in-app user, so credit the customer.
  if ((activity.type === 'sms' || activity.type === 'email') && activity.direction === 'inbound') {
    return 'Customer';
  }

  // Tagged at write time by the public booking widget endpoint.
  if (activity.externalSource === 'public_booking') return 'Online Booking';
  // Tagged at write time by the AI scheduling agent (auto-booked SMS flow).
  if (activity.externalSource === 'ai_agent') return 'AI Scheduling Agent';

  // Webhook-driven activities (HCP lead.converted status flips, Dialpad call
  // logs, future Gmail-only inbound webhooks) have no human actor — surface
  // them as "System" instead of leaving the author blank.
  if (
    activity.externalSource === 'housecall-pro' ||
    activity.externalSource === 'dialpad'
  ) {
    return 'System';
  }

  return 'System';
}

// Activity.metadata may arrive as either a JSON string (legacy text column) or
// an already-parsed object (jsonb-style). Normalize both shapes to a plain
// record so callers can read fields uniformly without re-parsing.
function parseActivityMetadata(metadata: unknown): Record<string, unknown> | null {
  if (!metadata) return null;
  if (typeof metadata === 'object') return metadata as Record<string, unknown>;
  if (typeof metadata === 'string') {
    try {
      const parsed = JSON.parse(metadata);
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return null;
}

// For meeting activities created by booking flows, surface the assigned
// salesperson alongside the booker — but only when the two are different
// people. Returns null when there's no assigned-salesperson metadata or when
// the booker (activity.userId) is also the calendar owner.
function getAssignedSalespersonHint(activity: Activity): string | null {
  if (activity.type !== 'meeting') return null;
  const metadata = parseActivityMetadata(activity.metadata);
  if (!metadata) return null;
  const assignedId = typeof metadata.assignedSalespersonId === 'string' ? metadata.assignedSalespersonId : null;
  const assignedName = typeof metadata.assignedSalespersonName === 'string' ? metadata.assignedSalespersonName : null;
  if (!assignedName) return null;
  // Omit the hint when the booker IS the assigned salesperson — no extra
  // information to convey in that case.
  if (assignedId && activity.userId && assignedId === activity.userId) return null;
  // ID-based comparison is the source of truth, but legacy / partial rows can
  // ship `assignedSalespersonName` without `assignedSalespersonId`. In that
  // case fall back to a normalized name comparison so we don't render a
  // redundant "Assigned to {same person}" line.
  if (!assignedId && activity.userName) {
    const norm = (s: string) => s.trim().toLowerCase();
    if (norm(assignedName) === norm(activity.userName)) return null;
  }
  return assignedName;
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
      // Preserved so getActorLabel can render "Customer" for inbound messages
      // that lack a logged-in author.
      direction: msg.direction === 'inbound' || msg.direction === 'outbound'
        ? msg.direction
        : undefined,
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
  
  // For email-type activities (which carry direction inside their JSON metadata
  // string), lift it to a top-level field so getActorLabel can attribute inbound
  // emails to the customer without needing to re-parse metadata downstream.
  const enrichedNonMessageActivities = nonMessageActivities.map((activity) => {
    if (activity.type === 'email' && activity.metadata && !activity.direction) {
      // metadata may already be a parsed object (jsonb) or a raw JSON string
      // (legacy text column). Normalize via parseActivityMetadata.
      const parsed = parseActivityMetadata(activity.metadata);
      if (parsed?.direction === 'inbound' || parsed?.direction === 'outbound') {
        return { ...activity, direction: parsed.direction as 'inbound' | 'outbound' };
      }
    }
    return activity;
  });

  // Merge activities and messages (SMS + email), then sort by date
  const combinedActivities = [...enrichedNonMessageActivities, ...messageActivities] as Activity[];
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
                      const emailMetadata = parseActivityMetadata(activity.metadata);
                      if (!emailMetadata) return null;
                      return (
                        <div className="text-xs text-muted-foreground mb-2 space-y-1">
                          {typeof emailMetadata.from === 'string' && (
                            <div><strong>From:</strong> {emailMetadata.from}</div>
                          )}
                          {emailMetadata.to !== undefined && emailMetadata.to !== null && (
                            <div><strong>To:</strong> {Array.isArray(emailMetadata.to) ? emailMetadata.to.join(', ') : String(emailMetadata.to)}</div>
                          )}
                          {typeof emailMetadata.subject === 'string' && (
                            <div><strong>Subject:</strong> {emailMetadata.subject}</div>
                          )}
                        </div>
                      );
                    })()}
                    
                    {/* For Dialpad-sourced calls, the title already conveys
                        direction + outcome + duration and the content line
                        only restates that plus the recording link, so suppress
                        it. The badges and audio player below render the
                        same info more usefully. */}
                    {(() => {
                      const isDialpadCall = activity.type === 'call' && activity.externalSource === 'dialpad';
                      if (isDialpadCall) return null;
                      return (
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
                      );
                    })()}

                    {/* Call-specific UI: badges (direction/outcome/duration) +
                        inline audio + external-link fallback. Mirrors what
                        RecentActivityTimeline shows so call rows look
                        consistent across pages. */}
                    {activity.type === 'call' && (() => {
                      const meta = parseActivityMetadata(activity.metadata) ?? {};
                      const direction = typeof meta.direction === 'string' ? meta.direction : null;
                      const outcome = typeof meta.outcome === 'string' ? meta.outcome : null;
                      const duration = typeof meta.duration === 'number' ? meta.duration : null;
                      const operatorName = typeof meta.operatorName === 'string' && meta.operatorName.length > 0
                        ? meta.operatorName
                        : null;
                      const { playableUrl, shareUrl } = resolveCallRecording(meta);
                      const hasBadges = direction || outcome || (duration && duration > 0) || operatorName;
                      const hasAudio = playableUrl || shareUrl;
                      if (!hasBadges && !hasAudio) return null;
                      return (
                        <div className="space-y-2 mb-2">
                          {hasBadges && (
                            <div className="flex items-center gap-1.5 flex-wrap">
                              {direction && (
                                <Badge variant="outline" className="gap-1 capitalize">
                                  {getCallIcon(direction, outcome ?? undefined)}
                                  {direction}
                                </Badge>
                              )}
                              {outcome && (
                                <Badge
                                  variant="secondary"
                                  className={`capitalize ${
                                    outcome === 'missed' || outcome === 'cancelled'
                                      ? 'bg-destructive/10 text-destructive'
                                      : outcome === 'voicemail'
                                      ? 'bg-chart-5/10 text-chart-5'
                                      : 'bg-chart-2/10 text-chart-2'
                                  }`}
                                >
                                  {outcome}
                                </Badge>
                              )}
                              {duration && duration > 0 && (
                                <span className="text-xs text-muted-foreground">
                                  {formatCallDuration(duration)}
                                </span>
                              )}
                              {operatorName && (
                                <span
                                  className="text-xs text-muted-foreground"
                                  data-testid={`activity-operator-${activity.id}`}
                                >
                                  Handled by {operatorName}
                                </span>
                              )}
                            </div>
                          )}
                          {hasAudio && (
                            <div className="space-y-1.5">
                              {playableUrl && (
                                <audio
                                  controls
                                  preload="none"
                                  className="w-full"
                                  src={playableUrl}
                                  data-testid={`audio-recording-${activity.id}`}
                                />
                              )}
                              {shareUrl && (
                                <Button
                                  asChild
                                  size="sm"
                                  variant="outline"
                                  data-testid={`button-open-recording-${activity.id}`}
                                >
                                  <a href={shareUrl} target="_blank" rel="noopener noreferrer">
                                    <ExternalLink className="w-3 h-3" />
                                    Open in Dialpad
                                  </a>
                                </Button>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })()}
                    
                    <div className="flex items-center gap-2 text-xs text-muted-foreground flex-wrap">
                      <User className="w-3 h-3" />
                      <span data-testid={`activity-actor-${activity.id}`}>
                        {getActorLabel(activity)}
                        {(() => {
                          const assigned = getAssignedSalespersonHint(activity);
                          return assigned ? ` • Assigned to ${assigned}` : '';
                        })()}
                        {' '}•
                      </span>
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