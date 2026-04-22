import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/EmptyState";
import { AlertCircle, Calendar, ChevronDown, ChevronRight, ClipboardList } from "lucide-react";
import { format } from "date-fns";
import type { ScheduledBooking } from "@shared/schema";

interface BookingHistoryProps {
  contactId: string;
}

function RawBookingPayload({ payload }: { payload: unknown }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="pt-2 border-t" data-testid="raw-booking-data-section">
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="flex items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
        data-testid="toggle-raw-booking-data"
        aria-expanded={expanded}
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0" />
        )}
        Raw Booking Data
      </button>
      {expanded && (
        <pre
          className="mt-2 p-3 rounded-md bg-muted text-xs font-mono overflow-x-auto whitespace-pre-wrap break-all leading-relaxed"
          data-testid="raw-booking-payload"
        >
          {JSON.stringify(payload, null, 2)}
        </pre>
      )}
    </div>
  );
}

export function BookingHistory({ contactId }: BookingHistoryProps) {
  const { data: bookings, isLoading, isError } = useQuery<ScheduledBooking[]>({
    queryKey: [`/api/contacts/${contactId}/bookings`],
    enabled: !!contactId,
  });

  if (isError) {
    return (
      <div className="flex items-center gap-2 py-4 text-sm text-destructive" data-testid="booking-history-error">
        <AlertCircle className="h-4 w-4 shrink-0" />
        <span>Unable to load booking history.</span>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="space-y-4" data-testid="booking-history-loading">
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-28 w-full" />
      </div>
    );
  }

  if (!bookings || bookings.length === 0) {
    return (
      <EmptyState
        icon={ClipboardList}
        title="No bookings"
        description="This contact has no scheduled bookings yet."
        data-testid="booking-history-empty"
      />
    );
  }

  return (
    <div className="space-y-4" data-testid="booking-history-list">
      {bookings.map((booking) => (
        <Card key={booking.id} data-testid={`booking-card-${booking.id}`}>
          <CardHeader className="pb-2">
            <div className="flex items-start justify-between gap-2 flex-wrap">
              <CardTitle className="text-sm font-medium">
                <div className="flex items-center gap-2">
                  <Calendar className="h-4 w-4 text-muted-foreground shrink-0" />
                  {format(new Date(booking.startTime), "PPP 'at' p")}
                </div>
              </CardTitle>
              <Badge
                variant={
                  booking.status === "confirmed" ? "default" :
                  booking.status === "completed" ? "secondary" :
                  booking.status === "cancelled" ? "destructive" :
                  "outline"
                }
                data-testid={`booking-status-${booking.id}`}
              >
                {booking.status}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-2">
            {booking.title && (
              <p className="text-sm" data-testid={`booking-title-${booking.id}`}>{booking.title}</p>
            )}
            {booking.notes && (
              <p className="text-sm text-muted-foreground" data-testid={`booking-notes-${booking.id}`}>{booking.notes}</p>
            )}
            {booking.bookingPayload !== null && booking.bookingPayload !== undefined ? (
              <RawBookingPayload payload={booking.bookingPayload} />
            ) : (
              <p className="text-xs text-muted-foreground pt-2 border-t" data-testid={`booking-no-payload-${booking.id}`}>
                No payload recorded
              </p>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
