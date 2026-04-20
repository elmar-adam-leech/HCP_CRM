import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock, ArrowRight, Users, Briefcase, FileText as EstimateIcon } from "lucide-react";
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
  direction?: string;
  outcome?: string;
  duration?: number;
  [key: string]: unknown;
};

type Activity = {
  id: string;
  type: 'note' | 'call' | 'email' | 'sms' | 'meeting' | 'follow_up' | 'status_change';
  title?: string;
  content?: string;
  metadata?: ActivityMetadata | null;
  leadId?: string;
  estimateId?: string;
  jobId?: string;
  customerId?: string;
  createdAt: string;
  entityName?: string;
  entityType?: 'lead' | 'estimate' | 'job';
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

const getEntityIcon = (entityType?: string) => {
  switch (entityType) {
    case 'lead': return <Users className="w-3 h-3" />;
    case 'estimate': return <EstimateIcon className="w-3 h-3" />;
    case 'job': return <Briefcase className="w-3 h-3" />;
    default: return null;
  }
};

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
  // activity_created/updated/deleted are also handled by Dashboard.tsx's
  // useWebSocketInvalidation hook when this component is rendered there.
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

    return () => {
      unsubscribe();
    };
  }, [subscribe, queryClient]);

  const handleViewEntity = (activity: Activity) => {
    if (activity.leadId) {
      setLocation(`/leads?id=${activity.leadId}`);
    } else if (activity.estimateId) {
      setLocation(`/estimates?id=${activity.estimateId}`);
    } else if (activity.jobId) {
      setLocation(`/jobs?id=${activity.jobId}`);
    }
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
            {activities.map((activity) => (
              <div
                key={activity.id}
                className="flex items-start gap-3 p-3 rounded-lg border hover-elevate"
                data-testid={`activity-${activity.id}`}
              >
                <div className="flex-shrink-0 mt-0.5">
                  <ActivityTypeBadge type={activity.type} />
                </div>

                <div className="flex-1 min-w-0 space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium">
                      {activity.title || activity.type.replace('_', ' ')}
                    </span>
                    {activity.entityType && (
                      <Badge variant="outline" className="text-xs gap-1">
                        {getEntityIcon(activity.entityType)}
                        {activity.entityType}
                      </Badge>
                    )}
                  </div>

                  {activity.content && (
                    <p className="text-sm text-muted-foreground line-clamp-2">
                      {activity.type === 'email' ? stripHtml(activity.content) : activity.content}
                    </p>
                  )}

                  {activity.type === 'call' && activity.metadata && (
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {activity.metadata.direction && (
                        <Badge variant="outline" className="text-xs capitalize">
                          {String(activity.metadata.direction)}
                        </Badge>
                      )}
                      {activity.metadata.outcome && (
                        <Badge
                          variant="secondary"
                          className={`text-xs capitalize ${
                            activity.metadata.outcome === 'missed' || activity.metadata.outcome === 'cancelled'
                              ? 'bg-destructive/10 text-destructive'
                              : activity.metadata.outcome === 'voicemail'
                              ? 'bg-chart-5/10 text-chart-5'
                              : 'bg-chart-2/10 text-chart-2'
                          }`}
                        >
                          {String(activity.metadata.outcome)}
                        </Badge>
                      )}
                      {typeof activity.metadata.duration === 'number' && activity.metadata.duration > 0 && (
                        <span className="text-xs text-muted-foreground">
                          {activity.metadata.duration < 60
                            ? `${activity.metadata.duration}s`
                            : `${Math.floor(activity.metadata.duration / 60)}m ${activity.metadata.duration % 60 > 0 ? `${activity.metadata.duration % 60}s` : ''}`}
                        </span>
                      )}
                    </div>
                  )}

                  {activity.type === 'call' && (() => {
                    // Prefer the persisted recording ID (we fetch a fresh
                    // playback URL on demand). Fall back to the original
                    // webhook URL only when no ID was captured — those URLs
                    // expire within minutes so playback may still fail.
                    const rawRecordingId = activity.metadata?.recording_details?.find(
                      (d) => d?.id !== undefined && d?.id !== null && String(d.id).length > 0,
                    )?.id;
                    const recordingId = rawRecordingId !== undefined && rawRecordingId !== null
                      ? String(rawRecordingId)
                      : null;
                    const playbackUrl = recordingId
                      ? `/api/dialpad/recordings/${encodeURIComponent(recordingId)}`
                      : (activity.metadata?.recording_url as string | undefined);
                    if (!playbackUrl) return null;
                    return (
                      <div className="pt-1 space-y-1">
                        <audio
                          controls
                          preload="none"
                          className="w-full h-8 rounded"
                          src={playbackUrl}
                          data-testid={`audio-recording-${activity.id}`}
                        />
                        <a
                          href={playbackUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-primary underline block"
                        >
                          Open recording
                        </a>
                      </div>
                    );
                  })()}

                  {activity.entityName && (
                    <p className="text-xs text-muted-foreground">
                      {activity.entityName}
                    </p>
                  )}

                  <p className="text-xs text-muted-foreground">
                    {formatDistanceToNow(new Date(activity.createdAt), { addSuffix: true })}
                  </p>
                </div>

                {(activity.leadId || activity.estimateId || activity.jobId) && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="flex-shrink-0"
                    onClick={() => handleViewEntity(activity)}
                    data-testid={`button-view-activity-${activity.id}`}
                  >
                    <ArrowRight className="w-4 h-4" />
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
