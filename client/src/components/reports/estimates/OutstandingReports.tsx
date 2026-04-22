import { useCallback, useEffect, useRef } from "react";
import { useLocation, useSearch } from "wouter";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import {
  EstimatesReportsFiltersProvider,
  ReportShell,
  Stat,
  formatDate,
  formatMoney,
  useEstimatesReportFilters,
  useReportQuery,
} from "./shared";
import { cn } from "@/lib/utils";

interface OutstandingEstimate {
  id: string;
  title: string;
  contactId: string;
  contactName: string;
  amount: number;
  status: string;
  createdAt: string;
  ageDays: number;
  salespersonName: string | null;
  ageBucket: "0-7" | "8-14" | "15-30" | "30+";
}

interface OutstandingData {
  total: number;
  totalValue: number;
  estimates: OutstandingEstimate[];
  buckets: { bucket: string; count: number }[];
}

export const PAGE_SIZE = 25;

type SortField = "created_at" | "amount" | "age" | "salesperson";
type SortDir = "asc" | "desc";

interface SortState {
  field: SortField;
  dir: SortDir;
}

const SORTABLE_FIELDS: SortField[] = ["created_at", "amount", "age", "salesperson"];

// Sort state lives in the URL so refreshing the page (or sharing the URL)
// preserves the user's choice. Each report has its own URL param prefix so the
// Pending and In-progress tables sort independently.
function useSortFromUrl(prefix: string, defaultField: SortField = "created_at"): {
  sort: SortState;
  setSort: (next: SortState) => void;
  toggle: (field: SortField) => void;
} {
  const search = useSearch();
  const [, setLocation] = useLocation();
  const params = new URLSearchParams(search);
  const fieldParam = params.get(`${prefix}SortBy`);
  const dirParam = params.get(`${prefix}SortDir`);
  const field: SortField = SORTABLE_FIELDS.includes(fieldParam as SortField)
    ? (fieldParam as SortField)
    : defaultField;
  const dir: SortDir =
    dirParam === "asc" || dirParam === "desc"
      ? dirParam
      : field === "created_at"
        ? "asc"
        : "desc";

  const setSort = useCallback(
    (next: SortState) => {
      const p = new URLSearchParams(window.location.search);
      // Default sort is omitted from the URL to keep it clean.
      if (next.field === "created_at" && next.dir === "asc") {
        p.delete(`${prefix}SortBy`);
        p.delete(`${prefix}SortDir`);
      } else {
        p.set(`${prefix}SortBy`, next.field);
        p.set(`${prefix}SortDir`, next.dir);
      }
      const qs = p.toString();
      setLocation(`${window.location.pathname}${qs ? `?${qs}` : ""}`, { replace: true });
    },
    [prefix, setLocation],
  );

  const toggle = useCallback(
    (clicked: SortField) => {
      // Same column → flip direction. New column → start at the most useful
      // direction (DESC for amount/age/salesperson, ASC for created_at).
      if (clicked === field) {
        setSort({ field, dir: dir === "asc" ? "desc" : "asc" });
      } else {
        setSort({ field: clicked, dir: clicked === "created_at" ? "asc" : "desc" });
      }
    },
    [field, dir, setSort],
  );

  return { sort: { field, dir }, setSort, toggle };
}

interface SortableHeaderProps {
  label: string;
  field: SortField;
  current: SortState;
  onToggle: (field: SortField) => void;
  align?: "left" | "right";
  testId?: string;
}

function SortableHeader({ label, field, current, onToggle, align = "left", testId }: SortableHeaderProps) {
  const isActive = current.field === field;
  const Icon = !isActive ? ArrowUpDown : current.dir === "asc" ? ArrowUp : ArrowDown;
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => onToggle(field)}
      className={cn(
        "-ml-3 h-8 data-[state=open]:bg-accent",
        align === "right" && "ml-0 -mr-3",
      )}
      data-testid={testId}
      aria-sort={isActive ? (current.dir === "asc" ? "ascending" : "descending") : "none"}
    >
      <span>{label}</span>
      <Icon className={cn("ml-2 h-3.5 w-3.5", !isActive && "opacity-50")} />
    </Button>
  );
}

const BUCKET_LABEL: Record<OutstandingEstimate["ageBucket"], string> = {
  "0-7": "Under 1 week",
  "8-14": "1–2 weeks",
  "15-30": "2–4 weeks",
  "30+": "Over 30 days",
};

function ageBadge(b: OutstandingEstimate["ageBucket"]) {
  const cls =
    b === "30+"
      ? "bg-destructive/15 text-destructive"
      : b === "15-30"
        ? "bg-orange-500/15 text-orange-700 dark:text-orange-400"
        : b === "8-14"
          ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
          : "";
  return (
    <Badge variant="secondary" className={cls}>
      {BUCKET_LABEL[b]}
    </Badge>
  );
}

interface OutstandingTableProps {
  rows: OutstandingEstimate[];
  testId: string;
  sort: SortState;
  onToggleSort: (field: SortField) => void;
}

function OutstandingTable({ rows, testId, sort, onToggleSort }: OutstandingTableProps) {
  return (
    <div className="overflow-x-auto">
      <Table data-testid={testId}>
        <TableHeader>
          <TableRow>
            <TableHead>Title</TableHead>
            <TableHead>Contact</TableHead>
            <TableHead>
              <SortableHeader
                label="Salesperson"
                field="salesperson"
                current={sort}
                onToggle={onToggleSort}
                testId={`${testId}-sort-salesperson`}
              />
            </TableHead>
            <TableHead>Created</TableHead>
            <TableHead className="text-right">
              <SortableHeader
                label="Age"
                field="age"
                current={sort}
                onToggle={onToggleSort}
                align="right"
                testId={`${testId}-sort-age`}
              />
            </TableHead>
            <TableHead>Bucket</TableHead>
            <TableHead className="text-right">
              <SortableHeader
                label="Amount"
                field="amount"
                current={sort}
                onToggle={onToggleSort}
                align="right"
                testId={`${testId}-sort-amount`}
              />
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.id} data-testid={`row-outstanding-${r.id}`}>
              <TableCell className="font-medium">{r.title}</TableCell>
              <TableCell>{r.contactName}</TableCell>
              <TableCell>{r.salespersonName ?? "Unassigned"}</TableCell>
              <TableCell>{formatDate(r.createdAt)}</TableCell>
              <TableCell className="text-right">{r.ageDays}d</TableCell>
              <TableCell>{ageBadge(r.ageBucket)}</TableCell>
              <TableCell className="text-right">{formatMoney(r.amount)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function buildBucketStats(buckets: { bucket: string; count: number }[]) {
  const get = (b: string) => buckets.find((x) => x.bucket === b)?.count ?? 0;
  return {
    fresh: get("0-7"),
    week: get("8-14"),
    twoWeek: get("15-30"),
    stale: get("30+"),
  };
}

// Compact list of page numbers with ellipses for the pagination control. Shows
// first, last, current, and the immediate neighbors of current.
function getPageList(current: number, totalPages: number): (number | "ellipsis")[] {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, i) => i);
  }
  const items: (number | "ellipsis")[] = [];
  const last = totalPages - 1;
  items.push(0);
  if (current > 2) items.push("ellipsis");
  const start = Math.max(1, current - 1);
  const end = Math.min(last - 1, current + 1);
  for (let i = start; i <= end; i++) items.push(i);
  if (current < last - 2) items.push("ellipsis");
  items.push(last);
  return items;
}

interface TablePaginationProps {
  page: number;
  total: number;
  onPageChange: (next: number) => void;
  testId?: string;
}

export function TablePagination({ page, total, onPageChange, testId }: TablePaginationProps) {
  const totalPages = Math.ceil(total / PAGE_SIZE);
  if (totalPages <= 1) return null;
  // Defensive clamp: if a stale page exceeds the new totalPages (e.g. data
  // shrank between renders), display the last available page.
  const clamped = Math.min(page, totalPages - 1);
  const items = getPageList(clamped, totalPages);
  const prev = (e: React.MouseEvent) => {
    e.preventDefault();
    if (page > 0) onPageChange(page - 1);
  };
  const next = (e: React.MouseEvent) => {
    e.preventDefault();
    if (page < totalPages - 1) onPageChange(page + 1);
  };
  return (
    <Pagination data-testid={testId}>
      <PaginationContent>
        <PaginationItem>
          <PaginationPrevious
            href="#"
            onClick={prev}
            aria-disabled={page === 0}
            className={page === 0 ? "pointer-events-none opacity-50" : undefined}
            data-testid={`${testId}-prev`}
          />
        </PaginationItem>
        {items.map((it, idx) =>
          it === "ellipsis" ? (
            <PaginationItem key={`e-${idx}`}>
              <PaginationEllipsis />
            </PaginationItem>
          ) : (
            <PaginationItem key={it}>
              <PaginationLink
                href="#"
                isActive={it === clamped}
                onClick={(e) => {
                  e.preventDefault();
                  onPageChange(it);
                }}
                data-testid={`${testId}-page-${it}`}
              >
                {it + 1}
              </PaginationLink>
            </PaginationItem>
          ),
        )}
        <PaginationItem>
          <PaginationNext
            href="#"
            onClick={next}
            aria-disabled={page >= totalPages - 1}
            className={page >= totalPages - 1 ? "pointer-events-none opacity-50" : undefined}
            data-testid={`${testId}-next`}
          />
        </PaginationItem>
      </PaginationContent>
    </Pagination>
  );
}

// Page index lives in the URL (per-report prefix) so reload/share preserves
// the user's spot in long results, just like the sort selection.
function usePageFromUrl(prefix: string): { page: number; setPage: (n: number) => void } {
  const search = useSearch();
  const [, setLocation] = useLocation();
  const params = new URLSearchParams(search);
  const raw = params.get(`${prefix}Page`);
  const parsed = raw === null ? 0 : parseInt(raw, 10);
  const page = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  const setPage = useCallback(
    (n: number) => {
      const p = new URLSearchParams(window.location.search);
      if (n <= 0) p.delete(`${prefix}Page`);
      else p.set(`${prefix}Page`, String(n));
      const qs = p.toString();
      setLocation(`${window.location.pathname}${qs ? `?${qs}` : ""}`, { replace: true });
    },
    [prefix, setLocation],
  );
  return { page, setPage };
}

// Reset pagination to page 0 whenever any of the report filters change.
// Without this, narrowing filters while sitting on a high page yields an
// out-of-range OFFSET → empty rows even though `total > 0`, which would render
// a stats card with an empty table and (when total <= pageSize) no Pagination
// control to recover from.
//
// IMPORTANT: depend on the *stable* filter state (preset name + custom range
// timestamps), not the resolved date range. resolveRange() rebuilds Date.now()
// on every render for preset windows, so depending on it would reset the page
// on every render and break paging entirely.
export function useResetOnFilterChange(reset: () => void) {
  const { filters } = useEstimatesReportFilters();
  const preset = filters.preset;
  const customFrom = filters.customRange?.from?.getTime() ?? 0;
  const customTo = filters.customRange?.to?.getTime() ?? 0;
  const sp = filters.salespersonId ?? "";
  const ls = filters.leadSource ?? "";
  // Skip the very first run so a URL-restored page index isn't immediately
  // clobbered back to 0. Only fire when the user actually changes a filter.
  const isFirst = useRef(true);
  useEffect(() => {
    if (isFirst.current) {
      isFirst.current = false;
      return;
    }
    reset();
    // `reset` is intentionally excluded — it's a stable setState callback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset, customFrom, customTo, sp, ls]);
}

function PendingReportInner() {
  const { page, setPage } = usePageFromUrl("pending");
  const { sort, toggle } = useSortFromUrl("pending");
  useResetOnFilterChange(() => setPage(0));
  // Reset to page 0 whenever the sort changes — otherwise a sort flip while
  // sitting on page 5 could leave the user on an out-of-range OFFSET. Skip the
  // initial render so a URL-restored page isn't immediately reset.
  const sortIsFirst = useRef(true);
  useEffect(() => {
    if (sortIsFirst.current) {
      sortIsFirst.current = false;
      return;
    }
    setPage(0);
  }, [sort.field, sort.dir, setPage]);
  const { data, isLoading, isError } = useReportQuery<OutstandingData>(
    "/api/reports/estimates/pending",
    {
      extraParams: {
        page,
        pageSize: PAGE_SIZE,
        sortBy: sort.field,
        sortDir: sort.dir,
      },
    },
  );
  const isEmpty = !!data && data.total === 0;
  const b = buildBucketStats(data?.buckets ?? []);
  return (
    <ReportShell
      title="Pending estimates"
      description="Sent or scheduled estimates sorted by age."
      isLoading={isLoading}
      isError={isError}
      isEmpty={isEmpty}
      emptyMessage="No pending estimates in this date range."
      testId="card-pending-report"
    >
      {data && (
        <>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
            <Stat label="Pending" value={data.total.toString()} testId="stat-pending-count" />
            <Stat label="Value" value={formatMoney(data.totalValue)} testId="stat-pending-value" />
            <Stat label="<1 week" value={b.fresh.toString()} testId="stat-pending-fresh" />
            <Stat label="1–2 weeks" value={b.week.toString()} testId="stat-pending-week" />
            <Stat label="Over 30 days" value={b.stale.toString()} testId="stat-pending-stale" />
          </div>
          <OutstandingTable
            rows={data.estimates}
            testId="table-pending-estimates"
            sort={sort}
            onToggleSort={toggle}
          />
          <TablePagination
            page={page}
            total={data.total}
            onPageChange={setPage}
            testId="pagination-pending"
          />
        </>
      )}
    </ReportShell>
  );
}

export function PendingReport() {
  return (
    <EstimatesReportsFiltersProvider urlPrefix="pending">
      <PendingReportInner />
    </EstimatesReportsFiltersProvider>
  );
}

function InProgressReportInner() {
  const { page, setPage } = usePageFromUrl("inProgress");
  const { sort, toggle } = useSortFromUrl("inProgress");
  useResetOnFilterChange(() => setPage(0));
  const sortIsFirst = useRef(true);
  useEffect(() => {
    if (sortIsFirst.current) {
      sortIsFirst.current = false;
      return;
    }
    setPage(0);
  }, [sort.field, sort.dir, setPage]);
  const { data, isLoading, isError } = useReportQuery<OutstandingData>(
    "/api/reports/estimates/in-progress",
    {
      extraParams: {
        page,
        pageSize: PAGE_SIZE,
        sortBy: sort.field,
        sortDir: sort.dir,
      },
    },
  );
  const isEmpty = !!data && data.total === 0;
  return (
    <ReportShell
      title="In-progress estimates"
      description="Estimates currently in the in-progress status."
      isLoading={isLoading}
      isError={isError}
      isEmpty={isEmpty}
      emptyMessage="No in-progress estimates in this date range."
      testId="card-in-progress-report"
    >
      {data && (
        <>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
            <Stat label="In progress" value={data.total.toString()} testId="stat-ip-count" />
            <Stat label="Value" value={formatMoney(data.totalValue)} testId="stat-ip-value" />
            <Stat
              label="Avg amount"
              value={formatMoney(data.total > 0 ? data.totalValue / data.total : 0)}
              testId="stat-ip-avg"
            />
          </div>
          <OutstandingTable
            rows={data.estimates}
            testId="table-in-progress-estimates"
            sort={sort}
            onToggleSort={toggle}
          />
          <TablePagination
            page={page}
            total={data.total}
            onPageChange={setPage}
            testId="pagination-in-progress"
          />
        </>
      )}
    </ReportShell>
  );
}

export function InProgressReport() {
  return (
    <EstimatesReportsFiltersProvider urlPrefix="inProgress">
      <InProgressReportInner />
    </EstimatesReportsFiltersProvider>
  );
}
