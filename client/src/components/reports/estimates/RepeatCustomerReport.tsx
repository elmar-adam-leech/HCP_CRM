import {
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
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
  formatMoney,
  formatPercent,
  useReportQuery,
} from "./shared";

interface RepeatCustomerData {
  totalEstimates: number;
  repeatEstimates: number;
  newEstimates: number;
  repeatPercentage: number;
  topRepeaters: {
    contactId: string;
    contactName: string;
    estimateCount: number;
    totalWon: number;
  }[];
}

export function RepeatCustomerReport() {
  const { data, isLoading, isError } = useReportQuery<RepeatCustomerData>(
    "/api/reports/estimates/repeat-customers",
  );
  const isEmpty = !!data && data.totalEstimates === 0;
  const pie = data
    ? [
        { name: "Repeat", value: data.repeatEstimates, color: "hsl(var(--primary))" },
        { name: "New", value: data.newEstimates, color: "hsl(142 71% 45%)" },
      ]
    : [];
  return (
    <ReportShell
      title="Repeat customers"
      description="Share of estimates going to contacts who already had a prior estimate."
      isLoading={isLoading}
      isError={isError}
      isEmpty={isEmpty}
      testId="card-repeat-customer"
    >
      {data && (
        <>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
            <Stat
              label="Repeat share"
              value={formatPercent(data.repeatPercentage)}
              testId="stat-rc-pct"
            />
            <Stat
              label="Repeat estimates"
              value={data.repeatEstimates.toString()}
              testId="stat-rc-repeat"
            />
            <Stat label="New estimates" value={data.newEstimates.toString()} testId="stat-rc-new" />
          </div>
          {data.totalEstimates > 0 && (
            <div className="h-[240px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={pie} dataKey="value" nameKey="name" outerRadius={90} label>
                    {pie.map((entry, i) => (
                      <Cell key={i} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            </div>
          )}
          <div className="overflow-x-auto">
            <Table data-testid="table-repeat-customers">
              <TableHeader>
                <TableRow>
                  <TableHead>Contact</TableHead>
                  <TableHead className="text-right">Estimates</TableHead>
                  <TableHead className="text-right">Won $</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.topRepeaters.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={3} className="text-center text-sm text-muted-foreground">
                      No contacts had more than one estimate in this range.
                    </TableCell>
                  </TableRow>
                ) : (
                  data.topRepeaters.map((c) => (
                    <TableRow key={c.contactId} data-testid={`row-rc-${c.contactId}`}>
                      <TableCell className="font-medium">{c.contactName}</TableCell>
                      <TableCell className="text-right">{c.estimateCount}</TableCell>
                      <TableCell className="text-right">{formatMoney(c.totalWon)}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </ReportShell>
  );
}
