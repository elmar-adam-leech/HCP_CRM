import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { useCurrentUser, isStrictAdmin } from "@/hooks/useCurrentUser";
import { PageHeader } from "@/components/ui/page-header-v2";
import { PageLayout } from "@/components/ui/page-layout";
import { IntegrationsTab } from "@/components/settings/integrations/IntegrationsTab";
import { AccountTab } from "@/components/settings/account/AccountTab";
import { SecurityTab } from "@/components/settings/security/SecurityTab";
import { TargetsTab } from "@/components/settings/targets/TargetsTab";
import { WebhooksTab } from "@/components/settings/webhooks/WebhooksTab";
import { SalespeopleTab } from "@/components/settings/salespeople/SalespeopleTab";
import { AssignmentsTab } from "@/components/settings/assignments/AssignmentsTab";
import { PrivacyTab } from "@/components/settings/privacy/PrivacyTab";
import { SalesProcessTab } from "@/components/settings/sales-process/SalesProcessTab";
import { AdSpendTab } from "@/components/settings/ad-spend/AdSpendTab";
type TabId = 'account' | 'integrations' | 'security' | 'targets' | 'webhooks' | 'salespeople' | 'assignments' | 'privacy' | 'sales_process' | 'ad_spend';

export default function Settings() {
  const [, navigate] = useLocation();

  const urlParams = new URLSearchParams(window.location.search);
  const urlTab = urlParams.get('tab') as TabId | null;
  const [activeTab, setActiveTab] = useState<TabId>(urlTab || 'account');

  const { data: currentUser, isLoading: userLoading } = useCurrentUser();

  const isAdmin = isStrictAdmin(currentUser?.user?.role);
  const canManageIntegrations = isAdmin
    || currentUser?.user?.role === 'manager'
    || currentUser?.user?.canManageIntegrations === true;

  useEffect(() => {
    if (!userLoading && currentUser?.user) {
      if (!canManageIntegrations && activeTab === 'integrations') {
        setActiveTab('account');
        navigate('/settings?tab=account');
      }
    }
  }, [currentUser, userLoading, activeTab, navigate, canManageIntegrations]);

  const goTab = (tab: TabId) => {
    setActiveTab(tab);
    navigate(`/settings?tab=${tab}`);
  };

  const tabBtn = (id: TabId, label: string, testId: string) => (
    <button
      key={id}
      onClick={() => goTab(id)}
      className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors whitespace-nowrap shrink-0 ${activeTab === id ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
      data-testid={testId}
    >
      {label}
    </button>
  );

  return (
    <PageLayout>
      <PageHeader title="Settings" description="Configure integrations, manage users, and set business targets" />

      <div className="flex space-x-1 border-b mb-6 overflow-x-auto scrollbar-hide" style={{ WebkitOverflowScrolling: 'touch' }}>
        {tabBtn('account', 'Account', 'tab-account')}
        {canManageIntegrations && tabBtn('integrations', 'Integrations', 'tab-integrations')}
        {tabBtn('security', 'Security', 'tab-security')}
        {isAdmin && tabBtn('targets', 'Performance Targets', 'tab-targets')}
        {canManageIntegrations && tabBtn('ad_spend', 'Ad Spend', 'tab-ad-spend')}
        {tabBtn('webhooks', 'Webhooks', 'tab-webhooks')}
        {isAdmin && tabBtn('salespeople', 'Salespeople', 'tab-salespeople')}
        {isAdmin && tabBtn('assignments', 'Assignments', 'tab-assignments')}
        {canManageIntegrations && tabBtn('sales_process', 'Sales Process', 'tab-sales-process')}
        {isAdmin && tabBtn('privacy', 'Privacy & Data', 'tab-privacy')}
      </div>

      {activeTab === 'account' && <AccountTab />}
      {activeTab === 'integrations' && <IntegrationsTab />}
      {activeTab === 'security' && <SecurityTab />}
      {activeTab === 'targets' && <TargetsTab />}
      {activeTab === 'ad_spend' && canManageIntegrations && <AdSpendTab />}
      {activeTab === 'webhooks' && <WebhooksTab />}
      {activeTab === 'salespeople' && <SalespeopleTab />}
      {activeTab === 'assignments' && isAdmin && <AssignmentsTab />}
      {activeTab === 'sales_process' && canManageIntegrations && <SalesProcessTab />}
      {activeTab === 'privacy' && isAdmin && <PrivacyTab />}
    </PageLayout>
  );
}
