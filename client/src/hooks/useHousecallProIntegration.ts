import { useQuery } from "@tanstack/react-query";
import { useCurrentUser } from "@/hooks/useCurrentUser";

type HCPIntegration = { name: string; hasCredentials: boolean; isEnabled: boolean };
type IntegrationsResponse = { integrations: HCPIntegration[] };

export function useHousecallProIntegration() {
  const { data: currentUserData } = useCurrentUser();
  const user = currentUserData?.user;

  const canManageIntegrations =
    user?.role === "admin" ||
    user?.role === "super_admin" ||
    user?.role === "manager" ||
    user?.canManageIntegrations === true;

  const { data: integrationsData } = useQuery<IntegrationsResponse>({
    queryKey: ["/api/integrations"],
    enabled: canManageIntegrations,
  });

  const integrations = integrationsData?.integrations ?? [];
  const housecallProIntegration = integrations.find((i) => i.name === "housecall-pro");
  const isHousecallProConfigured =
    (housecallProIntegration?.hasCredentials && housecallProIntegration?.isEnabled) ?? false;

  const { data: syncStartDateData, isLoading: syncDateLoading } = useQuery<{
    syncStartDate: string | null;
  }>({
    queryKey: ["/api/housecall-pro/sync-start-date"],
    enabled: isHousecallProConfigured,
  });

  return {
    isHousecallProConfigured,
    syncStartDate: syncStartDateData?.syncStartDate ?? null,
    isLoading: syncDateLoading,
  };
}
