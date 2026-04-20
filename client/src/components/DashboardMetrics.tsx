import { useState, useEffect, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Clock, Target, Users, Calendar as CalendarIcon, AlertCircle } from "lucide-react";
import { format } from "date-fns";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { CardSkeleton } from "@/components/CardSkeleton";

type MetricCardProps = {
  title: string;
  value: string | number;
  icon: React.ReactNode;
  description?: string;
  unit?: string;
  subnote?: string;
};

function MetricCard({ title, value, icon, description, unit, subnote }: MetricCardProps) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        <div className="text-muted-foreground">{icon}</div>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">
          {value}
          {unit && <span className="text-lg text-muted-foreground ml-1">{unit}</span>}
        </div>
        {description && (
          <p className="text-xs text-muted-foreground mt-1">{description}</p>
        )}
        {subnote && (
          <p className="text-xs text-muted-foreground mt-1">{subnote}</p>
        )}
      </CardContent>
    </Card>
  );
}

type Timeframe = "this_week" | "this_month" | "this_year" | "custom";

export function DashboardMetrics() {
  const [timeframe, setTimeframe] = useState<Timeframe>("this_month");
  const [customStartDate, setCustomStartDate] = useState<Date>();
  const [customEndDate, setCustomEndDate] = useState<Date>();
  const [datePickerMode, setDatePickerMode] = useState<"start" | "end">("start");

  const queryParams = new URLSearchParams();
  queryParams.set("timeframe", timeframe);
  if (timeframe === "custom" && customStartDate && customEndDate) {
    queryParams.set("startDate", customStartDate.toISOString());
    queryParams.set("endDate", customEndDate.toISOString());
  }

  const { data: metrics, isLoading, isError, refetch } = useQuery<{
    speedToLeadMinutes: number;
    setRate: number;
    totalLeads: number;
    todaysFollowUps: number;
    disqualifiedCount: number;
  }>({
    queryKey: ['/api/dashboard/metrics', timeframe, customStartDate, customEndDate],
    queryFn: async () => {
      const response = await fetch(`/api/dashboard/metrics?${queryParams.toString()}`);
      if (!response.ok) {
        throw new Error('Failed to fetch metrics');
      }
      return response.json();
    },
    // Refresh every 5 minutes, but only while the tab is visible
    refetchInterval: 5 * 60_000,
    refetchIntervalInBackground: false,
  });

  // Immediately refetch when the user returns to the tab after it was hidden
  const refetchRef = useRef(refetch);
  refetchRef.current = refetch;
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refetchRef.current();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []);

  const formatSpeedToLead = (minutes: number) => {
    if (minutes === 0) return "N/A";
    if (minutes < 60) return `${Math.round(minutes)}m`;
    const hours = Math.floor(minutes / 60);
    const mins = Math.round(minutes % 60);
    return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  };

  const getTimeframeLabel = () => {
    if (timeframe === "custom" && customStartDate && customEndDate) {
      return `${format(customStartDate, "MMM d")} - ${format(customEndDate, "MMM d, yyyy")}`;
    }
    switch (timeframe) {
      case "this_week":
        return "This Week";
      case "this_month":
        return "This Month";
      case "this_year":
        return "This Year";
      default:
        return "Select timeframe";
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Performance Metrics</h2>
          <p className="text-sm text-muted-foreground">
            {getTimeframeLabel()}
          </p>
        </div>
        <div className="flex gap-2">
          <Select value={timeframe} onValueChange={(value) => setTimeframe(value as Timeframe)}>
            <SelectTrigger className="w-[160px]" data-testid="select-timeframe">
              <SelectValue placeholder="Select timeframe" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="this_week" data-testid="timeframe-this-week">This Week</SelectItem>
              <SelectItem value="this_month" data-testid="timeframe-this-month">This Month</SelectItem>
              <SelectItem value="this_year" data-testid="timeframe-this-year">This Year</SelectItem>
              <SelectItem value="custom" data-testid="timeframe-custom">Custom Range</SelectItem>
            </SelectContent>
          </Select>

          {timeframe === "custom" && (
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  className={cn(
                    "w-[240px] justify-start text-left font-normal",
                    !customStartDate && !customEndDate && "text-muted-foreground"
                  )}
                  data-testid="button-custom-date-range"
                >
                  <CalendarIcon className="mr-2 h-4 w-4" />
                  {customStartDate && customEndDate ? (
                    <>
                      {format(customStartDate, "MMM d")} - {format(customEndDate, "MMM d, yyyy")}
                    </>
                  ) : (
                    <span>Pick a date range</span>
                  )}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="end">
                <div className="p-3 space-y-3">
                  <div className="flex gap-2">
                    <Button
                      variant={datePickerMode === "start" ? "default" : "outline"}
                      size="sm"
                      onClick={() => setDatePickerMode("start")}
                      className="flex-1"
                      data-testid="button-select-start-date"
                    >
                      {customStartDate ? format(customStartDate, "MMM d, yyyy") : "Start Date"}
                    </Button>
                    <Button
                      variant={datePickerMode === "end" ? "default" : "outline"}
                      size="sm"
                      onClick={() => setDatePickerMode("end")}
                      className="flex-1"
                      data-testid="button-select-end-date"
                    >
                      {customEndDate ? format(customEndDate, "MMM d, yyyy") : "End Date"}
                    </Button>
                  </div>
                  <Calendar
                    mode="single"
                    selected={datePickerMode === "start" ? customStartDate : customEndDate}
                    onSelect={(date) => {
                      if (datePickerMode === "start") {
                        setCustomStartDate(date);
                        // Auto-switch to end date if both aren't set
                        if (date && !customEndDate) {
                          setDatePickerMode("end");
                        }
                      } else {
                        setCustomEndDate(date);
                      }
                    }}
                    disabled={(date) => {
                      if (datePickerMode === "start") {
                        return date > new Date() || (customEndDate ? date > customEndDate : false);
                      } else {
                        return date > new Date() || (customStartDate ? date < customStartDate : false);
                      }
                    }}
                  />
                </div>
              </PopoverContent>
            </Popover>
          )}
        </div>
      </div>

      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-1 md:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <CardSkeleton key={i} lines={1} />
          ))}
        </div>
      ) : isError ? (
        <div className="flex flex-col items-center gap-3 py-8 text-sm text-destructive" data-testid="metrics-error">
          <div className="flex items-center gap-2">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>Unable to load metrics.</span>
          </div>
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            Retry
          </Button>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-1 md:grid-cols-2 lg:grid-cols-4" data-testid="dashboard-metrics">
          <MetricCard
            title="Speed To Lead"
            value={formatSpeedToLead(metrics?.speedToLeadMinutes ?? 0)}
            icon={<Clock className="h-4 w-4" />}
            description="Avg. time to first contact"
          />
          <MetricCard
            title="Set Rate"
            value={metrics?.setRate ?? 0}
            unit="%"
            icon={<Target className="h-4 w-4" />}
            description="Appointments set / Qualified leads"
          />
          <MetricCard
            title="Total Leads"
            value={metrics?.totalLeads ?? 0}
            icon={<Users className="h-4 w-4" />}
            description="Leads in timeframe"
            subnote={metrics?.disqualifiedCount ? `* ${metrics.disqualifiedCount} disqualified` : undefined}
          />
          <MetricCard
            title="Today's Follow Ups"
            value={metrics?.todaysFollowUps ?? 0}
            icon={<CalendarIcon className="h-4 w-4" />}
            description="Follow ups scheduled for today"
          />
        </div>
      )}
    </div>
  );
}
