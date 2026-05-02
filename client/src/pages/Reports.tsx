import { useCallback, useEffect, useMemo, lazy, Suspense, type ReactNode } from "react";
import { useLocation, useSearch } from "wouter";
import { Loader2 } from "lucide-react";
import {
  ReportsTabLayout,
  type ReportItem,
} from "@/components/reports/ReportsTabLayout";
import {
  EstimatesReportsFiltersProvider,
  usePrefetchEstimatesReports,
} from "@/components/reports/estimates/shared";
import { PageHeader } from "@/components/ui/page-header-v2";
import { PageLayout } from "@/components/ui/page-layout";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

// Each individual report (and the recharts code it pulls in) is lazy-loaded
// so that landing on /reports doesn't have to download the ~352 KB charts
// vendor bundle before the page can paint. Reports that don't use recharts
// are also lazy so the initial Reports chunk stays small.
const LeadsTrendChart = lazy(() =>
  import("@/components/dashboard/LeadsTrendChart").then((m) => ({
    default: m.LeadsTrendChart,
  })),
);
const SpeedToLeadReport = lazy(() =>
  import("@/components/reports/SpeedToLeadReport").then((m) => ({
    default: m.SpeedToLeadReport,
  })),
);
const RevenueReport = lazy(() =>
  import("@/components/reports/estimates/RevenueReport").then((m) => ({
    default: m.RevenueReport,
  })),
);
const LostRevenueReport = lazy(() =>
  import("@/components/reports/estimates/LostRevenueReport").then((m) => ({
    default: m.LostRevenueReport,
  })),
);
const PipelineForecastReport = lazy(() =>
  import("@/components/reports/estimates/PipelineForecastReport").then((m) => ({
    default: m.PipelineForecastReport,
  })),
);
const CloseRateBySalespersonReport = lazy(() =>
  import("@/components/reports/estimates/CloseRateReports").then((m) => ({
    default: m.CloseRateBySalespersonReport,
  })),
);
const CloseRateBySourceReport = lazy(() =>
  import("@/components/reports/estimates/CloseRateReports").then((m) => ({
    default: m.CloseRateBySourceReport,
  })),
);
const TimeToCloseReport = lazy(() =>
  import("@/components/reports/estimates/TimeToCloseReport").then((m) => ({
    default: m.TimeToCloseReport,
  })),
);
const PendingReport = lazy(() =>
  import("@/components/reports/estimates/OutstandingReports").then((m) => ({
    default: m.PendingReport,
  })),
);
const InProgressReport = lazy(() =>
  import("@/components/reports/estimates/OutstandingReports").then((m) => ({
    default: m.InProgressReport,
  })),
);
const SalesActivityReport = lazy(() =>
  import("@/components/reports/estimates/SalesActivityReport").then((m) => ({
    default: m.SalesActivityReport,
  })),
);
const GeographicReport = lazy(() =>
  import("@/components/reports/estimates/GeographicReport").then((m) => ({
    default: m.GeographicReport,
  })),
);

function ReportFallback() {
  return (
    <div className="flex items-center justify-center h-[300px]">
      <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
    </div>
  );
}

function lazyRender(node: ReactNode) {
  return <Suspense fallback={<ReportFallback />}>{node}</Suspense>;
}

type TabId = "leads" | "estimates";

// Map each estimates report slug to the API endpoint it loads. Used to prefetch
// the neighbors of the active report so the next click feels instant.
const ESTIMATES_REPORT_PATHS: Record<string, string> = {
  revenue: "/api/reports/estimates/revenue",
  "lost-revenue": "/api/reports/estimates/lost-revenue",
  "pipeline-forecast": "/api/reports/estimates/pipeline-forecast",
  "close-rate-salesperson": "/api/reports/estimates/close-rate-by-salesperson",
  "close-rate-source": "/api/reports/estimates/close-rate-by-source",
  "time-to-close": "/api/reports/estimates/time-to-close",
  pending: "/api/reports/estimates/pending",
  "in-progress": "/api/reports/estimates/in-progress",
  "sales-activity": "/api/reports/estimates/sales-activity",
  geographic: "/api/reports/estimates/geographic",
};

function EstimatesReportsTab({
  activeReport,
  onSelect,
}: {
  activeReport: string;
  onSelect: (slug: string) => void;
}) {
  // Prefetch the two neighbors on either side of the current report so users
  // who scan adjacent tabs don't see a skeleton.
  const neighborPaths = useMemo(() => {
    const slugs = TAB_REPORTS.estimates.map((r) => r.slug);
    const idx = Math.max(0, slugs.indexOf(activeReport));
    const out: string[] = [];
    for (let offset = -2; offset <= 2; offset++) {
      if (offset === 0) continue;
      const slug = slugs[idx + offset];
      if (!slug) continue;
      const path = ESTIMATES_REPORT_PATHS[slug];
      if (path) out.push(path);
    }
    return out;
  }, [activeReport]);
  usePrefetchEstimatesReports(neighborPaths);
  return (
    <ReportsTabLayout
      items={TAB_REPORTS.estimates}
      activeSlug={activeReport}
      onSelect={onSelect}
      testIdPrefix="estimates-report"
    />
  );
}

const TAB_REPORTS: Record<TabId, ReportItem[]> = {
  leads: [
    {
      slug: "leads-trend",
      name: "Leads Trend",
      render: () => lazyRender(<LeadsTrendChart />),
    },
    {
      slug: "speed-to-lead",
      name: "Speed to Lead",
      render: () => lazyRender(<SpeedToLeadReport />),
    },
  ],
  estimates: [
    { slug: "revenue", name: "Revenue", render: () => lazyRender(<RevenueReport />) },
    { slug: "lost-revenue", name: "Lost Revenue", render: () => lazyRender(<LostRevenueReport />) },
    {
      slug: "pipeline-forecast",
      name: "Pipeline Forecast",
      render: () => lazyRender(<PipelineForecastReport />),
    },
    {
      slug: "close-rate-salesperson",
      name: "Close Rate by Salesperson",
      render: () => lazyRender(<CloseRateBySalespersonReport />),
    },
    {
      slug: "close-rate-source",
      name: "Close Rate by Lead Source",
      render: () => lazyRender(<CloseRateBySourceReport />),
    },
    { slug: "time-to-close", name: "Time to Close", render: () => lazyRender(<TimeToCloseReport />) },
    { slug: "pending", name: "Pending Estimates", render: () => lazyRender(<PendingReport />) },
    { slug: "in-progress", name: "In-Progress Estimates", render: () => lazyRender(<InProgressReport />) },
    { slug: "sales-activity", name: "Sales Activity", render: () => lazyRender(<SalesActivityReport />) },
    { slug: "geographic", name: "Geographic", render: () => lazyRender(<GeographicReport />) },
  ],
};

function isTabId(v: string | null): v is TabId {
  return v === "leads" || v === "estimates";
}

function useReportsLocation() {
  const search = useSearch();
  const [, setLocation] = useLocation();

  const params = useMemo(() => new URLSearchParams(search), [search]);
  const tabParam = params.get("tab");
  const reportParam = params.get("report");

  // Legacy redirect: the Sales tab no longer exists. Old bookmarks like
  // /reports?tab=sales&report=speed-to-lead should land on Leads (and keep
  // Speed to Lead selected if that's what was requested), with the URL
  // rewritten so the address bar reflects the new canonical location.
  const isLegacySalesTab = tabParam === "sales";
  const activeTab: TabId = isLegacySalesTab
    ? "leads"
    : isTabId(tabParam)
      ? tabParam
      : "leads";

  const reportsForTab = TAB_REPORTS[activeTab];
  const reportInTab =
    reportParam && reportsForTab.some((r) => r.slug === reportParam)
      ? reportParam
      : reportsForTab[0].slug;

  useEffect(() => {
    if (!isLegacySalesTab) return;
    const next = new URLSearchParams(params);
    next.set("tab", "leads");
    next.set("report", reportInTab);
    setLocation(`/reports?${next.toString()}`, { replace: true });
  }, [isLegacySalesTab, params, reportInTab, setLocation]);

  const setTab = useCallback(
    (tab: TabId) => {
      const next = new URLSearchParams(params);
      next.set("tab", tab);
      const tabReports = TAB_REPORTS[tab];
      const currentReport = next.get("report");
      if (!currentReport || !tabReports.some((r) => r.slug === currentReport)) {
        next.set("report", tabReports[0].slug);
      }
      setLocation(`/reports?${next.toString()}`);
    },
    [params, setLocation],
  );

  const setReport = useCallback(
    (slug: string) => {
      const next = new URLSearchParams(params);
      if (!next.get("tab")) next.set("tab", activeTab);
      next.set("report", slug);
      setLocation(`/reports?${next.toString()}`);
    },
    [params, setLocation, activeTab],
  );

  return { activeTab, activeReport: reportInTab, setTab, setReport };
}

export default function Reports() {
  const { activeTab, activeReport, setTab, setReport } = useReportsLocation();

  return (
    <PageLayout>
      <PageHeader
        title="Reports"
        description="View analytics and insights for your business"
      />

      <Tabs
        value={activeTab}
        onValueChange={(v) => isTabId(v) && setTab(v)}
        className="w-full"
      >
        <TabsList>
          <TabsTrigger value="leads" data-testid="tab-reports-leads">
            Leads
          </TabsTrigger>
          <TabsTrigger value="estimates" data-testid="tab-reports-estimates">
            Estimates
          </TabsTrigger>
        </TabsList>

        <TabsContent value="leads" className="mt-6">
          <ReportsTabLayout
            items={TAB_REPORTS.leads}
            activeSlug={activeReport}
            onSelect={setReport}
            testIdPrefix="leads-report"
          />
        </TabsContent>

        <TabsContent value="estimates" className="mt-6">
          <EstimatesReportsFiltersProvider>
            <EstimatesReportsTab activeReport={activeReport} onSelect={setReport} />
          </EstimatesReportsFiltersProvider>
        </TabsContent>
      </Tabs>
    </PageLayout>
  );
}
