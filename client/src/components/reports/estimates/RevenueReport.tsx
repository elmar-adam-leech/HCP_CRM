import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
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
  formatMoney,
  formatMonth,
  useReportQuery,
} from "./shared";

interface RevenueReportData {
  totalEstimated: number;
  totalWon: number;
  averageEstimateValue: number;
  estimateCount: number;
  byMonth: { month: string; estimated: number; won: number }[];
  bySalesperson: {
    userId: string | null;
    name: string;
    estimated: number;
    won: number;
    count: number;
  }[];
}

function RevenueReportInner() {
  const { data, isLoading, isError } = useReportQuery<RevenueReportData>(
    "/api/reports/estimates/revenue",
  );
  const isEmpty = !!data && data.estimateCount === 0;
  const chartData = data?.byMonth.map((m) => ({ ...m, monthLabel: formatMonth(m.month) })) ?? [];
  return (
    <ReportShell
      title="Revenue"
      description="Total estimated dollars vs. dollars won, by month and salesperson."
      isLoading={isLoading}
      isError={isError}
      isEmpty={isEmpty}
      testId="card-revenue-report"
    >
      {data && (
        <>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <Stat
              label="Estimated"
              value={formatMoney(data.totalEstimated)}
              testId="stat-revenue-estimated"
            />
            <Stat
              label="Won"
              value={formatMoney(data.totalWon)}
              testId="stat-revenue-won"
            />
            <Stat
              label="Avg estimate"
              value={formatMoney(data.averageEstimateValue)}
              testId="stat-revenue-avg"
            />
            <Stat
              label="Estimates"
              value={data.estimateCount.toString()}
              testId="stat-revenue-count"
            />
          </div>
          <div className="h-[300px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis dataKey="monthLabel" className="text-xs" />
                <YAxis className="text-xs" tickFormatter={(v) => formatMoney(v)} />
                <Tooltip formatter={(v: number) => formatMoney(v)} />
                <Legend />
                <Bar dataKey="estimated" fill="hsl(var(--primary))" name="Estimated" />
                <Bar dataKey="won" fill="hsl(142 71% 45%)" name="Won" />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="overflow-x-auto">
            <Table data-testid="table-revenue-by-salesperson">
              <TableHeader>
                <TableRow>
                  <TableHead>Salesperson</TableHead>
                  <TableHead className="text-right">Estimates</TableHead>
                  <TableHead className="text-right">Estimated</TableHead>
                  <TableHead className="text-right">Won</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.bySalesperson.map((row) => (
                  <TableRow
                    key={row.userId ?? "unassigned"}
                    data-testid={`row-revenue-sp-${row.userId ?? "unassigned"}`}
                  >
                    <TableCell className="font-medium">{row.name}</TableCell>
                    <TableCell className="text-right">{row.count}</TableCell>
                    <TableCell className="text-right">{formatMoney(row.estimated)}</TableCell>
                    <TableCell className="text-right">{formatMoney(row.won)}</TableCell>
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

export function RevenueReport() {
  return (
    <EstimatesReportsFiltersProvider urlPrefix="revenue">
      <RevenueReportInner />
    </EstimatesReportsFiltersProvider>
  );
}
