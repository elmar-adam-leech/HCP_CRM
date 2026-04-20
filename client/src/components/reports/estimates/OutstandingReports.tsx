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
  ReportShell,
  Stat,
  formatDate,
  formatMoney,
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
  count: number;
  totalValue: number;
  estimates: OutstandingEstimate[];
  buckets: { bucket: string; count: number }[];
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

export function PendingReport() {
  const { data, isLoading, isError } = useReportQuery<OutstandingData>(
    "/api/reports/estimates/pending",
    { skipDateFilter: true },
  );
  const isEmpty = !!data && data.count === 0;
  const b = buildBucketStats(data?.buckets ?? []);
  return (
    <ReportShell
      title="Pending estimates"
      description="Sent or scheduled estimates sorted by age. This is a current snapshot — date range does not apply."
      showDateRange={false}
      isLoading={isLoading}
      isError={isError}
      isEmpty={isEmpty}
      emptyMessage="No pending estimates right now."
      testId="card-pending-report"
    >
      {data && (
        <>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
            <Stat label="Pending" value={data.count.toString()} testId="stat-pending-count" />
            <Stat label="Value" value={formatMoney(data.totalValue)} testId="stat-pending-value" />
            <Stat label="<1 week" value={b.fresh.toString()} testId="stat-pending-fresh" />
            <Stat label="1–2 weeks" value={b.week.toString()} testId="stat-pending-week" />
            <Stat label="Over 30 days" value={b.stale.toString()} testId="stat-pending-stale" />
          </div>
          <OutstandingTable rows={data.estimates} testId="table-pending-estimates" />
        </>
      )}
    </ReportShell>
  );
}

export function InProgressReport() {
  const { data, isLoading, isError } = useReportQuery<OutstandingData>(
    "/api/reports/estimates/in-progress",
    { skipDateFilter: true },
  );
  const isEmpty = !!data && data.count === 0;
  return (
    <ReportShell
      title="In-progress estimates"
      description="Estimates currently in the in-progress status. This is a current snapshot — date range does not apply."
      showDateRange={false}
      isLoading={isLoading}
      isError={isError}
      isEmpty={isEmpty}
      emptyMessage="No in-progress estimates right now."
      testId="card-in-progress-report"
    >
      {data && (
        <>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
            <Stat label="In progress" value={data.count.toString()} testId="stat-ip-count" />
            <Stat label="Value" value={formatMoney(data.totalValue)} testId="stat-ip-value" />
            <Stat
              label="Avg amount"
              value={formatMoney(data.count > 0 ? data.totalValue / data.count : 0)}
              testId="stat-ip-avg"
            />
          </div>
          <OutstandingTable rows={data.estimates} testId="table-in-progress-estimates" />
        </>
      )}
    </ReportShell>
  );
}
