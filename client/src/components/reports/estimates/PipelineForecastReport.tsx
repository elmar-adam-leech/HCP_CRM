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
  formatPercent,
  useReportQuery,
} from "./shared";

interface PipelineData {
  pendingValue: number;
  weightedForecast: number;
  pendingCount: number;
  bySalesperson: {
    userId: string | null;
    name: string;
    pendingValue: number;
    pendingCount: number;
    historicalCloseRate: number;
    weighted: number;
  }[];
}

function PipelineForecastReportInner() {
  const { data, isLoading, isError } = useReportQuery<PipelineData>(
    "/api/reports/estimates/pipeline-forecast",
  );
  const isEmpty = !!data && data.pendingCount === 0;
  return (
    <ReportShell
      title="Pipeline forecast"
      description="Pending estimates created in the selected date range, plus a weighted forecast using each salesperson's close rate over that same window (with a tenant-wide fallback for unassigned pipeline)."
      isLoading={isLoading}
      isError={isError}
      isEmpty={isEmpty}
      emptyMessage="No pending estimates right now."
      testId="card-pipeline-forecast"
    >
      {data && (
        <>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
            <Stat label="Pending value" value={formatMoney(data.pendingValue)} testId="stat-pipeline-pending" />
            <Stat
              label="Weighted forecast"
              value={formatMoney(data.weightedForecast)}
              testId="stat-pipeline-weighted"
              helper="Pending × historical close rate"
            />
            <Stat label="Pending count" value={data.pendingCount.toString()} testId="stat-pipeline-count" />
          </div>
          <div className="overflow-x-auto">
            <Table data-testid="table-pipeline-by-salesperson">
              <TableHeader>
                <TableRow>
                  <TableHead>Salesperson</TableHead>
                  <TableHead className="text-right">Pending #</TableHead>
                  <TableHead className="text-right">Pending $</TableHead>
                  <TableHead className="text-right">Close rate</TableHead>
                  <TableHead className="text-right">Weighted $</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.bySalesperson.map((row) => (
                  <TableRow
                    key={row.userId ?? "unassigned"}
                    data-testid={`row-pipeline-sp-${row.userId ?? "unassigned"}`}
                  >
                    <TableCell className="font-medium">{row.name}</TableCell>
                    <TableCell className="text-right">{row.pendingCount}</TableCell>
                    <TableCell className="text-right">{formatMoney(row.pendingValue)}</TableCell>
                    <TableCell className="text-right">{formatPercent(row.historicalCloseRate)}</TableCell>
                    <TableCell className="text-right">{formatMoney(row.weighted)}</TableCell>
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

export function PipelineForecastReport() {
  return (
    <EstimatesReportsFiltersProvider urlPrefix="pipeline">
      <PipelineForecastReportInner />
    </EstimatesReportsFiltersProvider>
  );
}
