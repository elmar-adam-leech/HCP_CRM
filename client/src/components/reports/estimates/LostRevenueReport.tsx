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
  ReportShell,
  Stat,
  formatDate,
  formatMoney,
  formatMonth,
  useReportQuery,
} from "./shared";

interface LostRevenueData {
  totalLost: number;
  lostCount: number;
  bySalesperson: { userId: string | null; name: string; amount: number; count: number }[];
  byMonth: { month: string; amount: number; count: number }[];
  estimates: {
    id: string;
    title: string;
    contactId: string;
    contactName: string;
    amount: number;
    rejectedAt: string;
  }[];
}

export function LostRevenueReport() {
  const { data, isLoading, isError } = useReportQuery<LostRevenueData>(
    "/api/reports/estimates/lost-revenue",
  );
  const isEmpty = !!data && data.lostCount === 0;
  const chartData = data?.byMonth.map((m) => ({ ...m, monthLabel: formatMonth(m.month) })) ?? [];
  return (
    <ReportShell
      title="Lost revenue"
      description="Dollar value of estimates that were rejected, by salesperson and month."
      isLoading={isLoading}
      isError={isError}
      isEmpty={isEmpty}
      emptyMessage="No rejected estimates in this date range."
      testId="card-lost-revenue-report"
    >
      {data && (
        <>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
            <Stat label="Lost" value={formatMoney(data.totalLost)} testId="stat-lost-total" />
            <Stat label="Rejected" value={data.lostCount.toString()} testId="stat-lost-count" />
            <Stat
              label="Avg lost"
              value={formatMoney(data.lostCount > 0 ? data.totalLost / data.lostCount : 0)}
              testId="stat-lost-avg"
            />
          </div>
          <div className="h-[260px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis dataKey="monthLabel" className="text-xs" />
                <YAxis className="text-xs" tickFormatter={(v) => formatMoney(v)} />
                <Tooltip formatter={(v: number) => formatMoney(v)} />
                <Bar dataKey="amount" fill="hsl(0 75% 55%)" name="Lost $" />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="overflow-x-auto">
            <Table data-testid="table-lost-by-salesperson">
              <TableHeader>
                <TableRow>
                  <TableHead>Salesperson</TableHead>
                  <TableHead className="text-right">Lost #</TableHead>
                  <TableHead className="text-right">Lost $</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.bySalesperson.map((row) => (
                  <TableRow
                    key={row.userId ?? "unassigned"}
                    data-testid={`row-lost-sp-${row.userId ?? "unassigned"}`}
                  >
                    <TableCell className="font-medium">{row.name}</TableCell>
                    <TableCell className="text-right">{row.count}</TableCell>
                    <TableCell className="text-right">{formatMoney(row.amount)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="overflow-x-auto">
            <Table data-testid="table-lost-estimates">
              <TableHeader>
                <TableRow>
                  <TableHead>Title</TableHead>
                  <TableHead>Contact</TableHead>
                  <TableHead>Rejected</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.estimates.map((e) => (
                  <TableRow key={e.id} data-testid={`row-lost-estimate-${e.id}`}>
                    <TableCell className="font-medium">{e.title}</TableCell>
                    <TableCell>{e.contactName}</TableCell>
                    <TableCell>{formatDate(e.rejectedAt)}</TableCell>
                    <TableCell className="text-right">{formatMoney(e.amount)}</TableCell>
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
