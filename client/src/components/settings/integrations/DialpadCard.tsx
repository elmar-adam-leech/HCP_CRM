import { useCredentialManager } from "@/hooks/useCredentialManager";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Phone, MessageSquare, RefreshCw, AlertTriangle, Power, XCircle, Activity, Webhook } from "lucide-react";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useProviderConfig } from "@/hooks/use-provider-config";
import { useSyncStatus } from "@/hooks/use-sync-status";
import { useIntegrationCard, getStatusIcon, getStatusText } from "@/hooks/use-integration-card";
import { IntegrationCardShell } from "./IntegrationCardShell";
import { useCurrentUser } from "@/hooks/useCurrentUser";

interface ReregisterWebhookResponse {
  callSubscriptionsActive?: boolean;
  callSubscriptionWarning?: string;
  callSubscriptionError?: string;
  message?: string;
  error?: string;
}

export function DialpadCard() {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const { data: currentUserData } = useCurrentUser();
  const isSuperAdmin = currentUserData?.user?.role === 'super_admin';
  const { integration, isLoading, isError, isAdmin, toggleEnabled, isTogglingEnabled, saveCredentials, isSavingCredentials } = useIntegrationCard('dialpad');
  const { data: providerData } = useProviderConfig();
  const { syncStatus, startSync } = useSyncStatus();
  const {
    editingCredential,
    setEditingCredential,
    credentialInput,
    setCredentialInput,
    handleSaveCredentials,
    handleCancelEdit,
  } = useCredentialManager({ onSave: saveCredentials });

  const isEnabled = integration?.isEnabled ?? false;
  const hasCredentials = integration?.hasCredentials ?? false;

  const { data: webhookHealth } = useQuery<{
    callEventsReceived: boolean;
    lastCallEventAt: string | null;
    staleDays: number | null;
  }>({
    queryKey: ['/api/dialpad/webhooks/health'],
    enabled: hasCredentials && isEnabled && isSuperAdmin,
  });

  const setProviderMutation = useMutation({
    mutationFn: async ({ providerType, providerName }: { providerType: 'sms' | 'calling'; providerName: string }) => {
      const response = await apiRequest('POST', '/api/providers', { providerType, providerName });
      return response.json();
    },
    onSuccess: (_, { providerType, providerName }) => {
      toast({ title: "Provider Set", description: `${providerName} has been set as your ${providerType} provider.` });
      queryClient.invalidateQueries({ queryKey: ['/api/providers'] });
    },
    onError: (error: any) => { toast({ title: "Error", description: error.message || "Failed to set provider", variant: "destructive" }); },
  });

  const reregisterWebhooksMutation = useMutation<ReregisterWebhookResponse, Error>({
    mutationFn: async () => {
      const response = await fetch('/api/dialpad/webhooks/create', {
        method: 'POST',
        credentials: 'include',
      });
      const result: ReregisterWebhookResponse = await response.json();
      if (!response.ok && response.status !== 207) {
        throw new Error(result.message || result.error || `Request failed: ${response.status}`);
      }
      return result;
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['/api/dialpad/webhooks/health'] });
      queryClient.invalidateQueries({ queryKey: ['/api/integrations'] });
      if (result.callSubscriptionsActive === false) {
        const errorDetail = result.callSubscriptionError ?? result.message ?? 'Call subscriptions could not be created.';
        toast({
          title: 'Webhooks partially registered',
          description: `SMS webhook registered but call subscriptions failed: ${errorDetail}`,
          variant: 'destructive',
        });
      } else {
        const description = result.callSubscriptionWarning
          ? `Webhooks re-registered. ${result.callSubscriptionWarning}`
          : 'Webhooks re-registered';
        toast({ title: 'Webhooks re-registered', description });
      }
    },
    onError: (error) => {
      toast({
        title: 'Failed to re-register webhooks',
        description: error.message || 'An unexpected error occurred.',
        variant: 'destructive',
      });
    },
  });

  const syncMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest('POST', '/api/dialpad/sync');
      return response.json();
    },
    onMutate: () => { startSync(); },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ['/api/dialpad/users/available-phone-numbers'] });
      queryClient.invalidateQueries({ queryKey: ['/api/integrations'] });
      toast({ title: "Dialpad sync completed", description: `Successfully synced ${data.summary?.users?.cached || 0} users, ${data.summary?.departments?.cached || 0} departments, and ${data.summary?.phoneNumbers?.cached || 0} phone numbers.` });
    },
    onError: (error: any) => { toast({ title: "Dialpad sync failed", description: error.message || "Failed to sync with Dialpad. Please try again.", variant: "destructive" }); },
  });

  if (isLoading) {
    return (
      <IntegrationCardShell
        icon={<Phone className="h-5 w-5" />}
        title="Dialpad"
        description="SMS and calling services for customer communication"
        statusIcon={<></>}
        isLoading={true}
      >
        <></>
      </IntegrationCardShell>
    );
  }

  if (!integration) {
    return (
      <IntegrationCardShell
        icon={<Phone className="h-5 w-5" />}
        title="Dialpad"
        description="SMS and calling services for customer communication"
        statusIcon={<XCircle className="h-5 w-5 text-destructive" />}
        isLoading={false}
      >
        {isError ? (
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription className="text-sm flex items-center justify-between gap-2 flex-wrap">
              <span>Could not load Dialpad configuration.</span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => queryClient.invalidateQueries({ queryKey: ['/api/integrations'] })}
              >
                <RefreshCw className="h-3 w-3 mr-1" />
                Retry
              </Button>
            </AlertDescription>
          </Alert>
        ) : (
          <>
            <Badge variant="destructive">Not Configured</Badge>
            {isAdmin ? (
              <div className="space-y-3">
                <Label htmlFor="dialpad-api-key" className="text-sm font-medium">API Key</Label>
                <div className="flex flex-col sm:flex-row gap-2">
                  <Input
                    id="dialpad-api-key"
                    type="password"
                    placeholder="Enter your API key..."
                    value={credentialInput}
                    onChange={(e) => setCredentialInput(e.target.value)}
                    className="w-full"
                    data-testid="input-dialpad-api-key"
                  />
                  <div className="flex gap-2 shrink-0">
                    <Button onClick={handleSaveCredentials} disabled={isSavingCredentials || !credentialInput.trim()} data-testid="button-save-dialpad">
                      {isSavingCredentials ? "Saving..." : "Save"}
                    </Button>
                  </div>
                </div>
              </div>
            ) : (
              <Alert>
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription className="text-sm">Contact your administrator to configure Dialpad credentials.</AlertDescription>
              </Alert>
            )}
          </>
        )}
      </IntegrationCardShell>
    );
  }

  const status = getStatusText(integration);
  const isSyncing = syncMutation.isPending || syncStatus.isRunning;

  return (
    <IntegrationCardShell
      icon={<Phone className="h-5 w-5" />}
      title="Dialpad"
      description="SMS and calling services for customer communication"
      statusIcon={getStatusIcon(integration)}
      isLoading={false}
    >
      <Badge variant={status.variant}>{status.text}</Badge>
      {hasCredentials && (
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Power className="h-4 w-4 text-muted-foreground" />
            <Label htmlFor="dialpad-enabled" className="text-sm font-medium cursor-pointer">Enabled</Label>
          </div>
          <Switch id="dialpad-enabled" checked={integration.isEnabled} onCheckedChange={() => toggleEnabled(integration.isEnabled)} disabled={isTogglingEnabled} data-testid="switch-dialpad" />
        </div>
      )}

      {hasCredentials && isEnabled && (
        <div className="pt-3 border-t space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="dialpad-sms-service"
                checked={providerData?.configured?.find(p => p.providerType === 'sms' && p.isActive && p.smsProvider === 'dialpad') !== undefined}
                onChange={(e) => { if (e.target.checked) setProviderMutation.mutate({ providerType: 'sms', providerName: 'dialpad' }); }}
                disabled={setProviderMutation.isPending}
                className="rounded border-gray-300"
                data-testid="checkbox-dialpad-sms"
              />
              <Label htmlFor="dialpad-sms-service" className="text-sm cursor-pointer">Enable SMS Service</Label>
            </div>
            <MessageSquare className="h-4 w-4 text-muted-foreground" />
          </div>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="dialpad-calling-service"
                checked={providerData?.configured?.find(p => p.providerType === 'calling' && p.isActive && p.callingProvider === 'dialpad') !== undefined}
                onChange={(e) => { if (e.target.checked) setProviderMutation.mutate({ providerType: 'calling', providerName: 'dialpad' }); }}
                disabled={setProviderMutation.isPending}
                className="rounded border-gray-300"
                data-testid="checkbox-dialpad-calling"
              />
              <Label htmlFor="dialpad-calling-service" className="text-sm cursor-pointer">Enable Calling Service</Label>
            </div>
            <Phone className="h-4 w-4 text-muted-foreground" />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => syncMutation.mutate()} disabled={isSyncing} data-testid="button-dialpad-sync">
              <RefreshCw className={`h-4 w-4 mr-2 ${isSyncing ? 'animate-spin' : ''}`} />
              {isSyncing ? 'Syncing...' : 'Sync Dialpad Data'}
            </Button>
            {isAdmin && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => reregisterWebhooksMutation.mutate()}
                disabled={reregisterWebhooksMutation.isPending}
                data-testid="button-reregister-dialpad-webhooks"
              >
                {reregisterWebhooksMutation.isPending ? (
                  <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Webhook className="h-4 w-4 mr-2" />
                )}
                {reregisterWebhooksMutation.isPending ? 'Re-registering...' : 'Re-register Webhooks'}
              </Button>
            )}
          </div>
        </div>
      )}

      {hasCredentials && isEnabled && isSuperAdmin && (
        <div className="pt-3 border-t space-y-3">
          <div className="flex items-center gap-2 text-sm flex-wrap">
            <Activity className="h-4 w-4 text-muted-foreground shrink-0" />
            <span className="text-muted-foreground">
              Call events:{' '}
              {webhookHealth
                ? webhookHealth.callEventsReceived
                  ? (webhookHealth.staleDays !== null && webhookHealth.staleDays > 7)
                    ? <span className="text-amber-600 font-medium">stale ({webhookHealth.staleDays}d ago)</span>
                    : <span className="font-medium">active</span>
                  : <span className="text-muted-foreground font-medium">never received</span>
                : <span className="text-muted-foreground">—</span>
              }
            </span>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate('/dialpad/health')}
            data-testid="button-webhook-health"
          >
            <Activity className="h-4 w-4 mr-2" />
            Webhook Health
          </Button>
        </div>
      )}

      {hasCredentials && isAdmin && !editingCredential && (
        <div className="pt-3 border-t flex gap-2 flex-wrap">
          <Button variant="outline" size="sm" onClick={() => setEditingCredential(true)} data-testid="button-update-dialpad-api-key">
            Update API Key
          </Button>
          <Button variant="outline" size="sm" onClick={() => navigate('/dialpad-setup')} data-testid="button-enhanced-setup">
            Enhanced Setup
          </Button>
        </div>
      )}

      {(!hasCredentials || editingCredential) && (
        isAdmin ? (
          <div className="space-y-3">
            <Label htmlFor="dialpad-api-key" className="text-sm font-medium">
              {hasCredentials ? 'Update API Key' : 'API Key'}
            </Label>
            <div className="flex flex-col sm:flex-row gap-2">
              <Input
                id="dialpad-api-key"
                type="password"
                placeholder={hasCredentials ? "Enter new API key..." : "Enter your API key..."}
                value={credentialInput}
                onChange={(e) => setCredentialInput(e.target.value)}
                className="w-full"
                data-testid="input-dialpad-api-key"
              />
              <div className="flex gap-2 shrink-0">
                <Button onClick={handleSaveCredentials} disabled={isSavingCredentials || !credentialInput.trim()} data-testid="button-save-dialpad">
                  {isSavingCredentials ? "Saving..." : hasCredentials ? "Update" : "Save"}
                </Button>
                {editingCredential && (
                  <Button variant="outline" onClick={handleCancelEdit} data-testid="button-cancel-dialpad">
                    Cancel
                  </Button>
                )}
              </div>
            </div>
          </div>
        ) : (
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription className="text-sm">Contact your administrator to configure Dialpad credentials.</AlertDescription>
          </Alert>
        )
      )}
    </IntegrationCardShell>
  );
}
