import { useMemo } from "react";
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
  formatNumber,
  useReportQuery,
} from "./shared";
import { format, parseISO } from "date-fns";

interface SalesActivityData {
  totalCreated: number;
  averagePerWeek: number;
  weeks: string[];
  bySalesperson: {
    userId: string | null;
    name: string;
    weekly: { week: string; count: number }[];
    averagePerWeek: number;
    total: number;
  }[];
}

const COLORS = [
  "hsl(var(--primary))",
  "hsl(142 71% 45%)",
  "hsl(28 95% 55%)",
  "hsl(48 96% 53%)",
  "hsl(280 65% 55%)",
  "hsl(200 75% 50%)",
  "hsl(340 65% 55%)",
];

function formatWeek(iso: string): string {
  try {
    return format(parseISO(iso), "MMM d");
  } catch {
    return iso;
  }
}

function SalesActivityReportInner() {
  const { data, isLoading, isError } = useReportQuery<SalesActivityData>(
    "/api/reports/estimates/sales-activity",
  );
  const isEmpty = !!data && data.totalCreated === 0;
  const chartData = useMemo(() => {
    if (!data) return [];
    return data.weeks.map((w) => {
      const row: Record<string, string | number> = { week: formatWeek(w) };
      for (const sp of data.bySalesperson) {
        row[sp.name] = sp.weekly.find((x) => x.week === w)?.count ?? 0;
      }
      return row;
    });
  }, [data]);
  return (
    <ReportShell
      title="Sales activity"
      description="Estimates created per salesperson per week. Helps spot who is and isn't quoting."
      isLoading={isLoading}
      isError={isError}
      isEmpty={isEmpty}
      testId="card-sales-activity"
    >
      {data && (
        <>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
            <Stat label="Estimates created" value={data.totalCreated.toString()} testId="stat-sa-total" />
            <Stat
              label="Avg per week"
              value={formatNumber(data.averagePerWeek)}
              testId="stat-sa-avg"
            />
            <Stat label="Salespeople" value={data.bySalesperson.length.toString()} testId="stat-sa-people" />
          </div>
          <div className="h-[300px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis dataKey="week" className="text-xs" />
                <YAxis className="text-xs" allowDecimals={false} />
                <Tooltip />
                <Legend />
                {data.bySalesperson.map((sp, i) => (
                  <Bar
                    key={sp.userId ?? sp.name}
                    dataKey={sp.name}
                    stackId="a"
                    fill={COLORS[i % COLORS.length]}
                  />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="overflow-x-auto">
            <Table data-testid="table-sales-activity">
              <TableHeader>
                <TableRow>
                  <TableHead>Salesperson</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="text-right">Avg / week</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.bySalesperson.map((sp) => (
                  <TableRow
                    key={sp.userId ?? sp.name}
                    data-testid={`row-sa-sp-${sp.userId ?? "unassigned"}`}
                  >
                    <TableCell className="font-medium">{sp.name}</TableCell>
                    <TableCell className="text-right">{sp.total}</TableCell>
                    <TableCell className="text-right">{formatNumber(sp.averagePerWeek)}</TableCell>
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

export function SalesActivityReport() {
  return (
    <EstimatesReportsFiltersProvider urlPrefix="salesActivity">
      <SalesActivityReportInner />
    </EstimatesReportsFiltersProvider>
  );
}
