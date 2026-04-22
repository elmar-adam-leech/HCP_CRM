import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
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
  ReportShell,
  Stat,
  formatDate,
  formatMoney,
  useEstimatesReportFilters,
  useReportQuery,
} from "./shared";

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

function OutstandingTable({ rows, testId }: { rows: OutstandingEstimate[]; testId: string }) {
  return (
    <div className="overflow-x-auto">
      <Table data-testid={testId}>
        <TableHeader>
          <TableRow>
            <TableHead>Title</TableHead>
            <TableHead>Contact</TableHead>
            <TableHead>Salesperson</TableHead>
            <TableHead>Created</TableHead>
            <TableHead className="text-right">Age</TableHead>
            <TableHead>Bucket</TableHead>
            <TableHead className="text-right">Amount</TableHead>
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
  useEffect(() => {
    reset();
    // `reset` is intentionally excluded — it's a stable setState callback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset, customFrom, customTo, sp, ls]);
}

export function PendingReport() {
  const [page, setPage] = useState(0);
  useResetOnFilterChange(() => setPage(0));
  const { data, isLoading, isError } = useReportQuery<OutstandingData>(
    "/api/reports/estimates/pending",
    { extraParams: { page, pageSize: PAGE_SIZE } },
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
          <OutstandingTable rows={data.estimates} testId="table-pending-estimates" />
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

export function InProgressReport() {
  const [page, setPage] = useState(0);
  useResetOnFilterChange(() => setPage(0));
  const { data, isLoading, isError } = useReportQuery<OutstandingData>(
    "/api/reports/estimates/in-progress",
    { extraParams: { page, pageSize: PAGE_SIZE } },
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
          <OutstandingTable rows={data.estimates} testId="table-in-progress-estimates" />
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
