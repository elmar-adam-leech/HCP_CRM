import { useCallback, useMemo } from "react";
import { useLocation, useSearch } from "wouter";
import { LeadsTrendChart } from "@/components/dashboard/LeadsTrendChart";
import { SpeedToLeadReport } from "@/components/reports/SpeedToLeadReport";
import {
  ReportsTabLayout,
  type ReportItem,
} from "@/components/reports/ReportsTabLayout";
import { EstimatesReportsFiltersProvider } from "@/components/reports/estimates/shared";
import { RevenueReport } from "@/components/reports/estimates/RevenueReport";
import { LostRevenueReport } from "@/components/reports/estimates/LostRevenueReport";
import { PipelineForecastReport } from "@/components/reports/estimates/PipelineForecastReport";
import {
  CloseRateBySalespersonReport,
  CloseRateBySourceReport,
} from "@/components/reports/estimates/CloseRateReports";
import { TimeToCloseReport } from "@/components/reports/estimates/TimeToCloseReport";
import {
  PendingReport,
  InProgressReport,
} from "@/components/reports/estimates/OutstandingReports";
import { SalesActivityReport } from "@/components/reports/estimates/SalesActivityReport";
import { RepeatCustomerReport } from "@/components/reports/estimates/RepeatCustomerReport";
import { GeographicReport } from "@/components/reports/estimates/GeographicReport";
import { PageHeader } from "@/components/ui/page-header-v2";
import { PageLayout } from "@/components/ui/page-layout";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

type TabId = "leads" | "sales" | "estimates";

const TAB_REPORTS: Record<TabId, ReportItem[]> = {
  leads: [
    {
      slug: "leads-trend",
      name: "Leads Trend",
      render: () => <LeadsTrendChart />,
    },
  ],
  sales: [
    {
      slug: "speed-to-lead",
      name: "Speed to Lead",
      render: () => <SpeedToLeadReport />,
    },
  ],
  estimates: [
    { slug: "revenue", name: "Revenue", render: () => <RevenueReport /> },
    { slug: "lost-revenue", name: "Lost Revenue", render: () => <LostRevenueReport /> },
    {
      slug: "pipeline-forecast",
      name: "Pipeline Forecast",
      render: () => <PipelineForecastReport />,
    },
    {
      slug: "close-rate-salesperson",
      name: "Close Rate by Salesperson",
      render: () => <CloseRateBySalespersonReport />,
    },
    {
      slug: "close-rate-source",
      name: "Close Rate by Lead Source",
      render: () => <CloseRateBySourceReport />,
    },
    { slug: "time-to-close", name: "Time to Close", render: () => <TimeToCloseReport /> },
    { slug: "pending", name: "Pending Estimates", render: () => <PendingReport /> },
    { slug: "in-progress", name: "In-Progress Estimates", render: () => <InProgressReport /> },
    { slug: "sales-activity", name: "Sales Activity", render: () => <SalesActivityReport /> },
    {
      slug: "repeat-customers",
      name: "Repeat Customers",
      render: () => <RepeatCustomerReport />,
    },
    { slug: "geographic", name: "Geographic", render: () => <GeographicReport /> },
  ],
};

function isTabId(v: string | null): v is TabId {
  return v === "leads" || v === "sales" || v === "estimates";
}

function useReportsLocation() {
  const search = useSearch();
  const [, setLocation] = useLocation();

  const params = useMemo(() => new URLSearchParams(search), [search]);
  const tabParam = params.get("tab");
  const reportParam = params.get("report");

  const activeTab: TabId = isTabId(tabParam) ? tabParam : "leads";

  const reportsForTab = TAB_REPORTS[activeTab];
  const reportInTab =
    reportParam && reportsForTab.some((r) => r.slug === reportParam)
      ? reportParam
      : reportsForTab[0].slug;

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
          <TabsTrigger value="sales" data-testid="tab-reports-sales">
            Sales
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

        <TabsContent value="sales" className="mt-6">
          <ReportsTabLayout
            items={TAB_REPORTS.sales}
            activeSlug={activeReport}
            onSelect={setReport}
            testIdPrefix="sales-report"
          />
        </TabsContent>

        <TabsContent value="estimates" className="mt-6">
          <EstimatesReportsFiltersProvider>
            <ReportsTabLayout
              items={TAB_REPORTS.estimates}
              activeSlug={activeReport}
              onSelect={setReport}
              testIdPrefix="estimates-report"
            />
          </EstimatesReportsFiltersProvider>
        </TabsContent>
      </Tabs>
    </PageLayout>
  );
}
