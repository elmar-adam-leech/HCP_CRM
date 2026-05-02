import { Fragment, useMemo, useState } from "react";
import { Link } from "wouter";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { format } from "date-fns";
import type { DateRange } from "react-day-picker";
import { CalendarIcon, ChevronDown, ChevronRight, ExternalLink } from "lucide-react";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Tabs, TabsList, TabsTrigger,
} from "@/components/ui/tabs";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, LabelList, Cell,
} from "recharts";

type RangePreset = "30d" | "90d" | "year" | "custom";
type RoiMode = "estimates" | "jobs";

interface RoiSourceBreakdown {
  source: string | null;
  label: string;
  leadCount: number;
  wonCount: number;
  wonRevenue: number;
}

interface RoiPlatformRow {
  platform: string;
  platformKey: string;
  leadCount: number;
  wonCount: number;
  wonRevenue: number;
  spend: number | null;
  costPerLead: number | null;
  costPerWon: number | null;
  roas: number | null;
  roiPercent: number | null;
  bySource: RoiSourceBreakdown[];
}

interface RoiBySourceData {
  range: { start: string; end: string };
  mode: RoiMode;
  totals: {
    leadCount: number;
    wonCount: number;
    wonRevenue: number;
    spend: number | null;
    costPerLead: number | null;
    costPerWon: number | null;
    roas: number | null;
    roiPercent: number | null;
  };
  platforms: RoiPlatformRow[];
  hasAnySpend: boolean;
}

const PRESETS: { value: Exclude<RangePreset, "custom">; label: string; days: number | "year" }[] = [
  { value: "30d", label: "Last 30 days", days: 30 },
  { value: "90d", label: "Last 90 days", days: 90 },
  { value: "year", label: "This year", days: "year" },
];

const PRESET_OPTIONS: { value: RangePreset; label: string }[] = [
  ...PRESETS.map((p) => ({ value: p.value as RangePreset, label: p.label })),
  { value: "custom", label: "Custom range" },
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

function formatCurrency(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return value.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

function formatCurrencyExact(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return value.toLocaleString(undefined, { style: "currency", currency: "USD" });
}

function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${value.toFixed(1)}%`;
}

function formatRoas(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${value.toFixed(2)}×`;
}

export function ROIBySourceReport() {
  const [preset, setPreset] = useState<RangePreset>("30d");
  const [customRange, setCustomRange] = useState<DateRange | undefined>(undefined);
  const [mode, setMode] = useState<RoiMode>("estimates");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const customRangeResolved = useMemo(
    () => (preset === "custom" ? rangeFromCustom(customRange) : null),
    [preset, customRange],
  );
  const customRangeError = useMemo(() => {
    if (preset !== "custom") return null;
    if (!customRange?.from || !customRange?.to) return "Select a start and end date.";
    if (customRange.to.getTime() < customRange.from.getTime()) return "End date must be on or after start date.";
    return null;
  }, [preset, customRange]);

  const resolvedRange = useMemo(() => {
    if (preset === "custom") return customRangeResolved;
    return rangeFromPreset(preset);
  }, [preset, customRangeResolved]);

  const startDate = resolvedRange?.startDate ?? "";
  const endDate = resolvedRange?.endDate ?? "";

  const { data, isLoading, isError } = useQuery<RoiBySourceData>({
    queryKey: ["/api/reports/leads/roi-by-source", startDate, endDate, mode],
    queryFn: async () => {
      const params = new URLSearchParams({ startDate, endDate, mode });
      const res = await fetch(`/api/reports/leads/roi-by-source?${params.toString()}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to load ROI by Source report");
      return res.json();
    },
    enabled: resolvedRange !== null,
    staleTime: 2 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    placeholderData: keepPreviousData,
  });

  const chartData = useMemo(() => {
    if (!data) return [];
    return data.platforms.map((p) => ({
      platform: p.platform,
      Spend: p.spend ?? 0,
      Revenue: p.wonRevenue,
      roiPercent: p.roiPercent,
      roiLabel: p.roiPercent === null ? "" : `${p.roiPercent.toFixed(0)}%`,
    }));
  }, [data]);

  function toggleRow(platform: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(platform)) next.delete(platform);
      else next.add(platform);
      return next;
    });
  }

  return (
    <Card data-testid="card-roi-by-source-report">
      <CardHeader className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CardTitle>ROI by Source</CardTitle>
          <CardDescription>
            Spend vs. revenue per advertising platform, with cost per lead, cost per
            sale, and ROI %. Toggle between approved estimates and completed jobs.
          </CardDescription>
        </div>
        <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-start">
          <Tabs value={mode} onValueChange={(v) => setMode(v as RoiMode)}>
            <TabsList>
              <TabsTrigger value="estimates" data-testid="tab-roi-estimates">
                Won Estimates
              </TabsTrigger>
              <TabsTrigger value="jobs" data-testid="tab-roi-jobs">
                Won Jobs
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <Select value={preset} onValueChange={(v) => setPreset(v as RangePreset)}>
            <SelectTrigger className="w-[180px]" data-testid="select-roi-range">
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
                    data-testid="button-roi-custom-range"
                  >
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {customRange?.from ? (
                      customRange.to ? (
                        <>{format(customRange.from, "LLL d, y")} – {format(customRange.to, "LLL d, y")}</>
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
                <p className="text-xs text-destructive" data-testid="text-roi-range-error">
                  {customRangeError}
                </p>
              )}
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {!resolvedRange ? (
          <p className="text-sm text-muted-foreground" data-testid="text-roi-pick-range">
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
        ) : isError || !data ? (
          <p className="text-sm text-destructive" data-testid="text-roi-error">
            Could not load report. Please try again.
          </p>
        ) : !data.hasAnySpend && data.platforms.length === 0 ? (
          <EmptyState />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              <Stat label="Total spend" value={formatCurrency(data.totals.spend)} testId="stat-totals-spend" />
              <Stat label="Total revenue" value={formatCurrency(data.totals.wonRevenue)} testId="stat-totals-revenue" />
              <Stat label="ROAS" value={formatRoas(data.totals.roas)} testId="stat-totals-roas" />
              <Stat label="ROI %" value={formatPercent(data.totals.roiPercent)} testId="stat-totals-roi" />
            </div>

            {!data.hasAnySpend && (
              <div className="rounded-md border p-4 text-sm">
                <p className="mb-2 text-muted-foreground">
                  No ad spend has been entered yet. Add monthly spend per platform
                  to see ROI metrics.
                </p>
                <Link href="/settings?tab=ad_spend">
                  <Button variant="default" size="sm" data-testid="button-go-ad-spend">
                    Go to Ad Spend settings
                    <ExternalLink className="ml-2 h-3 w-3" />
                  </Button>
                </Link>
              </div>
            )}

            {data.platforms.length > 0 && (
              <div className="h-[320px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                    <XAxis
                      dataKey="platform"
                      className="text-xs"
                      tick={{ fill: "hsl(var(--muted-foreground))" }}
                    />
                    <YAxis
                      className="text-xs"
                      tick={{ fill: "hsl(var(--muted-foreground))" }}
                      tickFormatter={(v) => `$${Number(v).toLocaleString()}`}
                    />
                    <Tooltip content={<RoiTooltip />} />
                    <Legend />
                    <Bar dataKey="Spend" fill="hsl(220 70% 55%)" />
                    <Bar dataKey="Revenue" fill="hsl(142 71% 45%)">
                      <LabelList
                        dataKey="roiLabel"
                        position="top"
                        className="text-xs"
                        fill="hsl(var(--foreground))"
                      />
                      {chartData.map((_, idx) => (
                        <Cell key={idx} fill="hsl(142 71% 45%)" />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}

            <div className="overflow-x-auto">
              <Table data-testid="table-roi-by-source">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8" />
                    <TableHead>Platform</TableHead>
                    <TableHead className="text-right">Leads</TableHead>
                    <TableHead className="text-right">Won</TableHead>
                    <TableHead className="text-right">Revenue</TableHead>
                    <TableHead className="text-right">Spend</TableHead>
                    <TableHead className="text-right">$/Lead</TableHead>
                    <TableHead className="text-right">$/Sale</TableHead>
                    <TableHead className="text-right">ROAS</TableHead>
                    <TableHead className="text-right">ROI %</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.platforms.map((row) => {
                    const isOpen = expanded.has(row.platformKey);
                    const noSpend = row.spend === null;
                    return (
                      <Fragment key={row.platformKey}>
                        <TableRow
                          className="cursor-pointer hover-elevate"
                          onClick={() => toggleRow(row.platformKey)}
                          data-testid={`row-platform-${row.platformKey}`}
                        >
                          <TableCell>
                            {row.bySource.length > 0 ? (
                              isOpen ? (
                                <ChevronDown className="h-4 w-4" />
                              ) : (
                                <ChevronRight className="h-4 w-4" />
                              )
                            ) : null}
                          </TableCell>
                          <TableCell className="font-medium">{row.platform}</TableCell>
                          <TableCell className="text-right tabular-nums">{row.leadCount}</TableCell>
                          <TableCell className="text-right tabular-nums">{row.wonCount}</TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatCurrency(row.wonRevenue)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {noSpend ? (
                              <span title="Add spend in Settings → Ad Spend" className="text-muted-foreground">
                                —
                              </span>
                            ) : (
                              formatCurrency(row.spend)
                            )}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatCurrencyExact(row.costPerLead)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatCurrencyExact(row.costPerWon)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatRoas(row.roas)}
                          </TableCell>
                          <TableCell
                            className={cn(
                              "text-right tabular-nums",
                              row.roiPercent !== null && row.roiPercent < 0 && "text-destructive",
                            )}
                          >
                            {formatPercent(row.roiPercent)}
                          </TableCell>
                        </TableRow>
                        {isOpen && row.bySource.length > 0 && (
                          <TableRow
                            data-testid={`row-platform-${row.platformKey}-detail`}
                          >
                            <TableCell />
                            <TableCell colSpan={9} className="p-0">
                              <div className="bg-muted/30 px-4 py-2">
                                <Table>
                                  <TableHeader>
                                    <TableRow>
                                      <TableHead>Source</TableHead>
                                      <TableHead className="text-right">Leads</TableHead>
                                      <TableHead className="text-right">Won</TableHead>
                                      <TableHead className="text-right">Revenue</TableHead>
                                    </TableRow>
                                  </TableHeader>
                                  <TableBody>
                                    {row.bySource.map((src) => (
                                      <TableRow key={src.source ?? "__unknown__"}>
                                        <TableCell>{src.label}</TableCell>
                                        <TableCell className="text-right tabular-nums">
                                          {src.leadCount}
                                        </TableCell>
                                        <TableCell className="text-right tabular-nums">
                                          {src.wonCount}
                                        </TableCell>
                                        <TableCell className="text-right tabular-nums">
                                          {formatCurrency(src.wonRevenue)}
                                        </TableCell>
                                      </TableRow>
                                    ))}
                                  </TableBody>
                                </Table>
                              </div>
                            </TableCell>
                          </TableRow>
                        )}
                      </Fragment>
                    );
                  })}
                  {data.platforms.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={10} className="text-center text-muted-foreground">
                        No leads or spend in this range.
                      </TableCell>
                    </TableRow>
                  )}
                  {data.platforms.length > 0 && (
                    <TableRow className="font-semibold border-t-2" data-testid="row-roi-totals">
                      <TableCell />
                      <TableCell>Total</TableCell>
                      <TableCell className="text-right tabular-nums">{data.totals.leadCount}</TableCell>
                      <TableCell className="text-right tabular-nums">{data.totals.wonCount}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatCurrency(data.totals.wonRevenue)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatCurrency(data.totals.spend)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatCurrencyExact(data.totals.costPerLead)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatCurrencyExact(data.totals.costPerWon)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatRoas(data.totals.roas)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatPercent(data.totals.roiPercent)}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
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

function EmptyState() {
  return (
    <div
      className="flex flex-col items-start gap-3 rounded-md border p-6"
      data-testid="empty-state-no-spend"
    >
      <h3 className="text-base font-semibold">No ad spend or leads yet.</h3>
      <p className="text-sm text-muted-foreground">
        Enter your monthly ad spend per platform in Settings → Ad Spend so this
        report can show cost per lead and ROI.
      </p>
      <Link href="/settings?tab=ad_spend">
        <Button data-testid="button-empty-go-ad-spend">
          Go to Ad Spend settings
          <ExternalLink className="ml-2 h-4 w-4" />
        </Button>
      </Link>
    </div>
  );
}

interface TooltipPayloadEntry {
  name?: string;
  dataKey?: string | number;
  value?: number;
  color?: string;
  payload?: { platform?: string; Spend?: number; Revenue?: number; roiPercent?: number | null };
}

function RoiTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: TooltipPayloadEntry[];
}) {
  if (!active || !payload || payload.length === 0) return null;
  const row = payload[0]?.payload;
  if (!row) return null;
  return (
    <div className="rounded-md border bg-background p-2 text-xs shadow-sm">
      <div className="mb-1 font-semibold">{row.platform}</div>
      <div className="flex flex-col gap-0.5">
        <div className="flex items-center justify-between gap-4">
          <span>Spend</span>
          <span className="tabular-nums">{formatCurrency(row.Spend ?? 0)}</span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span>Revenue</span>
          <span className="tabular-nums">{formatCurrency(row.Revenue ?? 0)}</span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span>ROI</span>
          <span className="tabular-nums">{formatPercent(row.roiPercent ?? null)}</span>
        </div>
      </div>
    </div>
  );
}
