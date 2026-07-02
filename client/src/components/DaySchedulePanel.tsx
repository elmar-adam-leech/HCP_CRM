import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { apiRequest } from "@/lib/queryClient";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertCircle, CalendarClock, Lock } from "lucide-react";

export interface CalendarEvent {
  source: "crm" | "google";
  id: string;
  title: string;
  start: string;
  end: string;
  salespersonId: string | null;
  salespersonName: string | null;
  status?: string | null;
  customerName?: string | null;
}

interface DayScheduleResponse {
  startDate: string;
  endDate: string;
  events: CalendarEvent[];
}

interface DaySchedulePanelProps {
  date: Date | undefined;
  salespersonId?: string;
  /** When true, event rows show the salesperson name (all-team view). */
  showSalespersonName?: boolean;
}

/**
 * Read-only unified day schedule (task #861). Shows CRM-native bookings next to
 * connected reps' external Google Calendar busy blocks so a booker can spot
 * double-booking at a glance. Google entries are opaque "Busy" blocks (no
 * details) to preserve teammates' event privacy.
 */
export function DaySchedulePanel({ date, salespersonId, showSalespersonName }: DaySchedulePanelProps) {
  const formattedDate = date ? format(date, "yyyy-MM-dd") : "";

  const { data, isLoading, isError } = useQuery<DayScheduleResponse>({
    queryKey: ["/api/scheduling/day-schedule", formattedDate, salespersonId ?? ""],
    queryFn: async () => {
      if (!date) throw new Error("No date selected");
      const startOfDay = new Date(date);
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(date);
      endOfDay.setHours(23, 59, 59, 999);
      const params = new URLSearchParams({
        startDate: startOfDay.toISOString(),
        endDate: endOfDay.toISOString(),
      });
      if (salespersonId) params.set("salespersonId", salespersonId);
      const resp = await apiRequest("GET", `/api/scheduling/day-schedule?${params.toString()}`);
      return resp.json();
    },
    enabled: !!date,
    staleTime: 30000,
  });

  if (!date) return null;

  const events = data?.events ?? [];

  return (
    <div className="space-y-3" data-testid="day-schedule-panel">
      <div className="flex items-center gap-2 flex-wrap">
        <CalendarClock className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">
          Schedule for {format(date, "EEE, MMM d")}
        </span>
      </div>

      {isError ? (
        <div className="flex items-center gap-2 py-2 text-sm text-destructive" data-testid="day-schedule-error">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>Unable to load the day's schedule.</span>
        </div>
      ) : isLoading ? (
        <div className="space-y-2" data-testid="day-schedule-loading">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : events.length === 0 ? (
        <p className="text-sm text-muted-foreground py-2" data-testid="day-schedule-empty">
          No appointments or busy times on this day.
        </p>
      ) : (
        <div className="space-y-2" data-testid="day-schedule-list">
          {events.map((event) => {
            const isGoogle = event.source === "google";
            return (
              <div
                key={event.id}
                className="flex items-start justify-between gap-3 rounded-md border p-2.5"
                data-testid={`day-schedule-event-${event.id}`}
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    {isGoogle && <Lock className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
                    <span className="truncate">
                      {isGoogle ? "Busy" : event.title}
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {format(new Date(event.start), "p")} – {format(new Date(event.end), "p")}
                  </div>
                  {showSalespersonName && event.salespersonName && (
                    <div className="text-xs text-muted-foreground truncate">
                      {event.salespersonName}
                    </div>
                  )}
                </div>
                <Badge
                  variant={isGoogle ? "outline" : "secondary"}
                  className="shrink-0"
                  data-testid={`day-schedule-source-${event.id}`}
                >
                  {isGoogle ? "Google Calendar" : "CRM"}
                </Badge>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
