import { DashboardMetrics } from "@/components/DashboardMetrics";
import { FollowUpsWidget } from "@/components/FollowUpsWidget";
import { RecentActivityTimeline } from "@/components/RecentActivityTimeline";
import { PageHeader } from "@/components/ui/page-header-v2";
import { PageLayout } from "@/components/ui/page-layout";
import { useWebSocketInvalidation } from "@/hooks/useWebSocketInvalidation";

export default function Dashboard() {
  useWebSocketInvalidation([
    {
      types: ['contact_updated', 'contact_created', 'contact_deleted'],
      queryKeys: ['/api/dashboard/metrics', '/api/contacts/follow-ups', '/api/estimates/follow-ups'],
    },
    {
      types: ['activity_created', 'activity_updated', 'activity_deleted'],
      queryKeys: ['/api/activities', '/api/dashboard/metrics'],
    },
    {
      types: ['estimate_created', 'estimate_updated'],
      queryKeys: ['/api/dashboard/metrics'],
    },
    {
      types: ['job_created', 'job_updated'],
      queryKeys: ['/api/jobs', '/api/dashboard/metrics'],
    },
  ]);

  return (
    <PageLayout>
      <PageHeader
        title="Dashboard"
        description="Overview of your business performance and recent activity"
      />

      <DashboardMetrics />
      <FollowUpsWidget />
      <RecentActivityTimeline limit={8} />
    </PageLayout>
  );
}
