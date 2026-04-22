import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  EstimatesReportsFiltersProvider,
  ReportShell,
  Stat,
  formatNumber,
  useReportQuery,
} from "./shared";

interface TimeToCloseData {
  averageDays: number | null;
  medianDays: number | null;
  decidedCount: number;
  bySalesperson: {
    userId: string | null;
    name: string;
    averageDays: number | null;
    medianDays: number | null;
    count: number;
  }[];
  histogram: { bucket: string; count: number }[];
}

function TimeToCloseReportInner() {
  const { data, isLoading, isError } = useReportQuery<TimeToCloseData>(
    "/api/reports/estimates/time-to-close",
  );
  const isEmpty = !!data && data.decidedCount === 0;
  return (
    <ReportShell
      title="Time to close"
      description="How long estimates take to reach approved or rejected, overall and by salesperson."
      isLoading={isLoading}
      isError={isError}
      isEmpty={isEmpty}
      emptyMessage="No estimates were closed in this date range."
      testId="card-time-to-close"
    >
      {data && (
        <>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
            <Stat
              label="Median days"
              value={data.medianDays !== null ? `${formatNumber(data.medianDays)}d` : "—"}
              testId="stat-ttc-median"
            />
            <Stat
              label="Avg days"
              value={data.averageDays !== null ? `${formatNumber(data.averageDays)}d` : "—"}
              testId="stat-ttc-avg"
            />
            <Stat label="Closed" value={data.decidedCount.toString()} testId="stat-ttc-count" />
          </div>
          <div className="h-[260px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data.histogram}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis dataKey="bucket" className="text-xs" />
                <YAxis className="text-xs" allowDecimals={false} />
                <Tooltip />
                <Bar dataKey="count" fill="hsl(var(--primary))" name="Closed estimates" />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="overflow-x-auto">
            <Table data-testid="table-ttc-by-salesperson">
              <TableHeader>
                <TableRow>
                  <TableHead>Salesperson</TableHead>
                  <TableHead className="text-right">Closed</TableHead>
                  <TableHead className="text-right">Median days</TableHead>
                  <TableHead className="text-right">Avg days</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.bySalesperson.map((row) => (
                  <TableRow
                    key={row.userId ?? "unassigned"}
                    data-testid={`row-ttc-sp-${row.userId ?? "unassigned"}`}
                  >
                    <TableCell className="font-medium">{row.name}</TableCell>
                    <TableCell className="text-right">{row.count}</TableCell>
                    <TableCell className="text-right">{formatNumber(row.medianDays)}</TableCell>
                    <TableCell className="text-right">{formatNumber(row.averageDays)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </ReportShell>
  );
}

export function TimeToCloseReport() {
  return (
    <EstimatesReportsFiltersProvider urlPrefix="timeToClose">
      <TimeToCloseReportInner />
    </EstimatesReportsFiltersProvider>
  );
}
