import { useMemo, useState } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { format } from "date-fns";
import type { DateRange } from "react-day-picker";
import { CalendarIcon, PhoneOff, UserCog } from "lucide-react";
import { Link } from "wouter";
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
import { ArrowUpDown } from "lucide-react";

type RangePreset = "7d" | "30d" | "90d" | "year" | "custom";

interface DistributionBuckets {
  lt5m: number;
  lt15m: number;
  lt1h: number;
  lt4h: number;
  lt24h: number;
  gte24h: number;
}

interface SalespersonRow {
  userId: string;
  name: string;
  leadsCalled: number;
  medianMinutesToFirstCall: number;
  averageMinutesToFirstCall: number;
  averageCallsPerLead: number;
  averageCallsPerScheduledLead: number | null;
  averageCallsPerScheduledLeadNonSelfBook: number | null;
  scheduledLeadsCalled: number;
  scheduledLeadsCalledNonSelfBook: number;
  distribution: DistributionBuckets;
}

type SpeedToLeadEmptyReason =
  | "no_calls_ever"
  | "no_calls_in_range"
  | "no_lead_calls_in_range"
  | "no_salespeople_flagged";

interface SpeedToLeadReportData {
  range: { start: string; end: string };
  salespeople: SalespersonRow[];
  totals: Omit<SalespersonRow, "userId" | "name">;
  emptyReason: SpeedToLeadEmptyReason | null;
}

type SortKey =
  | "name"
  | "leadsCalled"
  | "medianMinutesToFirstCall"
  | "averageMinutesToFirstCall"
  | "averageCallsPerLead"
  | "averageCallsPerScheduledLead"
  | "averageCallsPerScheduledLeadNonSelfBook";

interface SortState {
  key: SortKey;
  direction: "asc" | "desc";
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

const BUCKETS: { key: keyof DistributionBuckets; label: string; color: string }[] = [
  { key: "lt5m", label: "<5m", color: "hsl(142 71% 45%)" },
  { key: "lt15m", label: "5–15m", color: "hsl(160 60% 50%)" },
  { key: "lt1h", label: "15m–1h", color: "hsl(48 96% 53%)" },
  { key: "lt4h", label: "1–4h", color: "hsl(28 95% 55%)" },
  { key: "lt24h", label: "4–24h", color: "hsl(15 80% 55%)" },
  { key: "gte24h", label: ">24h", color: "hsl(0 75% 55%)" },
];

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

function formatMinutes(mins: number): string {
  if (!Number.isFinite(mins) || mins <= 0) return "—";
  if (mins < 1) return "<1m";
  if (mins < 60) return `${Math.round(mins)}m`;
  const h = Math.floor(mins / 60);
  const m = Math.round(mins - h * 60);
  if (h < 24) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const remH = h - d * 24;
  return remH > 0 ? `${d}d ${remH}h` : `${d}d`;
}

function formatNumber(n: number | null, digits = 1): string {
  if (n === null || !Number.isFinite(n)) return "—";
  return n.toFixed(digits);
}

function compare(a: number | string | null, b: number | string | null, dir: "asc" | "desc"): number {
  const aIsNull = a === null || a === undefined;
  const bIsNull = b === null || b === undefined;
  if (aIsNull && bIsNull) return 0;
  if (aIsNull) return 1;
  if (bIsNull) return -1;
  let cmp = 0;
  if (typeof a === "string" && typeof b === "string") {
    cmp = a.localeCompare(b);
  } else {
    cmp = (a as number) - (b as number);
  }
  return dir === "asc" ? cmp : -cmp;
}

export function SpeedToLeadReport() {
  const [preset, setPreset] = useState<RangePreset>("30d");
  const [customRange, setCustomRange] = useState<DateRange | undefined>(undefined);
  const [sort, setSort] = useState<SortState>({
    key: "medianMinutesToFirstCall",
    direction: "asc",
  });

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

  const { data, isLoading, isError } = useQuery<SpeedToLeadReportData>({
    queryKey: ["/api/reports/speed-to-lead", startDate, endDate],
    queryFn: async () => {
      const url = `/api/reports/speed-to-lead?startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}`;
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load Speed to Lead report");
      return res.json();
    },
    enabled: resolvedRange !== null,
    // Match the estimates reports' caching behavior: keep prior numbers on
    // screen while a new range loads, and don't refetch within 2 minutes.
    staleTime: 2 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    placeholderData: keepPreviousData,
  });

  const sortedRows = useMemo(() => {
    if (!data?.salespeople) return [];
    const rows = [...data.salespeople];
    rows.sort((a, b) => compare(a[sort.key], b[sort.key], sort.direction));
    return rows;
  }, [data, sort]);

  const chartData = useMemo(
    () =>
      sortedRows.map((row) => ({
        name: row.name,
        ...row.distribution,
      })),
    [sortedRows],
  );

  const toggleSort = (key: SortKey) => {
    setSort((prev) => {
      if (prev.key === key) {
        return { key, direction: prev.direction === "asc" ? "desc" : "asc" };
      }
      // Default direction depends on what makes intuitive sense per column.
      const desc: SortKey[] = [
        "leadsCalled",
        "averageCallsPerLead",
        "averageCallsPerScheduledLead",
        "averageCallsPerScheduledLeadNonSelfBook",
      ];
      return { key, direction: desc.includes(key) ? "desc" : "asc" };
    });
  };

  return (
    <Card data-testid="card-speed-to-lead-report">
      <CardHeader className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CardTitle>Speed to Lead by Salesperson</CardTitle>
          <CardDescription>
            How quickly each salesperson reaches new leads, and how many calls it takes.
          </CardDescription>
        </div>
        <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-start">
          <Select value={preset} onValueChange={(v) => setPreset(v as RangePreset)}>
            <SelectTrigger className="w-[180px]" data-testid="select-speed-to-lead-range">
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
                    data-testid="button-speed-to-lead-custom-range"
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
                  data-testid="text-speed-to-lead-range-error"
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
            data-testid="text-speed-to-lead-pick-range"
          >
            Pick a start and end date to see the report.
          </p>
        ) : isLoading ? (
          <>
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-20 w-full" />
              ))}
            </div>
            <Skeleton className="h-[280px] w-full" />
            <Skeleton className="h-[200px] w-full" />
          </>
        ) : isError ? (
          <p className="text-sm text-destructive" data-testid="text-speed-to-lead-error">
            Could not load report. Please try again.
          </p>
        ) : !data || data.salespeople.length === 0 ? (
          data?.emptyReason === "no_calls_ever" ? (
            <div
              className="flex flex-col items-start gap-3 rounded-md border p-6"
              data-testid="empty-state-no-calls-ever"
            >
              <div className="flex items-center gap-2">
                <PhoneOff className="h-5 w-5 text-muted-foreground" />
                <h3 className="text-base font-semibold">
                  We haven't received any calls from your phone system.
                </h3>
              </div>
              <p className="text-sm text-muted-foreground">
                This report uses calls logged from Dialpad. Your call subscriptions
                may be missing or misconfigured.
              </p>
              <Link href="/dialpad/health">
                <Button variant="default" data-testid="button-open-dialpad-health">
                  Open Dialpad Health
                </Button>
              </Link>
              <p className="text-xs text-muted-foreground">
                If you don't use Dialpad for calls, this report won't show data.
              </p>
            </div>
          ) : data?.emptyReason === "no_calls_in_range" ? (
            <p
              className="text-sm text-muted-foreground"
              data-testid="text-speed-to-lead-empty-no-calls-in-range"
            >
              No calls were logged in this range. Try a wider date range or
              confirm your salespeople were active.
            </p>
          ) : data?.emptyReason === "no_salespeople_flagged" ? (
            <div
              className="flex flex-col items-start gap-3 rounded-md border p-6"
              data-testid="empty-state-no-salespeople-flagged"
            >
              <div className="flex items-center gap-2">
                <UserCog className="h-5 w-5 text-muted-foreground" />
                <h3 className="text-base font-semibold">
                  No team members are flagged as salespeople yet.
                </h3>
              </div>
              <p className="text-sm text-muted-foreground">
                Calls were logged in this range, but this report only counts
                calls made by users marked as salespeople. Flag at least one
                team member as a salesperson to start seeing data here.
              </p>
              <Link href="/settings?tab=salespeople">
                <Button variant="default" data-testid="button-open-salespeople-settings">
                  Open Salespeople settings
                </Button>
              </Link>
            </div>
          ) : (
            <p
              className="text-sm text-muted-foreground"
              data-testid="text-speed-to-lead-empty"
            >
              No called leads in this range yet. Try a wider date range.
            </p>
          )
        ) : (
          <>
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              <Stat
                label="Leads called"
                value={data.totals.leadsCalled.toString()}
                testId="stat-totals-leads-called"
              />
              <Stat
                label="Median speed"
                value={formatMinutes(data.totals.medianMinutesToFirstCall)}
                testId="stat-totals-median"
              />
              <Stat
                label="Avg speed"
                value={formatMinutes(data.totals.averageMinutesToFirstCall)}
                testId="stat-totals-avg"
              />
              <Stat
                label="Avg calls / lead"
                value={formatNumber(data.totals.averageCallsPerLead)}
                testId="stat-totals-avg-calls"
              />
            </div>

            <div className="overflow-x-auto">
              <Table data-testid="table-speed-to-lead">
                <TableHeader>
                  <TableRow>
                    <SortHeader
                      label="Salesperson"
                      sortKey="name"
                      sort={sort}
                      onSort={toggleSort}
                    />
                    <SortHeader
                      label="Leads called"
                      sortKey="leadsCalled"
                      sort={sort}
                      onSort={toggleSort}
                      align="right"
                    />
                    <SortHeader
                      label="Median speed"
                      sortKey="medianMinutesToFirstCall"
                      sort={sort}
                      onSort={toggleSort}
                      align="right"
                    />
                    <SortHeader
                      label="Avg speed"
                      sortKey="averageMinutesToFirstCall"
                      sort={sort}
                      onSort={toggleSort}
                      align="right"
                    />
                    <SortHeader
                      label="Avg calls / lead"
                      sortKey="averageCallsPerLead"
                      sort={sort}
                      onSort={toggleSort}
                      align="right"
                    />
                    <SortHeader
                      label="Avg calls / scheduled"
                      sortKey="averageCallsPerScheduledLead"
                      sort={sort}
                      onSort={toggleSort}
                      align="right"
                    />
                    <SortHeader
                      label="Avg calls / scheduled (excl. self-book)"
                      sortKey="averageCallsPerScheduledLeadNonSelfBook"
                      sort={sort}
                      onSort={toggleSort}
                      align="right"
                    />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sortedRows.map((row) => (
                    <TableRow key={row.userId} data-testid={`row-salesperson-${row.userId}`}>
                      <TableCell className="font-medium">{row.name}</TableCell>
                      <TableCell className="text-right">{row.leadsCalled}</TableCell>
                      <TableCell className="text-right">
                        {formatMinutes(row.medianMinutesToFirstCall)}
                      </TableCell>
                      <TableCell className="text-right">
                        {formatMinutes(row.averageMinutesToFirstCall)}
                      </TableCell>
                      <TableCell className="text-right">
                        {formatNumber(row.averageCallsPerLead)}
                      </TableCell>
                      <TableCell className="text-right">
                        <div>{formatNumber(row.averageCallsPerScheduledLead)}</div>
                        <div className="text-xs text-muted-foreground">
                          n={row.scheduledLeadsCalled}
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        <div>
                          {formatNumber(row.averageCallsPerScheduledLeadNonSelfBook)}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          n={row.scheduledLeadsCalledNonSelfBook}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            <div className="h-[300px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis
                    dataKey="name"
                    className="text-xs"
                    tick={{ fill: "hsl(var(--muted-foreground))" }}
                  />
                  <YAxis
                    className="text-xs"
                    tick={{ fill: "hsl(var(--muted-foreground))" }}
                    allowDecimals={false}
                  />
                  <Tooltip content={<DistributionTooltip />} />
                  <Legend />
                  {BUCKETS.map((b) => (
                    <Bar
                      key={b.key}
                      dataKey={b.key}
                      name={b.label}
                      stackId="speed"
                      fill={b.color}
                    />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <div className="rounded-md border p-3" data-testid={testId}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-2xl font-semibold">{value}</div>
    </div>
  );
}

interface TooltipPayloadEntry {
  name?: string;
  dataKey?: string | number;
  value?: number;
  color?: string;
  payload?: { name?: string } & Partial<DistributionBuckets>;
}

function DistributionTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: TooltipPayloadEntry[];
  label?: string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const row = payload[0]?.payload as (Partial<DistributionBuckets> & { name?: string }) | undefined;
  const total =
    (row?.lt5m ?? 0) +
    (row?.lt15m ?? 0) +
    (row?.lt1h ?? 0) +
    (row?.lt4h ?? 0) +
    (row?.lt24h ?? 0) +
    (row?.gte24h ?? 0);
  return (
    <div
      className="rounded-md border bg-background p-2 text-xs shadow-sm"
      data-testid="tooltip-distribution"
    >
      <div className="mb-1 font-semibold">{row?.name ?? label}</div>
      <div className="mb-1 text-muted-foreground">{total} leads called</div>
      <div className="flex flex-col gap-0.5">
        {payload.map((entry) => {
          const count = entry.value ?? 0;
          const pct = total > 0 ? (count / total) * 100 : 0;
          return (
            <div key={String(entry.dataKey)} className="flex items-center gap-2">
              <span
                className="inline-block h-2 w-2 rounded-sm"
                style={{ backgroundColor: entry.color }}
              />
              <span className="flex-1">{entry.name}</span>
              <span className="tabular-nums">
                {count} ({pct.toFixed(0)}%)
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SortHeader({
  label,
  sortKey,
  sort,
  onSort,
  align,
}: {
  label: string;
  sortKey: SortKey;
  sort: SortState;
  onSort: (key: SortKey) => void;
  align?: "right";
}) {
  const isActive = sort.key === sortKey;
  return (
    <TableHead className={align === "right" ? "text-right" : undefined}>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => onSort(sortKey)}
        className={align === "right" ? "ml-auto" : undefined}
        data-testid={`sort-${sortKey}`}
      >
        {label}
        <ArrowUpDown
          className={`ml-2 h-3 w-3 ${isActive ? "opacity-100" : "opacity-40"}`}
        />
      </Button>
    </TableHead>
  );
}
