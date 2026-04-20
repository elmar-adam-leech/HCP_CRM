import { useState, useRef, useEffect } from "react";
import { useCredentialManager } from "@/hooks/useCredentialManager";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Calendar, CheckCircle, AlertTriangle, RefreshCw, Copy, Info, Power, X, Map, RotateCcw, Key, ExternalLink, Clock } from "lucide-react";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useSyncStatus } from "@/hooks/use-sync-status";
import { useIntegrationCard, getStatusIcon, getStatusText } from "@/hooks/use-integration-card";
import { IntegrationCardShell } from "./IntegrationCardShell";

function formatRelativeTime(isoString: string): string {
  const diffMs = Date.now() - new Date(isoString).getTime();
  if (diffMs < 0) return 'just now';
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return 'just now';
  if (minutes === 1) return '1 minute ago';
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours === 1) return '1 hour ago';
  if (hours < 24) return `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return '1 day ago';
  return `${days} days ago`;
}

const APP_SOURCES = [
  { key: 'facebook', label: 'Facebook' },
  { key: 'google', label: 'Google' },
  { key: 'website', label: 'Website' },
  { key: 'email', label: 'Email' },
  { key: 'referral', label: 'Referral' },
  { key: 'webhook', label: 'Webhook / Manual' },
];

export function HousecallProCard() {
  const { toast } = useToast();
  const { integration, isLoading, isAdmin, toggleEnabled, isTogglingEnabled, saveCredentials, isSavingCredentials } = useIntegrationCard('housecall-pro');
  const { syncStatus, startSync } = useSyncStatus();
  const {
    editingCredential,
    setEditingCredential,
    credentialInput,
    setCredentialInput,
    handleSaveCredentials,
    handleCancelEdit,
  } = useCredentialManager({ onSave: saveCredentials });
  const [hcpSecretDialogOpen, setHcpSecretDialogOpen] = useState(false);
  const [hcpSecretInput, setHcpSecretInput] = useState('');
  const [regenerateDialogOpen, setRegenerateDialogOpen] = useState(false);
  const [regenerateConfirmed, setRegenerateConfirmed] = useState(false);
  const [regeneratedUrl, setRegeneratedUrl] = useState<string | null>(null);
  const [hcpSyncDateInput, setHcpSyncDateInput] = useState<string | null>(null);
  const [skipTagInput, setSkipTagInput] = useState('');
  const skipTagInputRef = useRef<HTMLInputElement>(null);
  const [leadSourceMappingOpen, setLeadSourceMappingOpen] = useState(false);
  const [mappingDraft, setMappingDraft] = useState<Record<string, string>>({});
  const [defaultLeadSourceDraft, setDefaultLeadSourceDraft] = useState<string>('');
  const [customRows, setCustomRows] = useState<Array<{ key: string; hcpSource: string }>>([]);

  const { data: webhookConfig, error: webhookConfigError } = useQuery<{ webhookUrl: string; tokenStatus: 'valid' | 'missing' | 'read_error'; secretConfigured: boolean }>({
    queryKey: ['/api/integrations/housecall-pro/webhook-config'],
    enabled: integration?.isEnabled === true,
    retry: false,
  });

  const { data: webhookStatus } = useQuery<{ lastEventAt: string | null; status: 'healthy' | 'warning' | 'disabled'; statusReason?: string; serverStartedAt: string; rejectionCount24h: number; lastRejectionReason: string | null }>({
    queryKey: ['/api/integrations/housecall-pro/webhook-status'],
    enabled: integration?.isEnabled === true,
    refetchInterval: 5 * 60 * 1000,
    refetchIntervalInBackground: false,
  });

  const { data: syncDateData } = useQuery<{ syncStartDate: string | null }>({
    queryKey: ['/api/housecall-pro/sync-start-date'],
    enabled: integration?.isEnabled === true,
  });

  const { data: hcpLeadSettings, isLoading: isLoadingHcpLeadSettings } = useQuery<{ hcpSendLeads: boolean; hcpSyncSkipTags: string[] }>({
    queryKey: ['/api/settings/hcp-lead-settings'],
    enabled: integration?.isEnabled === true,
  });

  const { data: hcpLeadSourcesData } = useQuery<{ sources: string[] }>({
    queryKey: ['/api/integrations/housecall-pro/lead-sources'],
    enabled: leadSourceMappingOpen,
  });

  const { data: hcpLeadMappingData } = useQuery<{ mapping: Record<string, string>; defaultLeadSource: string | null }>({
    queryKey: ['/api/settings/hcp-lead-source-mapping'],
    enabled: leadSourceMappingOpen,
  });

  const refreshLeadSourcesMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest('POST', '/api/integrations/housecall-pro/lead-sources/refresh');
      return res.json();
    },
    onSuccess: (data: { sources: string[] }) => {
      queryClient.setQueryData(['/api/integrations/housecall-pro/lead-sources'], data);
      toast({ title: 'Lead sources refreshed' });
    },
    onError: () => toast({ title: 'Failed to refresh lead sources', variant: 'destructive' }),
  });

  const saveLeadMappingMutation = useMutation({
    mutationFn: async (data: { mapping: Record<string, string>; defaultLeadSource: string | null }) =>
      apiRequest('PATCH', '/api/settings/hcp-lead-source-mapping', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/settings/hcp-lead-source-mapping'] });
      toast({ title: 'Lead source mapping saved' });
      setLeadSourceMappingOpen(false);
    },
    onError: () => toast({ title: 'Failed to save lead source mapping', variant: 'destructive' }),
  });

  const hcpLeadSettingsMutation = useMutation({
    mutationFn: async (data: { hcpSendLeads?: boolean; hcpSyncSkipTags?: string[] }) =>
      apiRequest('PATCH', '/api/settings/hcp-lead-settings', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/settings/hcp-lead-settings'] });
    },
    onError: () => toast({ title: 'Failed to save lead settings', variant: 'destructive' }),
  });

  const saveWebhookSecretMutation = useMutation({
    mutationFn: async (secret: string) => apiRequest('POST', '/api/integrations/housecall-pro/webhook-secret', { secret }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/integrations/housecall-pro/webhook-config'] });
      toast({ title: 'Webhook secret saved' });
      setHcpSecretDialogOpen(false);
      setHcpSecretInput('');
    },
    onError: () => toast({ title: 'Failed to save webhook secret', variant: 'destructive' }),
  });

  const removeWebhookSecretMutation = useMutation({
    mutationFn: async () => apiRequest('DELETE', '/api/integrations/housecall-pro/webhook-secret'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/integrations/housecall-pro/webhook-config'] });
      toast({ title: 'Webhook secret removed' });
      setHcpSecretDialogOpen(false);
      setHcpSecretInput('');
    },
    onError: () => toast({ title: 'Failed to remove webhook secret', variant: 'destructive' }),
  });

  const regenerateTokenMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest('POST', '/api/integrations/housecall-pro/webhook-token/regenerate');
      return res.json() as Promise<{ webhookUrl: string; tokenStatus: 'valid'; warning: string }>;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['/api/integrations/housecall-pro/webhook-config'] });
      setRegeneratedUrl(data.webhookUrl);
      navigator.clipboard.writeText(data.webhookUrl).catch(() => {});
      toast({ title: 'New webhook URL copied to clipboard' });
      setRegenerateConfirmed(false);
    },
    onError: () => toast({ title: 'Failed to regenerate webhook URL', variant: 'destructive' }),
  });

  const syncMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest('POST', '/api/housecall-pro/sync');
      return response.json();
    },
    onSuccess: () => {
      startSync();
      queryClient.invalidateQueries({ queryKey: ['/api/integrations'] });
    },
    onError: (error: any) => { toast({ title: 'Housecall Pro sync failed', description: error.message || 'Failed to sync with Housecall Pro. Please try again.', variant: 'destructive' }); },
  });

  const saveSyncDateMutation = useMutation({
    mutationFn: async (syncStartDate: string | null) =>
      apiRequest('POST', '/api/housecall-pro/sync-start-date', { syncStartDate }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/housecall-pro/sync-start-date'] });
      toast({ title: 'Sync start date saved' });
      setHcpSyncDateInput(null);
    },
    onError: (error: any) => toast({ title: 'Failed to save sync start date', description: error.message, variant: 'destructive' }),
  });

  const isSyncing = syncMutation.isPending || syncStatus.isRunning;

  const currentSkipTags = hcpLeadSettings?.hcpSyncSkipTags ?? [];
  const currentSendLeads = hcpLeadSettings?.hcpSendLeads ?? true;

  const handleAddSkipTag = () => {
    const tag = skipTagInput.trim();
    if (!tag || currentSkipTags.includes(tag)) {
      setSkipTagInput('');
      return;
    }
    hcpLeadSettingsMutation.mutate({ hcpSyncSkipTags: [...currentSkipTags, tag] });
    setSkipTagInput('');
    skipTagInputRef.current?.focus();
  };

  const handleRemoveSkipTag = (tag: string) => {
    hcpLeadSettingsMutation.mutate({ hcpSyncSkipTags: currentSkipTags.filter(t => t !== tag) });
  };

  const STANDARD_KEYS = new Set(APP_SOURCES.map(s => s.key));

  useEffect(() => {
    if (leadSourceMappingOpen && hcpLeadMappingData) {
      const fullMapping = hcpLeadMappingData.mapping ?? {};
      const standardDraft: Record<string, string> = {};
      const customDraft: Array<{ key: string; hcpSource: string }> = [];
      for (const [k, v] of Object.entries(fullMapping)) {
        if (STANDARD_KEYS.has(k)) {
          standardDraft[k] = v;
        } else {
          customDraft.push({ key: k, hcpSource: v });
        }
      }
      setMappingDraft(standardDraft);
      setCustomRows(customDraft);
      setDefaultLeadSourceDraft(hcpLeadMappingData.defaultLeadSource ?? '');
    }
  }, [leadSourceMappingOpen, hcpLeadMappingData]);

  const handleOpenMappingDialog = () => {
    setMappingDraft({});
    setCustomRows([]);
    setDefaultLeadSourceDraft('');
    setLeadSourceMappingOpen(true);
  };

  if (isLoading) {
    return (
      <IntegrationCardShell
        icon={<Calendar className="h-5 w-5" />}
        title="Housecall Pro"
        description="Business management and scheduling integration"
        statusIcon={<></>}
        isLoading={true}
      >
        <></>
      </IntegrationCardShell>
    );
  }

  if (!integration) return null;

  const status = getStatusText(integration);

  const titleExtra = integration.setupInstructions ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" className="h-5 w-5 p-0">
          <Info className="h-4 w-4 text-muted-foreground" />
        </Button>
      </TooltipTrigger>
      <TooltipContent className="max-w-sm">
        <div className="space-y-2">
          <p className="font-medium text-sm">{integration.setupInstructions.title}</p>
          <ol className="text-xs space-y-1 list-decimal list-inside">
            {integration.setupInstructions.steps.map((step, idx) => <li key={idx}>{step}</li>)}
          </ol>
        </div>
      </TooltipContent>
    </Tooltip>
  ) : undefined;

  return (
    <>
      <IntegrationCardShell
        icon={<Calendar className="h-5 w-5" />}
        title="Housecall Pro"
        titleExtra={titleExtra}
        description="Business management and scheduling integration"
        statusIcon={getStatusIcon(integration)}
        isLoading={false}
      >
        <Badge variant={status.variant}>{status.text}</Badge>
        {integration.hasCredentials && (
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Power className="h-4 w-4 text-muted-foreground" />
              <Label htmlFor="hcp-enabled" className="text-sm font-medium cursor-pointer">Enabled</Label>
            </div>
            <Switch id="hcp-enabled" checked={integration.isEnabled} onCheckedChange={() => toggleEnabled(integration.isEnabled)} disabled={isTogglingEnabled} data-testid="switch-housecall-pro" />
          </div>
        )}

        {integration.isEnabled && !isLoadingHcpLeadSettings && (
          <div className="pt-3 border-t space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 flex-wrap">
                <Label htmlFor="hcp-send-leads" className="text-sm font-medium cursor-pointer">Send Leads to HCP</Label>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleOpenMappingDialog}
                  data-testid="button-hcp-lead-source-mapping"
                >
                  <Map className="h-3 w-3 mr-1" />
                  Lead Source Mapping
                </Button>
              </div>
              <Switch
                id="hcp-send-leads"
                checked={currentSendLeads}
                onCheckedChange={(checked) => hcpLeadSettingsMutation.mutate({ hcpSendLeads: checked })}
                disabled={hcpLeadSettingsMutation.isPending}
                data-testid="switch-hcp-send-leads"
              />
            </div>
            {currentSendLeads && (
              <div className="space-y-2">
                <Label className="text-sm font-medium">Skip for leads with these tags</Label>
                <p className="text-xs text-muted-foreground">Leads that carry any of these tags will not be pushed to HCP.</p>
                <div className="flex gap-2">
                  <Input
                    ref={skipTagInputRef}
                    value={skipTagInput}
                    onChange={(e) => setSkipTagInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAddSkipTag(); } }}
                    placeholder="Enter a tag name..."
                    className="flex-1"
                    data-testid="input-hcp-skip-tag"
                  />
                  <Button variant="outline" size="default" onClick={handleAddSkipTag} disabled={!skipTagInput.trim() || hcpLeadSettingsMutation.isPending} data-testid="button-hcp-add-skip-tag">
                    Add
                  </Button>
                </div>
                {currentSkipTags.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {currentSkipTags.map((tag) => (
                      <Badge key={tag} variant="secondary" className="gap-1 no-default-active-elevate">
                        {tag}
                        <button
                          type="button"
                          onClick={() => handleRemoveSkipTag(tag)}
                          className="ml-0.5 rounded-full hover-elevate"
                          data-testid={`button-hcp-remove-skip-tag-${tag}`}
                          aria-label={`Remove tag ${tag}`}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {integration.isEnabled && webhookConfigError && (
          <div className="pt-3 border-t">
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription className="text-xs">
                Error reading webhook token — check server logs or contact support. Your existing webhook URL in Housecall Pro may still be active.
              </AlertDescription>
            </Alert>
          </div>
        )}

        {integration.isEnabled && webhookConfig && (
          <div className="pt-3 border-t space-y-3">
            <p className="text-sm font-medium">Webhook Integration</p>
            <p className="text-xs text-muted-foreground">
              Paste this URL into Housecall Pro under My Apps &rarr; Webhooks to receive real-time updates for jobs, estimates, and customers. A security token is already embedded in the URL.
            </p>

            <div className="flex items-center gap-2 min-w-0">
              <code className="flex-1 text-xs bg-muted px-3 py-2 rounded-md break-all min-w-0">{webhookConfig.webhookUrl}</code>
              <Button size="icon" variant="outline" onClick={() => navigator.clipboard.writeText(webhookConfig.webhookUrl)} data-testid="button-copy-hcp-webhook-url">
                <Copy className="h-4 w-4" />
              </Button>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2 text-sm">
                  {webhookConfig.tokenStatus === 'valid'
                    ? <><CheckCircle className="h-4 w-4 text-green-600 shrink-0" /><span className="text-muted-foreground">Webhook URL token valid</span></>
                    : webhookConfig.tokenStatus === 'read_error'
                      ? <><AlertTriangle className="h-4 w-4 text-destructive shrink-0" /><span className="text-muted-foreground">Token read error</span></>
                      : <><Info className="h-4 w-4 text-muted-foreground shrink-0" /><span className="text-muted-foreground">Token not yet configured</span></>
                  }
                </div>
                <Button variant="outline" size="sm" onClick={() => { setRegenerateConfirmed(false); setRegeneratedUrl(null); setRegenerateDialogOpen(true); }} data-testid="button-regenerate-hcp-webhook-url">
                  <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
                  Regenerate URL
                </Button>
              </div>

              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2 text-sm">
                  {webhookConfig.secretConfigured
                    ? <><CheckCircle className="h-4 w-4 text-green-600 shrink-0" /><span className="text-muted-foreground">Signing secret configured</span></>
                    : <><Info className="h-4 w-4 text-muted-foreground shrink-0" /><span className="text-muted-foreground">Signing secret not configured</span></>
                  }
                </div>
                <Button variant="outline" size="sm" onClick={() => setHcpSecretDialogOpen(true)} data-testid="button-configure-hcp-webhook-secret">
                  <Key className="h-3.5 w-3.5 mr-1.5" />
                  Configure Signing Secret
                </Button>
              </div>
            </div>

            {webhookStatus && (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-sm flex-wrap">
                  {webhookStatus.status === 'healthy' ? (
                    <CheckCircle className="h-4 w-4 text-green-600 dark:text-green-400 shrink-0" />
                  ) : webhookStatus.status === 'warning' ? (
                    <AlertTriangle className="h-4 w-4 text-yellow-500 dark:text-yellow-400 shrink-0" />
                  ) : (
                    <AlertTriangle className="h-4 w-4 text-destructive shrink-0" />
                  )}
                  <span className={
                    webhookStatus.status === 'healthy'
                      ? 'text-green-700 dark:text-green-400 font-medium'
                      : webhookStatus.status === 'warning'
                        ? 'text-yellow-700 dark:text-yellow-400 font-medium'
                        : 'text-destructive font-medium'
                  }>
                    {webhookStatus.status === 'healthy' ? 'Webhook healthy' : webhookStatus.status === 'warning' ? 'Webhook warning' : 'Webhook likely disabled'}
                  </span>
                  {webhookStatus.lastEventAt && (
                    <span className="text-muted-foreground text-xs flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      Last webhook event: {formatRelativeTime(webhookStatus.lastEventAt)}
                    </span>
                  )}
                  <span className={`text-xs flex items-center gap-1 ${webhookStatus.rejectionCount24h > 0 ? 'text-yellow-600 dark:text-yellow-400' : 'text-muted-foreground'}`}>
                    <AlertTriangle className={`h-3 w-3 ${webhookStatus.rejectionCount24h > 0 ? 'text-yellow-500' : 'text-muted-foreground'}`} />
                    {webhookStatus.rejectionCount24h} rejection{webhookStatus.rejectionCount24h !== 1 ? 's' : ''} (24h)
                  </span>
                </div>

                {(webhookStatus.status === 'warning' || webhookStatus.status === 'disabled') && webhookConfig && (
                  <Alert variant={webhookStatus.status === 'disabled' ? 'destructive' : 'default'}>
                    <AlertTriangle className="h-4 w-4" />
                    <AlertDescription className="text-xs space-y-2">
                      {webhookStatus.statusReason === 'auth_failing' ? (
                        <p>
                          Authentication failures detected — multiple webhook requests from Housecall Pro were rejected recently.
                          {webhookStatus.lastRejectionReason && (
                            <> Most recent rejection reason: <strong>{webhookStatus.lastRejectionReason}</strong>.</>
                          )}
                          {' '}Check your signing secret or webhook URL token configuration.
                        </p>
                      ) : (
                        <p>
                          {webhookStatus.status === 'disabled'
                            ? 'No webhook events received for over 60 minutes. Housecall Pro may have auto-disabled your webhook subscription. Real-time updates for leads, estimates, and jobs may not be working.'
                            : 'No webhook events received for over 30 minutes. Your webhook may be inactive or HCP may have paused it.'}
                          {webhookStatus.lastRejectionReason && (
                            <> Most recent rejection reason: <strong>{webhookStatus.lastRejectionReason}</strong>.</>
                          )}
                        </p>
                      )}
                      <p>To restore: copy the URL above and paste it in Housecall Pro under <strong>My Apps &rarr; Webhooks</strong>.</p>
                      <div className="flex items-center gap-2 min-w-0 pt-1">
                        <Button
                          size="icon"
                          variant="outline"
                          asChild
                        >
                          <a
                            href="https://pro.housecallpro.com/app/apps/details/webhooks"
                            target="_blank"
                            rel="noopener noreferrer"
                            data-testid="button-open-hcp-webhooks-page"
                          >
                            <ExternalLink className="h-4 w-4" />
                          </a>
                        </Button>
                      </div>
                    </AlertDescription>
                  </Alert>
                )}
              </div>
            )}

            {isAdmin && (
              <div className="pt-1 space-y-3">
                <div>
                  <Label className="text-sm font-medium">Sync Start Date</Label>
                  <p className="text-xs text-muted-foreground mb-2">Only sync estimates and jobs modified on or after this date. Leave blank to sync all records.</p>
                  <div className="flex flex-col sm:flex-row gap-2">
                    <Input
                      type="date"
                      value={hcpSyncDateInput !== null ? hcpSyncDateInput : (syncDateData?.syncStartDate ? syncDateData.syncStartDate.split('T')[0] : '')}
                      onChange={(e) => setHcpSyncDateInput(e.target.value)}
                      className="w-full"
                      data-testid="input-hcp-sync-start-date"
                    />
                    <div className="flex gap-2 shrink-0">
                      <Button
                        size="sm"
                        onClick={() => saveSyncDateMutation.mutate(hcpSyncDateInput !== null ? (hcpSyncDateInput || null) : (syncDateData?.syncStartDate || null))}
                        disabled={saveSyncDateMutation.isPending}
                        data-testid="button-save-hcp-sync-date"
                      >
                        {saveSyncDateMutation.isPending ? 'Saving...' : 'Save'}
                      </Button>
                      {syncDateData?.syncStartDate && (
                        <Button variant="outline" size="sm" onClick={() => { setHcpSyncDateInput(''); saveSyncDateMutation.mutate(null); }} disabled={saveSyncDateMutation.isPending} data-testid="button-clear-hcp-sync-date">
                          Clear
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
                <Button variant="outline" size="sm" onClick={() => syncMutation.mutate()} disabled={isSyncing} data-testid="button-hcp-sync">
                  <RefreshCw className={`h-4 w-4 mr-2 ${isSyncing ? 'animate-spin' : ''}`} />
                  {isSyncing ? 'Syncing...' : 'Sync Housecall Pro'}
                </Button>
              </div>
            )}
          </div>
        )}

        {integration.hasCredentials && isAdmin && !editingCredential && (
          <div className="pt-3 border-t flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => setEditingCredential(true)} data-testid="button-update-housecall-pro-api-key">
              Update API Key
            </Button>
          </div>
        )}

        {(!integration.hasCredentials || editingCredential) && (
          isAdmin ? (
            <div className="space-y-3">
              <Label htmlFor="hcp-api-key" className="text-sm font-medium">
                {integration.hasCredentials ? 'Update API Key' : 'API Key'}
              </Label>
              <div className="flex flex-col sm:flex-row gap-2">
                <Input
                  id="hcp-api-key"
                  type="password"
                  placeholder={integration.hasCredentials ? "Enter new API key..." : "Enter your API key..."}
                  value={credentialInput}
                  onChange={(e) => setCredentialInput(e.target.value)}
                  className="w-full"
                  data-testid="input-housecall-pro-api-key"
                />
                <div className="flex gap-2 shrink-0">
                  <Button onClick={handleSaveCredentials} disabled={isSavingCredentials || !credentialInput.trim()} data-testid="button-save-housecall-pro">
                    {isSavingCredentials ? "Saving..." : integration.hasCredentials ? "Update" : "Save"}
                  </Button>
                  {editingCredential && (
                    <Button variant="outline" onClick={handleCancelEdit} data-testid="button-cancel-housecall-pro">
                      Cancel
                    </Button>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <Alert>
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription className="text-sm">Contact your administrator to configure Housecall Pro credentials.</AlertDescription>
            </Alert>
          )
        )}
      </IntegrationCardShell>

      <Dialog open={regenerateDialogOpen} onOpenChange={(open) => { if (!open) { setRegenerateDialogOpen(false); setRegenerateConfirmed(false); } }}>
        <DialogContent data-testid="dialog-regenerate-hcp-webhook-url">
          <DialogHeader>
            <DialogTitle>Regenerate Webhook URL</DialogTitle>
            <DialogDescription>
              This will generate a new URL token. The current URL will immediately stop working — you must paste the new URL into Housecall Pro right away to avoid losing webhook events.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            {regeneratedUrl ? (
              <div className="space-y-3">
                <Alert>
                  <CheckCircle className="h-4 w-4" />
                  <AlertDescription className="text-xs">
                    New URL generated and copied to clipboard. Paste it into Housecall Pro under <strong>My Apps &rarr; Webhooks</strong> immediately.
                  </AlertDescription>
                </Alert>
                <div className="flex items-center gap-2 min-w-0">
                  <code className="flex-1 text-xs bg-muted px-3 py-2 rounded-md break-all min-w-0">{regeneratedUrl}</code>
                  <Button size="icon" variant="outline" onClick={() => navigator.clipboard.writeText(regeneratedUrl)} data-testid="button-copy-regenerated-hcp-url">
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex items-start gap-3">
                <Checkbox
                  id="regenerate-confirm-checkbox"
                  checked={regenerateConfirmed}
                  onCheckedChange={(checked) => setRegenerateConfirmed(!!checked)}
                  data-testid="checkbox-regenerate-confirm"
                />
                <Label htmlFor="regenerate-confirm-checkbox" className="text-sm leading-snug cursor-pointer">
                  I understand I need to paste the new URL into Housecall Pro right away
                </Label>
              </div>
            )}
          </div>
          <DialogFooter className="flex-wrap gap-2">
            <Button variant="outline" onClick={() => { setRegenerateDialogOpen(false); setRegenerateConfirmed(false); setRegeneratedUrl(null); }}>
              {regeneratedUrl ? 'Close' : 'Cancel'}
            </Button>
            {!regeneratedUrl && (
              <Button
                data-testid="button-confirm-regenerate-hcp-url"
                disabled={!regenerateConfirmed || regenerateTokenMutation.isPending}
                onClick={() => regenerateTokenMutation.mutate()}
              >
                {regenerateTokenMutation.isPending ? 'Regenerating...' : 'Regenerate URL'}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={hcpSecretDialogOpen} onOpenChange={(open) => { setHcpSecretDialogOpen(open); if (!open) setHcpSecretInput(''); }}>
        <DialogContent data-testid="dialog-hcp-webhook-secret">
          <DialogHeader>
            <DialogTitle>Configure Signing Secret</DialogTitle>
            <DialogDescription>
              Optional. Housecall Pro does not currently provide signing secrets on most plans — your webhook URL already includes a security token. If your HCP plan adds signing secret support, paste it here for stronger HMAC verification.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            {webhookConfig?.secretConfigured ? (
              <div className="flex items-start gap-2 rounded-md bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-800 px-3 py-2">
                <CheckCircle className="h-4 w-4 text-green-600 dark:text-green-400 mt-0.5 shrink-0" />
                <p className="text-sm text-green-800 dark:text-green-300">
                  A signing secret is currently configured. Enter a new value below to replace it, or remove it entirely.
                </p>
              </div>
            ) : (
              <div className="flex items-start gap-2 rounded-md bg-muted/50 border px-3 py-2">
                <Info className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
                <p className="text-sm text-muted-foreground">
                  No signing secret is configured. Your webhook URL token provides authentication on its own.
                </p>
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="hcp-secret">{webhookConfig?.secretConfigured ? 'New Signing Secret' : 'Signing Secret (optional)'}</Label>
              <Input
                id="hcp-secret"
                data-testid="input-hcp-webhook-secret"
                type="password"
                placeholder="Paste signing secret from Housecall Pro..."
                value={hcpSecretInput}
                onChange={e => setHcpSecretInput(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter className="flex-wrap gap-2">
            {webhookConfig?.secretConfigured && (
              <Button
                variant="outline"
                data-testid="button-remove-hcp-webhook-secret"
                disabled={removeWebhookSecretMutation.isPending}
                onClick={() => removeWebhookSecretMutation.mutate()}
                className="mr-auto text-destructive"
              >
                {removeWebhookSecretMutation.isPending ? 'Removing...' : 'Remove Secret'}
              </Button>
            )}
            <Button variant="outline" onClick={() => { setHcpSecretDialogOpen(false); setHcpSecretInput(''); }}>Cancel</Button>
            <Button
              data-testid="button-save-hcp-webhook-secret"
              disabled={!hcpSecretInput.trim() || saveWebhookSecretMutation.isPending}
              onClick={() => saveWebhookSecretMutation.mutate(hcpSecretInput)}
            >
              {saveWebhookSecretMutation.isPending ? 'Saving...' : 'Save Secret'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={leadSourceMappingOpen} onOpenChange={(open) => { if (!open) setLeadSourceMappingOpen(false); }}>
        <DialogContent data-testid="dialog-hcp-lead-source-mapping" className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Lead Source Mapping</DialogTitle>
            <DialogDescription>
              Map your app lead sources to Housecall Pro lead source names. The default lead source is used when no specific mapping matches.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="flex items-center justify-between">
              <Label className="text-sm font-medium text-muted-foreground">HCP lead sources</Label>
              <Button
                variant="ghost"
                size="sm"
                disabled={refreshLeadSourcesMutation.isPending}
                onClick={() => refreshLeadSourcesMutation.mutate()}
                data-testid="button-refresh-hcp-lead-sources"
              >
                <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${refreshLeadSourcesMutation.isPending ? 'animate-spin' : ''}`} />
                {refreshLeadSourcesMutation.isPending ? 'Refreshing...' : 'Refresh'}
              </Button>
            </div>
            <div className="space-y-2">
              <Label className="text-sm font-medium">Default lead source</Label>
              <p className="text-xs text-muted-foreground">Used when no per-source override matches. Leave blank to omit the field.</p>
              <Select
                value={defaultLeadSourceDraft || '__none__'}
                onValueChange={(v) => setDefaultLeadSourceDraft(v === '__none__' ? '' : v)}
              >
                <SelectTrigger data-testid="select-hcp-default-lead-source">
                  <SelectValue placeholder="Select a default..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">None (omit)</SelectItem>
                  {(hcpLeadSourcesData?.sources ?? []).map((src) => (
                    <SelectItem key={src} value={src}>{src}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label className="text-sm font-medium">Standard sources</Label>
              <p className="text-xs text-muted-foreground">Choose a specific HCP lead source for each app source, or leave as "Use default".</p>
              <div className="space-y-2">
                {APP_SOURCES.map(({ key, label }) => (
                  <div key={key} className="flex items-center gap-3">
                    <span className="text-sm w-36 shrink-0">{label}</span>
                    <Select
                      value={mappingDraft[key] || '__default__'}
                      onValueChange={(v) => setMappingDraft(prev => {
                        const next = { ...prev };
                        if (v === '__default__') {
                          delete next[key];
                        } else {
                          next[key] = v;
                        }
                        return next;
                      })}
                    >
                      <SelectTrigger data-testid={`select-hcp-mapping-${key}`}>
                        <SelectValue placeholder="Use default" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__default__">Use default</SelectItem>
                        {(hcpLeadSourcesData?.sources ?? []).map((src) => (
                          <SelectItem key={src} value={src}>{src}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <Label className="text-sm font-medium">Custom sources</Label>
              <p className="text-xs text-muted-foreground">Map additional app source keys (e.g. "mitsubishi") to an HCP lead source.</p>
              <div className="space-y-2">
                {customRows.map((row, idx) => (
                  <div key={idx} className="flex items-center gap-2">
                    <Input
                      className="w-36 shrink-0"
                      placeholder="App source key"
                      value={row.key}
                      onChange={(e) => setCustomRows(prev => prev.map((r, i) => i === idx ? { ...r, key: e.target.value.toLowerCase().replace(/[-\s]+/g, '_') } : r))}
                      data-testid={`input-custom-source-key-${idx}`}
                    />
                    <Select
                      value={row.hcpSource || '__none__'}
                      onValueChange={(v) => setCustomRows(prev => prev.map((r, i) => i === idx ? { ...r, hcpSource: v === '__none__' ? '' : v } : r))}
                    >
                      <SelectTrigger data-testid={`select-custom-source-hcp-${idx}`}>
                        <SelectValue placeholder="Select HCP source..." />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">Select HCP source...</SelectItem>
                        {(hcpLeadSourcesData?.sources ?? []).map((src) => (
                          <SelectItem key={src} value={src}>{src}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => setCustomRows(prev => prev.filter((_, i) => i !== idx))}
                      data-testid={`button-remove-custom-source-${idx}`}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCustomRows(prev => [...prev, { key: '', hcpSource: '' }])}
                data-testid="button-add-custom-source"
              >
                Add custom source
              </Button>
            </div>
          </div>
          <DialogFooter className="flex-wrap gap-2">
            <Button variant="outline" onClick={() => setLeadSourceMappingOpen(false)}>Cancel</Button>
            <Button
              data-testid="button-save-hcp-lead-source-mapping"
              disabled={saveLeadMappingMutation.isPending}
              onClick={() => {
                const customMapping: Record<string, string> = {};
                const seenKeys = new Set<string>();
                for (const row of customRows) {
                  const k = row.key.trim();
                  if (!k || !row.hcpSource) continue;
                  if (seenKeys.has(k)) {
                    toast({ title: `Duplicate custom source key: "${k}"`, description: 'Each custom key must be unique. Remove or rename the duplicate.', variant: 'destructive' });
                    return;
                  }
                  seenKeys.add(k);
                  customMapping[k] = row.hcpSource;
                }
                saveLeadMappingMutation.mutate({
                  mapping: { ...mappingDraft, ...customMapping },
                  defaultLeadSource: defaultLeadSourceDraft || null,
                });
              }}
            >
              {saveLeadMappingMutation.isPending ? 'Saving...' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
