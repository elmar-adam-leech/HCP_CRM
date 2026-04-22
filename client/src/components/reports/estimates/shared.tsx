import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useQuery, keepPreviousData, useQueryClient } from "@tanstack/react-query";
import { format, parseISO } from "date-fns";
import type { DateRange } from "react-day-picker";
import { CalendarIcon } from "lucide-react";
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

// ---- Filter state -----------------------------------------------------------

export type RangePreset = "7d" | "30d" | "90d" | "year" | "custom";

export interface EstimatesReportFilters {
  preset: RangePreset;
  customRange?: DateRange;
  salespersonId?: string;
  leadSource?: string;
}

export interface ResolvedRange {
  startDate: string;
  endDate: string;
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

export function rangeFromPreset(preset: Exclude<RangePreset, "custom">): ResolvedRange {
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

export function rangeFromCustom(range: DateRange | undefined): ResolvedRange | null {
  if (!range?.from || !range?.to) return null;
  const start = new Date(range.from);
  start.setHours(0, 0, 0, 0);
  const end = new Date(range.to);
  end.setHours(23, 59, 59, 999);
  if (end.getTime() < start.getTime()) return null;
  return { startDate: start.toISOString(), endDate: end.toISOString() };
}

export function resolveRange(f: EstimatesReportFilters): ResolvedRange | null {
  if (f.preset === "custom") return rangeFromCustom(f.customRange);
  return rangeFromPreset(f.preset);
}

// ---- Filter context (shared across all estimates reports) ------------------
// Keeping the filter state in a context ensures that when the user switches
// from one estimates report to another in the same session their date range
// and salesperson/source choices are preserved.

interface FiltersContextValue {
  filters: EstimatesReportFilters;
  setFilters: (next: Partial<EstimatesReportFilters>) => void;
}

const FiltersContext = createContext<FiltersContextValue | null>(null);

export function EstimatesReportsFiltersProvider({ children }: { children: ReactNode }) {
  const [filters, setFiltersState] = useState<EstimatesReportFilters>({ preset: "30d" });
  const setFilters = useCallback((next: Partial<EstimatesReportFilters>) => {
    setFiltersState((prev) => ({ ...prev, ...next }));
  }, []);
  const value = useMemo(() => ({ filters, setFilters }), [filters, setFilters]);
  return <FiltersContext.Provider value={value}>{children}</FiltersContext.Provider>;
}

export function useEstimatesReportFilters(): FiltersContextValue {
  const ctx = useContext(FiltersContext);
  if (!ctx) {
    throw new Error("useEstimatesReportFilters must be used inside EstimatesReportsFiltersProvider");
  }
  return ctx;
}

// ---- Filter options query (salespeople + lead sources) ---------------------

export interface FilterOptions {
  salespeople: { userId: string; name: string }[];
  leadSources: string[];
}

export function useFilterOptions() {
  return useQuery<FilterOptions>({
    queryKey: ["/api/reports/estimates/filter-options"],
    queryFn: async () => {
      const res = await fetch("/api/reports/estimates/filter-options", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load filter options");
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
  });
}

// ---- Filter bar UI ---------------------------------------------------------

interface EstimatesReportFiltersBarProps {
  showDateRange?: boolean;
  showSalesperson?: boolean;
  showLeadSource?: boolean;
}

const ALL = "__all__";

export function EstimatesReportFiltersBar({
  showDateRange = true,
  showSalesperson = true,
  showLeadSource = true,
}: EstimatesReportFiltersBarProps) {
  const { filters, setFilters } = useEstimatesReportFilters();
  const { data: options } = useFilterOptions();

  const customRangeError =
    filters.preset === "custom" && filters.customRange?.from && filters.customRange?.to
      ? filters.customRange.to.getTime() < filters.customRange.from.getTime()
        ? "End date must be on or after start date."
        : null
      : filters.preset === "custom"
        ? "Select a start and end date."
        : null;

  return (
    <div className="flex flex-col gap-3 md:flex-row md:flex-wrap md:items-end">
      {showDateRange && (
      <>
      <div className="flex flex-col gap-1">
        <label className="text-xs text-muted-foreground">Date range</label>
        <Select
          value={filters.preset}
          onValueChange={(v) => setFilters({ preset: v as RangePreset })}
        >
          <SelectTrigger className="w-[180px]" data-testid="select-estimates-range">
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
      </div>

      {filters.preset === "custom" && (
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground">Custom range</label>
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                className={cn(
                  "w-[260px] justify-start text-left font-normal",
                  !filters.customRange?.from && "text-muted-foreground",
                )}
                data-testid="button-estimates-custom-range"
              >
                <CalendarIcon className="mr-2 h-4 w-4" />
                {filters.customRange?.from ? (
                  filters.customRange.to ? (
                    <>
                      {format(filters.customRange.from, "LLL d, y")} – {format(filters.customRange.to, "LLL d, y")}
                    </>
                  ) : (
                    format(filters.customRange.from, "LLL d, y")
                  )
                ) : (
                  "Pick a date range"
                )}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="start">
              <Calendar
                mode="range"
                selected={filters.customRange}
                onSelect={(r) => setFilters({ customRange: r })}
                numberOfMonths={2}
                initialFocus
              />
            </PopoverContent>
          </Popover>
          {customRangeError && (
            <p className="text-xs text-destructive" data-testid="text-estimates-range-error">
              {customRangeError}
            </p>
          )}
        </div>
      )}
      </>)}

      {showSalesperson && (
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground">Salesperson</label>
          <Select
            value={filters.salespersonId ?? ALL}
            onValueChange={(v) => setFilters({ salespersonId: v === ALL ? undefined : v })}
          >
            <SelectTrigger className="w-[200px]" data-testid="select-estimates-salesperson">
              <SelectValue placeholder="All salespeople" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All salespeople</SelectItem>
              {options?.salespeople.map((s) => (
                <SelectItem key={s.userId} value={s.userId}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {showLeadSource && (
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground">Lead source</label>
          <Select
            value={filters.leadSource ?? ALL}
            onValueChange={(v) => setFilters({ leadSource: v === ALL ? undefined : v })}
          >
            <SelectTrigger className="w-[200px]" data-testid="select-estimates-source">
              <SelectValue placeholder="All sources" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All sources</SelectItem>
              <SelectItem value="__unknown__">Unknown</SelectItem>
              {options?.leadSources.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
    </div>
  );
}

// ---- Report query helper ---------------------------------------------------

export function useReportQuery<T>(
  path: string,
  opts?: { skipDateFilter?: boolean; extraParams?: Record<string, string | number> },
) {
  const { filters } = useEstimatesReportFilters();
  const range = resolveRange(filters);
  const enabled = opts?.skipDateFilter ? true : range !== null;
  // Stable, sorted serialization of extraParams so the queryKey is consistent
  // regardless of insertion order.
  const extraEntries = Object.entries(opts?.extraParams ?? {})
    .filter(([, v]) => v !== undefined && v !== null)
    .sort(([a], [b]) => a.localeCompare(b));
  const extraKey = extraEntries.map(([k, v]) => `${k}=${v}`).join("&");
  return useQuery<T>({
    queryKey: [
      path,
      range?.startDate ?? "",
      range?.endDate ?? "",
      filters.salespersonId ?? "",
      filters.leadSource ?? "",
      extraKey,
    ],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (range) {
        params.set("startDate", range.startDate);
        params.set("endDate", range.endDate);
      }
      if (filters.salespersonId) params.set("salespersonId", filters.salespersonId);
      if (filters.leadSource) params.set("leadSource", filters.leadSource);
      for (const [k, v] of extraEntries) params.set(k, String(v));
      const url = `${path}?${params.toString()}`;
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error(`Failed to load ${path}`);
      return res.json();
    },
    enabled,
    // Reports change rarely on the timescale of a user clicking around the
    // page; bump staleTime so flipping between reports/tabs doesn't refetch
    // identical data, and keep previous data on screen while new data loads.
    staleTime: 2 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    placeholderData: keepPreviousData,
  });
}

// Lightweight prefetch helper for sibling reports. The Reports page calls this
// for the active report's neighbors so that when the user clicks one, the data
// is already in the React Query cache and the chart skeleton is skipped.
export function usePrefetchEstimatesReports(paths: readonly string[]): void {
  const qc = useQueryClient();
  const { filters } = useEstimatesReportFilters();
  const range = resolveRange(filters);
  const salesperson = filters.salespersonId ?? "";
  const leadSource = filters.leadSource ?? "";
  useEffect(() => {
    if (!range) return;
    // Defer to idle to avoid competing with the active report's request.
    const schedule: (cb: () => void) => number =
      typeof (globalThis as { requestIdleCallback?: (cb: () => void) => number })
        .requestIdleCallback === "function"
        ? (globalThis as { requestIdleCallback: (cb: () => void) => number })
            .requestIdleCallback
        : (cb: () => void) => window.setTimeout(cb, 250);
    const handle = schedule(() => {
      for (const path of paths) {
        const params = new URLSearchParams();
        params.set("startDate", range.startDate);
        params.set("endDate", range.endDate);
        if (salesperson) params.set("salespersonId", salesperson);
        if (leadSource) params.set("leadSource", leadSource);
        const url = `${path}?${params.toString()}`;
        void qc.prefetchQuery({
          queryKey: [path, range.startDate, range.endDate, salesperson, leadSource],
          queryFn: async () => {
            const res = await fetch(url, { credentials: "include" });
            if (!res.ok) throw new Error(`Failed to prefetch ${path}`);
            return res.json();
          },
          staleTime: 2 * 60 * 1000,
        });
      }
    });
    return () => {
      const cancel = (
        globalThis as { cancelIdleCallback?: (h: number) => void }
      ).cancelIdleCallback;
      if (typeof cancel === "function") cancel(handle);
      else clearTimeout(handle);
    };
  }, [qc, paths, range?.startDate, range?.endDate, salesperson, leadSource]);
}

// ---- Report shell ----------------------------------------------------------

export interface ReportShellProps {
  title: string;
  description?: string;
  showDateRange?: boolean;
  showSalesperson?: boolean;
  showLeadSource?: boolean;
  isLoading: boolean;
  isError: boolean;
  isEmpty: boolean;
  emptyMessage?: string;
  testId?: string;
  children: ReactNode;
}

export function ReportShell({
  title,
  description,
  showDateRange,
  showSalesperson,
  showLeadSource,
  isLoading,
  isError,
  isEmpty,
  emptyMessage,
  testId,
  children,
}: ReportShellProps) {
  const { filters } = useEstimatesReportFilters();
  const range = resolveRange(filters);
  return (
    <Card data-testid={testId}>
      <CardHeader className="flex flex-col gap-3">
        <div>
          <CardTitle>{title}</CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
        </div>
        <EstimatesReportFiltersBar
          showDateRange={showDateRange}
          showSalesperson={showSalesperson}
          showLeadSource={showLeadSource}
        />
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {showDateRange !== false && !range ? (
          <p className="text-sm text-muted-foreground" data-testid="text-estimates-pick-range">
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
          <p className="text-sm text-destructive" data-testid="text-estimates-error">
            Could not load report. Please try again.
          </p>
        ) : isEmpty ? (
          <p className="text-sm text-muted-foreground" data-testid="text-estimates-empty">
            {emptyMessage ?? "No estimates in this date range."}
          </p>
        ) : (
          children
        )}
      </CardContent>
    </Card>
  );
}

// ---- Stat tile -------------------------------------------------------------

interface StatProps {
  label: string;
  value: string;
  testId?: string;
  helper?: string;
}

export function Stat({ label, value, testId, helper }: StatProps) {
  return (
    <div className="rounded-md border p-4" data-testid={testId}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold">{value}</div>
      {helper && <div className="mt-1 text-xs text-muted-foreground">{helper}</div>}
    </div>
  );
}

// ---- Formatters ------------------------------------------------------------

const moneyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

export function formatMoney(n: number): string {
  return moneyFormatter.format(n);
}

export function formatPercent(n: number): string {
  return `${n.toFixed(1)}%`;
}

export function formatNumber(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return n.toFixed(digits);
}

export function formatMonth(yyyymm: string): string {
  try {
    return format(parseISO(`${yyyymm}-01`), "MMM yyyy");
  } catch {
    return yyyymm;
  }
}

export function formatDate(iso: string): string {
  try {
    return format(parseISO(iso), "MMM d, yyyy");
  } catch {
    return iso;
  }
}
