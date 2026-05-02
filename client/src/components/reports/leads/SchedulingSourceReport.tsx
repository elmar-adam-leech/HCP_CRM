import { useMemo, useState } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { format } from "date-fns";
import type { DateRange } from "react-day-picker";
import { CalendarIcon, Info } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";

type RangePreset = "7d" | "30d" | "90d" | "year" | "custom";

interface DailyPoint {
  date: string;
  selfBooked: number;
  salespersonBooked: number;
}

interface SalespersonRow {
  userId: string | null;
  name: string;
  bookings: number;
}

interface ReportData {
  range: { start: string; end: string };
  timezone: string;
  totals: {
    total: number;
    selfBooked: number;
    salespersonBooked: number;
    selfBookedPct: number;
    salespersonBookedPct: number;
  };
  daily: DailyPoint[];
  bySalesperson: SalespersonRow[];
}

const PRESETS: { value: Exclude<RangePreset, "custom">; label: string; days: number | "year" }[] = [
  { value: "7d", label: "Last 7 days", days: 7 },
  { value: "30d", label: "Last 30 days", days: 30 },
  { value: "90d", label: "Last 90 days", days: 90 },
  { value: "year", label: "This year", days: "year" },
];

const PRESET_OPTIONS: { value: RangePreset; label: string }[] = [
  ...PRESETS.map((p) => ({ value: p.value as RangePreset, label: p.label })),
  { value: "custom", label: "Custom range" },
];

const SELF_COLOR = "hsl(217 91% 60%)";
const SALES_COLOR = "hsl(142 71% 45%)";

function rangeFromPreset(preset: Exclude<RangePreset, "custom">): { startDate: string; endDate: string } {
  const end = new Date();
  let start: Date;
  if (preset === "year") {
    start = new Date(end.getFullYear(), 0, 1);
  } else {
    const days = PRESETS.find((p) => p.value === preset)!.days as number;
    start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  }
  return { startDate: start.toISOString(), endDate: end.toISOString() };
}

function rangeFromCustom(range: DateRange | undefined): { startDate: string; endDate: string } | null {
  if (!range?.from || !range?.to) return null;
  const start = new Date(range.from);
  start.setHours(0, 0, 0, 0);
  const end = new Date(range.to);
  end.setHours(23, 59, 59, 999);
  if (end.getTime() < start.getTime()) return null;
  return { startDate: start.toISOString(), endDate: end.toISOString() };
}

function formatDateLabel(iso: string): string {
  // `iso` here is a YYYY-MM-DD bucket; parse as a local-noon date to dodge tz
  // off-by-ones in the display layer.
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  const dt = new Date(y, m - 1, d, 12);
  return format(dt, "MMM d");
}

export function SchedulingSourceReport() {
  const [preset, setPreset] = useState<RangePreset>("30d");
  const [customRange, setCustomRange] = useState<DateRange | undefined>(undefined);

  const customRangeResolved = useMemo(
    () => (preset === "custom" ? rangeFromCustom(customRange) : null),
    [preset, customRange],
  );

  const customRangeError = useMemo(() => {
    if (preset !== "custom") return null;
    if (!customRange?.from || !customRange?.to) return "Select a start and end date.";
    if (customRange.to.getTime() < customRange.from.getTime()) {
      return "End date must be on or after start date.";
    }
    return null;
  }, [preset, customRange]);

  const resolvedRange = useMemo(() => {
    if (preset === "custom") return customRangeResolved;
    return rangeFromPreset(preset);
  }, [preset, customRangeResolved]);

  const startDate = resolvedRange?.startDate ?? "";
  const endDate = resolvedRange?.endDate ?? "";

  const { data, isLoading, isError } = useQuery<ReportData>({
    queryKey: ["/api/reports/leads/scheduling-source", startDate, endDate],
    queryFn: async () => {
      const url = `/api/reports/leads/scheduling-source?startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}`;
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load Self-Scheduled vs Sales-Scheduled report");
      return res.json();
    },
    enabled: resolvedRange !== null,
    staleTime: 2 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    placeholderData: keepPreviousData,
  });

  const chartData = useMemo(
    () =>
      (data?.daily ?? []).map((d) => ({
        date: d.date,
        label: formatDateLabel(d.date),
        selfBooked: d.selfBooked,
        salespersonBooked: d.salespersonBooked,
      })),
    [data],
  );

  return (
    <Card data-testid="card-scheduling-source-report">
      <CardHeader className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CardTitle>Self-Scheduled vs Sales-Scheduled</CardTitle>
          <CardDescription>
            How many bookings come from your public booking link versus a
            salesperson scheduling on the customer's behalf.
          </CardDescription>
        </div>
        <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-start">
          <Select value={preset} onValueChange={(v) => setPreset(v as RangePreset)}>
            <SelectTrigger className="w-[180px]" data-testid="select-scheduling-source-range">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PRESET_OPTIONS.map((p) => (
                <SelectItem key={p.value} value={p.value}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {preset === "custom" && (
            <div className="flex flex-col gap-1">
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    className={cn(
                      "w-[260px] justify-start text-left font-normal",
                      !customRange?.from && "text-muted-foreground",
                    )}
                    data-testid="button-scheduling-source-custom-range"
                  >
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {customRange?.from ? (
                      customRange.to ? (
                        <>
                          {format(customRange.from, "LLL d, y")} – {format(customRange.to, "LLL d, y")}
                        </>
                      ) : (
                        format(customRange.from, "LLL d, y")
                      )
                    ) : (
                      "Pick a date range"
                    )}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="end">
                  <Calendar
                    mode="range"
                    selected={customRange}
                    onSelect={setCustomRange}
                    numberOfMonths={2}
                    initialFocus
                  />
                </PopoverContent>
              </Popover>
              {customRangeError && (
                <p
                  className="text-xs text-destructive"
                  data-testid="text-scheduling-source-range-error"
                >
                  {customRangeError}
                </p>
              )}
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {!resolvedRange ? (
          <p
            className="text-sm text-muted-foreground"
            data-testid="text-scheduling-source-pick-range"
          >
            Pick a start and end date to see the report.
          </p>
        ) : isLoading ? (
          <>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-24 w-full" />
              ))}
            </div>
            <Skeleton className="h-[280px] w-full" />
            <Skeleton className="h-[200px] w-full" />
          </>
        ) : isError ? (
          <p className="text-sm text-destructive" data-testid="text-scheduling-source-error">
            Could not load report. Please try again.
          </p>
        ) : !data || data.totals.total === 0 ? (
          <p
            className="text-sm text-muted-foreground"
            data-testid="text-scheduling-source-empty"
          >
            No bookings in this range yet. Try a wider date range.
          </p>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <Stat
                label="Total bookings"
                value={data.totals.total.toString()}
                hint="All bookings created in range."
                testId="stat-scheduling-source-total"
              />
              <Stat
                label="Self-scheduled"
                value={data.totals.selfBooked.toString()}
                hint={`${data.totals.selfBookedPct.toFixed(1)}% via public booking link`}
                accent={SELF_COLOR}
                testId="stat-scheduling-source-self"
              />
              <Stat
                label="Scheduled by salesperson"
                value={data.totals.salespersonBooked.toString()}
                hint={`${data.totals.salespersonBookedPct.toFixed(1)}% scheduled by your team`}
                accent={SALES_COLOR}
                testId="stat-scheduling-source-sales"
              />
            </div>

            <div className="flex items-center gap-2 rounded-md border bg-muted/50 p-3 text-xs text-muted-foreground">
              <Info className="h-3.5 w-3.5 shrink-0" />
              <span>
                Each booking counts once toward the day it was created. Cancellations
                are not subtracted. Days are bucketed in {data.timezone}.
              </span>
            </div>

            <div className="h-[300px] w-full" data-testid="chart-scheduling-source-daily">
              <ResponsiveContainer>
                <BarChart data={chartData} margin={{ top: 10, right: 16, bottom: 0, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis
                    dataKey="label"
                    className="text-xs"
                    tick={{ fill: "hsl(var(--muted-foreground))" }}
                    interval="preserveStartEnd"
                    minTickGap={24}
                  />
                  <YAxis
                    className="text-xs"
                    tick={{ fill: "hsl(var(--muted-foreground))" }}
                    allowDecimals={false}
                  />
                  <Tooltip content={<DailyTooltip />} />
                  <Legend />
                  <Bar
                    dataKey="selfBooked"
                    name="Self-scheduled"
                    stackId="src"
                    fill={SELF_COLOR}
                  />
                  <Bar
                    dataKey="salespersonBooked"
                    name="Scheduled by salesperson"
                    stackId="src"
                    fill={SALES_COLOR}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>

            <div>
              <h3 className="mb-3 text-sm font-semibold">
                Bookings assisted by salesperson
              </h3>
              {data.bySalesperson.length === 0 ? (
                <p
                  className="text-sm text-muted-foreground"
                  data-testid="text-scheduling-source-by-sp-empty"
                >
                  No salesperson-scheduled bookings in this range.
                </p>
              ) : (
                <div className="rounded-md border">
                  <Table data-testid="table-scheduling-source-by-salesperson">
                    <TableHeader>
                      <TableRow>
                        <TableHead>Salesperson</TableHead>
                        <TableHead className="text-right">Bookings</TableHead>
                        <TableHead className="text-right">% of assisted</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.bySalesperson.map((row) => {
                        const pct =
                          data.totals.salespersonBooked > 0
                            ? (row.bookings / data.totals.salespersonBooked) * 100
                            : 0;
                        return (
                          <TableRow
                            key={row.userId ?? "unassigned"}
                            data-testid={`row-scheduling-source-sp-${row.userId ?? "unassigned"}`}
                          >
                            <TableCell>{row.name}</TableCell>
                            <TableCell className="text-right tabular-nums">
                              {row.bookings}
                            </TableCell>
                            <TableCell className="text-right tabular-nums text-muted-foreground">
                              {pct.toFixed(1)}%
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({
  label,
  value,
  hint,
  accent,
  testId,
}: {
  label: string;
  value: string;
  hint?: string;
  accent?: string;
  testId: string;
}) {
  return (
    <div className="rounded-md border p-3" data-testid={testId}>
      <div className="flex items-center gap-2">
        {accent && (
          <span
            className="inline-block h-2 w-2 rounded-sm"
            style={{ backgroundColor: accent }}
          />
        )}
        <div className="text-xs text-muted-foreground">{label}</div>
      </div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

interface TooltipPayloadEntry {
  name?: string;
  dataKey?: string | number;
  value?: number;
  color?: string;
  payload?: { date?: string; label?: string; selfBooked?: number; salespersonBooked?: number };
}

function DailyTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: TooltipPayloadEntry[];
}) {
  if (!active || !payload || payload.length === 0) return null;
  const row = payload[0]?.payload;
  const total = (row?.selfBooked ?? 0) + (row?.salespersonBooked ?? 0);
  return (
    <div
      className="rounded-md border bg-background p-2 text-xs shadow-sm"
      data-testid="tooltip-scheduling-source-daily"
    >
      <div className="mb-1 font-semibold">{row?.label ?? row?.date}</div>
      <div className="mb-1 text-muted-foreground">{total} booking{total === 1 ? "" : "s"}</div>
      <div className="flex flex-col gap-0.5">
        {payload.map((entry) => (
          <div key={String(entry.dataKey)} className="flex items-center gap-2">
            <span
              className="inline-block h-2 w-2 rounded-sm"
              style={{ backgroundColor: entry.color }}
            />
            <span className="flex-1">{entry.name}</span>
            <span className="tabular-nums">{entry.value ?? 0}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
