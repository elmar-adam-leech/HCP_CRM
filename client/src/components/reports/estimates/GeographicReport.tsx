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
  EstimatesReportsFiltersProvider,
  ReportShell,
  Stat,
  formatMoney,
  formatPercent,
  useReportQuery,
} from "./shared";

interface GeographicData {
  rows: {
    city: string;
    state: string;
    estimateCount: number;
    wonCount: number;
    wonValue: number;
    closeRate: number;
    lowCloseRate: boolean;
  }[];
}

function GeographicReportInner() {
  const { data, isLoading, isError } = useReportQuery<GeographicData>(
    "/api/reports/estimates/geographic",
  );
  const isEmpty = !!data && data.rows.length === 0;
  const totalEstimates = data?.rows.reduce((a, r) => a + r.estimateCount, 0) ?? 0;
  const totalWon = data?.rows.reduce((a, r) => a + r.wonValue, 0) ?? 0;
  return (
    <ReportShell
      title="Geographic"
      description="Estimates and won dollars grouped by city. Cities with low close rates are flagged."
      isLoading={isLoading}
      isError={isError}
      isEmpty={isEmpty}
      emptyMessage="No estimates with city data in this date range."
      testId="card-geographic"
    >
      {data && (
        <>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
            <Stat label="Cities" value={data.rows.length.toString()} testId="stat-geo-cities" />
            <Stat label="Estimates" value={totalEstimates.toString()} testId="stat-geo-estimates" />
            <Stat label="Won" value={formatMoney(totalWon)} testId="stat-geo-won" />
          </div>
          <div className="overflow-x-auto">
            <Table data-testid="table-geographic">
              <TableHeader>
                <TableRow>
                  <TableHead>City</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead className="text-right">Estimates</TableHead>
                  <TableHead className="text-right">Won</TableHead>
                  <TableHead className="text-right">Won $</TableHead>
                  <TableHead className="text-right">Close rate</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.rows.map((row, i) => (
                  <TableRow
                    key={`${row.city}-${row.state}-${i}`}
                    data-testid={`row-geo-${i}`}
                  >
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-2">
                        {row.city}
                        {row.lowCloseRate && (
                          <Badge variant="secondary" className="bg-destructive/15 text-destructive">
                            Low close rate
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>{row.state}</TableCell>
                    <TableCell className="text-right">{row.estimateCount}</TableCell>
                    <TableCell className="text-right">{row.wonCount}</TableCell>
                    <TableCell className="text-right">{formatMoney(row.wonValue)}</TableCell>
                    <TableCell className="text-right">{formatPercent(row.closeRate)}</TableCell>
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

export function GeographicReport() {
  return (
    <EstimatesReportsFiltersProvider urlPrefix="geographic">
      <GeographicReportInner />
    </EstimatesReportsFiltersProvider>
  );
}
