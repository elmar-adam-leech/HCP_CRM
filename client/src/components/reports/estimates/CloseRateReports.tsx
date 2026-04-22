import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { ArrowUpDown } from "lucide-react";
import { useMemo, useState } from "react";
import {
  EstimatesReportsFiltersProvider,
  ReportShell,
  Stat,
  formatPercent,
  useReportQuery,
} from "./shared";

interface CloseRateRow {
  key: string;
  name: string;
  sent: number;
  won: number;
  lost: number;
  open: number;
  closeRate: number;
  decisionRate: number;
}

interface CloseRateData {
  rows: CloseRateRow[];
  totals: {
    sent: number;
    won: number;
    lost: number;
    open: number;
    closeRate: number;
    decisionRate: number;
  };
}

type SortKey = "name" | "sent" | "won" | "lost" | "open" | "closeRate" | "decisionRate";

function CloseRateTable({
  data,
  testId,
  groupLabel,
}: {
  data: CloseRateData;
  testId: string;
  groupLabel: string;
}) {
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({
    key: "closeRate",
    dir: "desc",
  });
  const sorted = useMemo(() => {
    const rows = [...data.rows];
    rows.sort((a, b) => {
      const av = a[sort.key];
      const bv = b[sort.key];
      let cmp = 0;
      if (typeof av === "string" && typeof bv === "string") cmp = av.localeCompare(bv);
      else cmp = (av as number) - (bv as number);
      return sort.dir === "asc" ? cmp : -cmp;
    });
    return rows;
  }, [data, sort]);
  const toggle = (k: SortKey) => {
    setSort((p) =>
      p.key === k
        ? { key: k, dir: p.dir === "asc" ? "desc" : "asc" }
        : { key: k, dir: k === "name" ? "asc" : "desc" },
    );
  };
  return (
    <div className="overflow-x-auto">
      <Table data-testid={testId}>
        <TableHeader>
          <TableRow>
            {([
              ["name", groupLabel, "left"],
              ["sent", "Sent", "right"],
              ["won", "Won", "right"],
              ["lost", "Lost", "right"],
              ["open", "Open", "right"],
              ["closeRate", "Close rate", "right"],
              ["decisionRate", "Decision rate", "right"],
            ] as const).map(([key, label, align]) => (
              <TableHead key={key} className={align === "right" ? "text-right" : ""}>
                <Button
                  variant="ghost"
                  size="sm"
                  className="-ml-2 h-7 px-2"
                  onClick={() => toggle(key as SortKey)}
                >
                  {label}
                  <ArrowUpDown className="ml-1 h-3 w-3" />
                </Button>
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map((row) => (
            <TableRow key={row.key} data-testid={`row-close-rate-${row.key}`}>
              <TableCell className="font-medium">{row.name}</TableCell>
              <TableCell className="text-right">{row.sent}</TableCell>
              <TableCell className="text-right">{row.won}</TableCell>
              <TableCell className="text-right">{row.lost}</TableCell>
              <TableCell className="text-right">{row.open}</TableCell>
              <TableCell className="text-right">{formatPercent(row.closeRate)}</TableCell>
              <TableCell className="text-right">{formatPercent(row.decisionRate)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function CloseRateBySalespersonReportInner() {
  const { data, isLoading, isError } = useReportQuery<CloseRateData>(
    "/api/reports/estimates/close-rate-by-salesperson",
  );
  const isEmpty = !!data && data.totals.sent === 0;
  return (
    <ReportShell
      title="Close rate by salesperson"
      description="Close rate is won out of all estimates sent — open estimates count against it. Decision rate is won out of estimates the customer actually decided (won + lost), ignoring open pipeline."
      isLoading={isLoading}
      isError={isError}
      isEmpty={isEmpty}
      testId="card-close-rate-salesperson"
    >
      {data && (
        <>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
            <Stat label="Sent" value={data.totals.sent.toString()} testId="stat-cr-sent" />
            <Stat label="Won" value={data.totals.won.toString()} testId="stat-cr-won" />
            <Stat label="Lost" value={data.totals.lost.toString()} testId="stat-cr-lost" />
            <Stat
              label="Close rate"
              value={formatPercent(data.totals.closeRate)}
              testId="stat-cr-rate"
            />
            <Stat
              label="Decision rate"
              value={formatPercent(data.totals.decisionRate)}
              testId="stat-cr-decision-rate"
            />
          </div>
          <CloseRateTable
            data={data}
            testId="table-close-rate-salesperson"
            groupLabel="Salesperson"
          />
        </>
      )}
    </ReportShell>
  );
}

function CloseRateBySourceReportInner() {
  const { data, isLoading, isError } = useReportQuery<CloseRateData>(
    "/api/reports/estimates/close-rate-by-source",
  );
  const isEmpty = !!data && data.totals.sent === 0;
  return (
    <ReportShell
      title="Close rate by lead source"
      description="Close rate is won out of all estimates sent — open estimates count against it. Decision rate is won out of estimates the customer actually decided (won + lost), ignoring open pipeline. Grouped by the originating lead's source."
      showLeadSource={false}
      isLoading={isLoading}
      isError={isError}
      isEmpty={isEmpty}
      testId="card-close-rate-source"
    >
      {data && (
        <>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
            <Stat label="Sent" value={data.totals.sent.toString()} testId="stat-crs-sent" />
            <Stat label="Won" value={data.totals.won.toString()} testId="stat-crs-won" />
            <Stat label="Lost" value={data.totals.lost.toString()} testId="stat-crs-lost" />
            <Stat
              label="Close rate"
              value={formatPercent(data.totals.closeRate)}
              testId="stat-crs-rate"
            />
            <Stat
              label="Decision rate"
              value={formatPercent(data.totals.decisionRate)}
              testId="stat-crs-decision-rate"
            />
          </div>
          <CloseRateTable data={data} testId="table-close-rate-source" groupLabel="Source" />
        </>
      )}
    </ReportShell>
  );
}

export function CloseRateBySalespersonReport() {
  return (
    <EstimatesReportsFiltersProvider urlPrefix="crSalesperson">
      <CloseRateBySalespersonReportInner />
    </EstimatesReportsFiltersProvider>
  );
}

export function CloseRateBySourceReport() {
  return (
    <EstimatesReportsFiltersProvider urlPrefix="crSource">
      <CloseRateBySourceReportInner />
    </EstimatesReportsFiltersProvider>
  );
}
