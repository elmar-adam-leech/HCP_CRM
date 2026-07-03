import { useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  Phone,
  PhoneIncoming,
  PhoneOutgoing,
  PhoneMissed,
  Voicemail,
  UserPlus,
  ExternalLink,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { apiRequest } from "@/lib/queryClient";
import { formatPhoneNumber } from "@/lib/utils";
import { CreateContactFromCallDialog } from "@/components/calls/CreateContactFromCallDialog";

type RecordingDetail = {
  id?: string | number;
  url?: string;
};

interface CallRow {
  id: string;
  contactId: string | null;
  metadata?: string | Record<string, unknown>;
  userName?: string | null;
  entityName?: string | null;
  entityType?: "lead" | "customer" | null;
  externalSource?: string | null;
  otherPartyNumber: string | null;
  createdAt: string;
}

interface CallsResponse {
  calls: CallRow[];
  nextCursor: string | null;
}

type DirectionFilter = "all" | "inbound" | "outbound";
type AssignmentFilter = "all" | "assigned" | "unassigned";

// Normalize metadata that may arrive as a JSON string (legacy text column) or
// an already-parsed object (jsonb).
function parseMetadata(metadata: unknown): Record<string, unknown> {
  if (!metadata) return {};
  if (typeof metadata === "object") return metadata as Record<string, unknown>;
  if (typeof metadata === "string") {
    try {
      const parsed = JSON.parse(metadata);
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return {};
}

// Resolve playable + share URLs for a call recording. Mirrors the logic in
// ActivityList.tsx: prefer the persisted recording id (proxied through our
// authenticated playback endpoint), route Twilio SIDs to the Twilio proxy, and
// never try to play a Dialpad share-page URL inline.
function resolveCallRecording(meta: Record<string, unknown>): {
  playableUrl: string | null;
  shareUrl: string | null;
} {
  const details = Array.isArray((meta as { recording_details?: unknown }).recording_details)
    ? ((meta as { recording_details: RecordingDetail[] }).recording_details)
    : null;
  const rawId = details?.find(
    (d) => d?.id !== undefined && d?.id !== null && String(d.id).length > 0,
  )?.id;
  const recordingId = rawId !== undefined && rawId !== null ? String(rawId) : null;

  const provider = typeof (meta as { provider?: unknown }).provider === "string"
    ? (meta as { provider: string }).provider
    : null;
  const isTwilio = provider === "twilio" || (recordingId ? /^RE[a-zA-Z0-9]+$/.test(recordingId) : false);
  if (isTwilio) {
    return {
      playableUrl: recordingId ? `/api/twilio/recordings/${encodeURIComponent(recordingId)}` : null,
      shareUrl: null,
    };
  }

  const shareUrl = typeof (meta as { recording_url?: unknown }).recording_url === "string"
    ? ((meta as { recording_url: string }).recording_url)
    : null;
  const isShareLink = shareUrl ? /^https?:\/\/(www\.)?dialpad\.com\/r\//i.test(shareUrl) : false;
  const playableUrl = recordingId
    ? `/api/dialpad/recordings/${encodeURIComponent(recordingId)}`
    : (shareUrl && !isShareLink ? shareUrl : null);
  return { playableUrl, shareUrl };
}

function formatCallDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const rem = seconds % 60;
  return rem > 0 ? `${mins}m ${rem}s` : `${mins}m`;
}

function getCallIcon(direction?: string | null, outcome?: string | null) {
  if (outcome === "voicemail") return <Voicemail className="w-3 h-3" />;
  if (outcome === "missed" || outcome === "cancelled") return <PhoneMissed className="w-3 h-3" />;
  if (direction === "outbound") return <PhoneOutgoing className="w-3 h-3" />;
  return <PhoneIncoming className="w-3 h-3" />;
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function getDuration(meta: Record<string, unknown>): number | null {
  if (typeof meta.duration === "number") return meta.duration;
  if (typeof meta.duration_seconds === "number") return meta.duration_seconds;
  return null;
}

function CallRowCard({ call, onCreateContact }: { call: CallRow; onCreateContact: (call: CallRow) => void }) {
  const meta = parseMetadata(call.metadata);
  const direction = typeof meta.direction === "string" ? meta.direction : null;
  const outcome = typeof meta.outcome === "string" ? meta.outcome : null;
  const duration = getDuration(meta);
  const { playableUrl, shareUrl } = resolveCallRecording(meta);
  const rep = call.userName || "System";
  const number = call.otherPartyNumber ? formatPhoneNumber(call.otherPartyNumber) : "Unknown number";

  return (
    <Card className="p-4" data-testid={`call-row-${call.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0">
          <div className="mt-0.5 text-muted-foreground">
            {getCallIcon(direction, outcome)}
          </div>
          <div className="min-w-0 space-y-1">
            <div className="flex items-center flex-wrap gap-2">
              <span className="font-medium" data-testid={`call-number-${call.id}`}>{number}</span>
              {direction && (
                <Badge variant="outline" className="gap-1 capitalize" data-testid={`call-direction-${call.id}`}>
                  {getCallIcon(direction, outcome)}
                  {direction}
                </Badge>
              )}
              {outcome && (
                <Badge
                  variant="secondary"
                  className={`capitalize ${
                    outcome === "missed" || outcome === "cancelled"
                      ? "bg-destructive/10 text-destructive"
                      : outcome === "voicemail"
                      ? "bg-chart-5/10 text-chart-5"
                      : "bg-chart-2/10 text-chart-2"
                  }`}
                  data-testid={`call-outcome-${call.id}`}
                >
                  {outcome}
                </Badge>
              )}
            </div>
            <div className="flex items-center flex-wrap gap-x-3 gap-y-1 text-sm">
              {call.contactId && call.entityName ? (
                <Link
                  href={`/contacts?open=${encodeURIComponent(call.contactId)}`}
                  className="text-primary hover:underline"
                  data-testid={`call-contact-link-${call.id}`}
                >
                  {call.entityName}
                </Link>
              ) : (
                <Badge variant="outline" className="text-muted-foreground" data-testid={`call-unassigned-${call.id}`}>
                  Unassigned
                </Badge>
              )}
              <span className="text-muted-foreground">{rep}</span>
              <span className="text-muted-foreground">{formatTimestamp(call.createdAt)}</span>
              {duration && duration > 0 && (
                <span className="text-muted-foreground">{formatCallDuration(duration)}</span>
              )}
            </div>
          </div>
        </div>
        {!call.contactId && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => onCreateContact(call)}
            data-testid={`button-create-contact-${call.id}`}
          >
            <UserPlus className="w-3 h-3" />
            Create contact
          </Button>
        )}
      </div>
      {(playableUrl || shareUrl) && (
        <div className="mt-3 space-y-1.5">
          {playableUrl && (
            <audio
              controls
              preload="none"
              className="w-full"
              src={playableUrl}
              data-testid={`audio-recording-${call.id}`}
            />
          )}
          {shareUrl && (
            <Button asChild size="sm" variant="outline" data-testid={`button-open-recording-${call.id}`}>
              <a href={shareUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="w-3 h-3" />
                Open in Dialpad
              </a>
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}

export default function Calls() {
  const [direction, setDirection] = useState<DirectionFilter>("all");
  const [assignment, setAssignment] = useState<AssignmentFilter>("all");
  const [createContactFor, setCreateContactFor] = useState<CallRow | null>(null);

  const {
    data,
    isLoading,
    isError,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    refetch,
  } = useInfiniteQuery<CallsResponse>({
    queryKey: ["/api/calls", { direction, assignment }],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) => {
      const url = new URL("/api/calls", window.location.origin);
      if (direction !== "all") url.searchParams.set("direction", direction);
      if (assignment !== "all") url.searchParams.set("assignment", assignment);
      url.searchParams.set("limit", "50");
      if (pageParam) url.searchParams.set("cursor", pageParam as string);
      const res = await apiRequest("GET", url.pathname + url.search);
      return res.json();
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });

  const calls = data?.pages.flatMap((p) => p.calls) ?? [];

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-4xl mx-auto">
      <div className="flex items-center gap-2">
        <Phone className="w-5 h-5 text-muted-foreground" />
        <h1 className="text-2xl font-semibold">Calls</h1>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Select value={direction} onValueChange={(v) => setDirection(v as DirectionFilter)}>
          <SelectTrigger className="w-40" data-testid="select-direction">
            <SelectValue placeholder="Direction" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All directions</SelectItem>
            <SelectItem value="inbound">Inbound</SelectItem>
            <SelectItem value="outbound">Outbound</SelectItem>
          </SelectContent>
        </Select>
        <Select value={assignment} onValueChange={(v) => setAssignment(v as AssignmentFilter)}>
          <SelectTrigger className="w-40" data-testid="select-assignment">
            <SelectValue placeholder="Assignment" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All calls</SelectItem>
            <SelectItem value="assigned">Assigned</SelectItem>
            <SelectItem value="unassigned">Unassigned</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </div>
      ) : isError ? (
        <Card className="p-8 text-center space-y-3">
          <p className="text-muted-foreground">Failed to load calls.</p>
          <Button variant="outline" onClick={() => refetch()} data-testid="button-retry">
            Try again
          </Button>
        </Card>
      ) : calls.length === 0 ? (
        <Card className="p-8 text-center">
          <p className="text-muted-foreground" data-testid="text-no-calls">No calls found.</p>
        </Card>
      ) : (
        <div className="space-y-3">
          {calls.map((call) => (
            <CallRowCard key={call.id} call={call} onCreateContact={setCreateContactFor} />
          ))}
          {hasNextPage && (
            <div className="flex justify-center pt-2">
              <Button
                variant="outline"
                onClick={() => fetchNextPage()}
                disabled={isFetchingNextPage}
                data-testid="button-load-more"
              >
                {isFetchingNextPage ? "Loading..." : "Load more"}
              </Button>
            </div>
          )}
        </div>
      )}

      {createContactFor && (
        <CreateContactFromCallDialog
          call={{
            id: createContactFor.id,
            phone: createContactFor.otherPartyNumber,
          }}
          onOpenChange={(open) => {
            if (!open) setCreateContactFor(null);
          }}
        />
      )}
    </div>
  );
}
