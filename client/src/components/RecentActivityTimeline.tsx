import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Clock,
  ChevronRight,
  Users,
  Briefcase,
  FileText as EstimateIcon,
  ExternalLink,
  PhoneIncoming,
  PhoneOutgoing,
  PhoneMissed,
  Voicemail,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { useLocation } from "wouter";
import { useWebSocketContext } from "@/contexts/WebSocketContext";
import { useEffect } from "react";
import { ActivityTypeBadge } from "@/lib/activity-visuals";

type RecordingDetail = {
  // Dialpad returns ids as either string or number depending on the route,
  // so accept both and coerce to string before using as a URL segment.
  id?: string | number;
  url?: string;
  duration?: number;
  start_time?: number;
  recording_type?: string;
};

type ActivityMetadata = {
  recording_url?: string;
  recording_details?: RecordingDetail[] | null;
  /** Set by the Dialpad webhook — true iff there's a streamable export id. */
  recording_playable?: boolean;
  direction?: string;
  outcome?: string;
  duration?: number;
  contactName?: string;
  [key: string]: unknown;
};

type EntityType = 'lead' | 'customer' | 'estimate' | 'job';

type Activity = {
  id: string;
  type: 'note' | 'call' | 'email' | 'sms' | 'meeting' | 'follow_up' | 'status_change';
  title?: string;
  content?: string;
  metadata?: ActivityMetadata | null;
  contactId?: string | null;
  estimateId?: string | null;
  jobId?: string | null;
  externalSource?: string | null;
  createdAt: string;
  /** Joined-in entity context — what the activity is "about". */
  entityName?: string | null;
  entityType?: EntityType | null;
};

const stripHtml = (html: string): string =>
  html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&[^;]+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const initials = (name: string): string => {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  if (parts.length === 0) return '?';
  return parts.map((p) => p[0]?.toUpperCase() ?? '').join('') || '?';
};

const ENTITY_LABELS: Record<EntityType, string> = {
  lead: 'Lead',
  customer: 'Customer',
  estimate: 'Estimate',
  job: 'Job',
};

const getEntityIcon = (entityType?: EntityType | null) => {
  switch (entityType) {
    case 'lead':
    case 'customer':
      return <Users className="w-3 h-3" />;
    case 'estimate':
      return <EstimateIcon className="w-3 h-3" />;
    case 'job':
      return <Briefcase className="w-3 h-3" />;
    default:
      return null;
  }
};

const getCallIcon = (direction?: string, outcome?: string) => {
  if (outcome === 'voicemail') return <Voicemail className="w-3 h-3" />;
  if (outcome === 'missed' || outcome === 'cancelled') return <PhoneMissed className="w-3 h-3" />;
  if (direction === 'outbound') return <PhoneOutgoing className="w-3 h-3" />;
  return <PhoneIncoming className="w-3 h-3" />;
};

const formatDuration = (seconds: number): string => {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const rem = seconds % 60;
  return rem > 0 ? `${mins}m ${rem}s` : `${mins}m`;
};

/**
 * Resolve playable + share URLs for a call activity. Order of preference:
 *   1. A persisted recording id → stream via our authenticated proxy.
 *   2. The original recording_url, ONLY if it's not a Dialpad share page
 *      (those won't autoplay in an <audio> element).
 * The "share/open externally" url is always the original recording_url
 * when present.
 */
function resolveCallRecording(metadata: ActivityMetadata | null | undefined): {
  playableUrl: string | null;
  shareUrl: string | null;
} {
  if (!metadata) return { playableUrl: null, shareUrl: null };
  const rawId = metadata.recording_details?.find(
    (d) => d?.id !== undefined && d?.id !== null && String(d.id).length > 0,
  )?.id;
  const recordingId = rawId !== undefined && rawId !== null ? String(rawId) : null;

  // Twilio recordings stream through their own authenticated proxy and never
  // through the Dialpad one. Identify them by the provider tag or the Twilio
  // recording SID format (RE…). They have no external share page to open.
  const provider = typeof metadata.provider === 'string' ? metadata.provider : null;
  const isTwilio = provider === 'twilio' || (recordingId ? /^RE[a-zA-Z0-9]+$/.test(recordingId) : false);
  if (isTwilio) {
    return {
      playableUrl: recordingId ? `/api/twilio/recordings/${encodeURIComponent(recordingId)}` : null,
      shareUrl: null,
    };
  }

  const shareUrl = typeof metadata.recording_url === 'string' ? metadata.recording_url : null;
  const isShareLink = shareUrl ? /^https?:\/\/(www\.)?dialpad\.com\/r\//i.test(shareUrl) : false;
  const playableUrl = recordingId
    ? `/api/dialpad/recordings/${encodeURIComponent(recordingId)}`
    : (shareUrl && !isShareLink ? shareUrl : null);
  return { playableUrl, shareUrl };
}

interface RecentActivityTimelineProps {
  limit?: number;
  className?: string;
}

export function RecentActivityTimeline({ limit = 10, className }: RecentActivityTimelineProps) {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const { subscribe } = useWebSocketContext();

  // Fetch all recent activities (not filtered by entity)
  const { data: activities = [], isLoading } = useQuery<Activity[]>({
    queryKey: ['/api/activities', { limit }],
    queryFn: async () => {
      const response = await fetch(`/api/activities?limit=${limit}`);
      if (!response.ok) throw new Error('Failed to fetch activities');
      return response.json();
    },
  });

  // Subscribe to relevant WebSocket events to refresh the activity feed.
  useEffect(() => {
    const unsubscribe = subscribe((message) => {
      if (
        message.type === 'activity_created' ||
        message.type === 'activity_updated' ||
        message.type === 'activity_deleted' ||
        message.type === 'contact_deleted' ||
        message.type === 'estimate_deleted' ||
        message.type === 'job_deleted'
      ) {
        queryClient.invalidateQueries({ queryKey: ['/api/activities'] });
      }
    });
    return () => { unsubscribe(); };
  }, [subscribe, queryClient]);

  /** Build the destination route for "jump to record" — job > estimate > contact.
   *  Always carries the record id so the destination page can deep-link straight
   *  to the matching detail view. */
  const getEntityHref = (a: Activity): string | null => {
    if (a.jobId) return `/jobs?id=${a.jobId}`;
    if (a.estimateId) return `/estimates?id=${a.estimateId}`;
    if (a.contactId) {
      // Customers live on /contacts; leads (the default) on /leads.
      const base = a.entityType === 'customer' ? '/contacts' : '/leads';
      return `${base}?id=${a.contactId}`;
    }
    return null;
  };

  if (isLoading) {
    return (
      <Card className={className}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Clock className="w-5 h-5" />
            Recent Activity
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="h-20 bg-muted animate-pulse rounded" />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Clock className="w-5 h-5" />
          Recent Activity
        </CardTitle>
      </CardHeader>
      <CardContent>
        {activities.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            <Clock className="w-12 h-12 mx-auto mb-2 opacity-50" />
            <p className="font-medium">No recent activity</p>
            <p className="text-sm">Activities will appear here as you work with leads, estimates, and jobs</p>
          </div>
        ) : (
          <div className="space-y-3">
            {activities.map((activity) => {
              const href = getEntityHref(activity);
              const isCall = activity.type === 'call';
              const isDialpadCall = isCall && activity.externalSource === 'dialpad';
              // For Dialpad call rows, the "title" already encodes direction +
              // outcome + duration (and content is just title + recording link),
              // so suppress the content paragraph to keep the card clean.
              const showContent = activity.content
                && !isDialpadCall
                && activity.type !== 'status_change';

              const entityDisplay = activity.entityName ?? null;
              const meta = activity.metadata ?? null;
              const { playableUrl, shareUrl } = isCall
                ? resolveCallRecording(meta)
                : { playableUrl: null, shareUrl: null };

              const navigate = () => { if (href) setLocation(href); };

              return (
                <div
                  key={activity.id}
                  role={href ? 'button' : undefined}
                  tabIndex={href ? 0 : undefined}
                  onClick={href ? navigate : undefined}
                  onKeyDown={href ? (e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      navigate();
                    }
                  } : undefined}
                  className={`flex items-start gap-3 p-3 rounded-md border ${href ? 'hover-elevate active-elevate-2 cursor-pointer' : ''}`}
                  data-testid={`activity-${activity.id}`}
                >
                  <Avatar className="h-9 w-9 flex-shrink-0">
                    <AvatarFallback className="text-xs">
                      {entityDisplay ? initials(entityDisplay) : <Clock className="w-4 h-4" />}
                    </AvatarFallback>
                  </Avatar>

                  <div className="flex-1 min-w-0 space-y-1.5">
                    {/* Header line: entity name + entity-type badge */}
                    <div className="flex items-center gap-2 flex-wrap">
                      <span
                        className="text-sm font-medium truncate"
                        data-testid={`activity-entity-${activity.id}`}
                      >
                        {entityDisplay ?? 'Unmatched activity'}
                      </span>
                      {activity.entityType && (
                        <Badge variant="outline" className="gap-1">
                          {getEntityIcon(activity.entityType)}
                          {ENTITY_LABELS[activity.entityType]}
                        </Badge>
                      )}
                    </div>

                    {/* Sub-line: type badge + title */}
                    <div className="flex items-center gap-2 flex-wrap text-sm text-muted-foreground">
                      <ActivityTypeBadge type={activity.type} />
                      <span className="truncate">
                        {activity.title || activity.type.replace('_', ' ')}
                      </span>
                    </div>

                    {/* Optional content (notes, emails) — never for Dialpad calls */}
                    {showContent && (
                      <p className="text-sm text-muted-foreground line-clamp-2">
                        {activity.type === 'email' ? stripHtml(activity.content!) : activity.content}
                      </p>
                    )}

                    {/* Call-specific badges: direction + outcome + duration + handled-by */}
                    {isCall && meta && Boolean(meta.direction || meta.outcome || meta.duration || meta.operatorName) && (
                      <div className="flex items-center gap-1.5 flex-wrap">
                        {meta.direction && (
                          <Badge variant="outline" className="gap-1 capitalize">
                            {getCallIcon(meta.direction, meta.outcome)}
                            {String(meta.direction)}
                          </Badge>
                        )}
                        {meta.outcome && (
                          <Badge
                            variant="secondary"
                            className={`capitalize ${
                              meta.outcome === 'missed' || meta.outcome === 'cancelled'
                                ? 'bg-destructive/10 text-destructive'
                                : meta.outcome === 'voicemail'
                                ? 'bg-chart-5/10 text-chart-5'
                                : 'bg-chart-2/10 text-chart-2'
                            }`}
                          >
                            {String(meta.outcome)}
                          </Badge>
                        )}
                        {typeof meta.duration === 'number' && meta.duration > 0 && (
                          <span className="text-xs text-muted-foreground">
                            {formatDuration(meta.duration)}
                          </span>
                        )}
                        {typeof meta.operatorName === 'string' && meta.operatorName.length > 0 && (
                          <span
                            className="text-xs text-muted-foreground"
                            data-testid={`activity-operator-${activity.id}`}
                          >
                            Handled by {meta.operatorName}
                          </span>
                        )}
                      </div>
                    )}

                    {/* Recording playback or external-link fallback. The wrapping
                        div stops click events so interacting with the audio
                        controls or clicking "Open in Dialpad" doesn't also
                        trigger the card's navigation. */}
                    {isCall && (playableUrl || shareUrl) && (
                      <div
                        className="pt-1 space-y-1.5"
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => e.stopPropagation()}
                      >
                        {playableUrl ? (
                          <audio
                            controls
                            preload="none"
                            className="w-full"
                            src={playableUrl}
                            data-testid={`audio-recording-${activity.id}`}
                          />
                        ) : null}
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

                    {/* Footer: timestamp */}
                    <p className="text-xs text-muted-foreground">
                      {formatDistanceToNow(new Date(activity.createdAt), { addSuffix: true })}
                    </p>
                  </div>

                  {href && (
                    <ChevronRight
                      className="w-4 h-4 flex-shrink-0 text-muted-foreground self-center"
                      aria-hidden="true"
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
