import { useState, useEffect } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { CheckCircle, XCircle, Settings, Copy, Info, AlertTriangle, Clock, RefreshCw, Wifi, WifiOff } from "lucide-react";
import { SiFacebook } from "react-icons/si";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { IntegrationCardShell } from "./IntegrationCardShell";

const FACEBOOK_ERROR_MESSAGES: Record<string, string> = {
  token_exchange: 'The OAuth authorization code could not be exchanged for a token. Make sure the Redirect URI in your Facebook App settings exactly matches the callback URL shown below.',
  fetch_pages_failed: 'Could not fetch your Facebook Pages. Your account may not have the required permissions.',
  no_pages: 'No Facebook Pages were found on your account. Make sure your Facebook user manages at least one Page.',
  save_failed: 'The connection details could not be saved. Please try again.',
  unexpected: 'An unexpected error occurred. Please try again.',
};

export function FacebookLeadsCard() {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const [fbDatasetId, setFbDatasetId] = useState('');
  const [fbAccessToken, setFbAccessToken] = useState('');
  const [capiOpen, setCapiOpen] = useState(false);
  const oauthCallbackUrl = `${window.location.origin}/api/integrations/facebook/callback`;
  const webhookCallbackUrl = `${window.location.origin}/api/webhooks/facebook`;

  const { data: fbStatus, isLoading: fbStatusLoading } = useQuery<{
    connected: boolean;
    pageId?: string;
    pageName?: string;
    tokenHealth: 'ok' | 'expiring_soon' | 'expired' | 'unknown';
    tokenExpiresAt?: string;
    tokenExpiresInDays?: number;
    lastWebhookLeadAt?: string;
    webhookVerifyTokenSet?: boolean;
    webhookSubscribed?: boolean | null;
    appWebhookActive?: boolean | null;
  }>({
    queryKey: ['/api/integrations/facebook/status'],
  });

  const { data: fbConversionsConfig, isLoading: fbConversionsLoading } = useQuery<{ configured: boolean; datasetId?: string }>({
    queryKey: ['/api/integrations/facebook/conversions-config'],
  });

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const fbParam = params.get('facebook');
    if (fbParam === 'connected') {
      const webhookIssue = params.get('webhook_issue');
      let description = 'Your Facebook Page has been connected successfully.';
      let variant: 'default' | 'destructive' = 'default';
      if (webhookIssue === 'missing_verify_token') {
        description = 'Your Facebook Page has been connected, but real-time webhook delivery could not be set up because FACEBOOK_VERIFY_TOKEN is not configured.';
        variant = 'destructive';
      } else if (webhookIssue === 'subscribe_failed') {
        description = 'Your Facebook Page has been connected, but the webhook subscription failed. You can re-subscribe from the Setup & Sync page.';
        variant = 'destructive';
      }
      toast({ title: 'Facebook Connected', description, variant });
      queryClient.invalidateQueries({ queryKey: ['/api/integrations/facebook/status'] });
      const newUrl = new URL(window.location.href);
      newUrl.searchParams.delete('facebook');
      newUrl.searchParams.delete('webhook_issue');
      window.history.replaceState({}, '', newUrl.toString());
    } else if (fbParam === 'error') {
      const reason = params.get('reason') || '';
      const description = FACEBOOK_ERROR_MESSAGES[reason] || 'Something went wrong connecting your Facebook Page. Please try again.';
      toast({ title: 'Facebook Connection Failed', description, variant: 'destructive' });
      const newUrl = new URL(window.location.href);
      newUrl.searchParams.delete('facebook');
      newUrl.searchParams.delete('reason');
      window.history.replaceState({}, '', newUrl.toString());
    }
  }, []);

  const fbConnectMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest('GET', '/api/integrations/facebook/connect');
      return response.json() as Promise<{ authUrl: string }>;
    },
    onSuccess: (data) => { window.location.href = data.authUrl; },
    onError: (error: any) => {
      toast({ title: 'Connection Failed', description: error.message || 'Failed to start Facebook connection.', variant: 'destructive' });
    },
  });

  const fbDisconnectMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest('POST', '/api/integrations/facebook/disconnect');
      return response.json();
    },
    onSuccess: () => {
      toast({ title: 'Facebook Disconnected', description: 'Your Facebook Page has been disconnected.' });
      queryClient.invalidateQueries({ queryKey: ['/api/integrations/facebook/status'] });
    },
    onError: (error: any) => {
      toast({ title: 'Error', description: error.message || 'Failed to disconnect.', variant: 'destructive' });
    },
  });

  const fbSaveConversionsMutation = useMutation({
    mutationFn: async ({ datasetId, accessToken }: { datasetId: string; accessToken: string }) => {
      const response = await apiRequest('POST', '/api/integrations/facebook/conversions-config', { datasetId, accessToken });
      return response.json();
    },
    onSuccess: () => {
      toast({ title: 'Conversions API Configured', description: 'Lead status events will now be sent to Meta.' });
      queryClient.invalidateQueries({ queryKey: ['/api/integrations/facebook/conversions-config'] });
      setFbDatasetId('');
      setFbAccessToken('');
    },
    onError: (error: any) => {
      toast({ title: 'Error', description: error.message || 'Failed to save configuration.', variant: 'destructive' });
    },
  });

  const fbResubscribeMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest('POST', '/api/integrations/facebook/resubscribe-webhook');
      return response.json();
    },
    onSuccess: () => {
      toast({ title: 'Webhook Re-subscribed', description: 'Your page is now subscribed to receive real-time leads.' });
      queryClient.invalidateQueries({ queryKey: ['/api/integrations/facebook/status'] });
    },
    onError: (error: any) => {
      toast({ title: 'Re-subscribe Failed', description: error.message || 'Failed to re-subscribe to webhook.', variant: 'destructive' });
    },
  });

  const fbRegisterAppWebhookMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest('POST', '/api/integrations/facebook/register-app-webhook');
      return response.json();
    },
    onSuccess: () => {
      toast({ title: 'App Webhook Registered', description: 'The app-level webhook subscription has been registered successfully.' });
      queryClient.invalidateQueries({ queryKey: ['/api/integrations/facebook/status'] });
    },
    onError: (error: any) => {
      toast({ title: 'Registration Failed', description: error.message || 'Failed to register app-level webhook.', variant: 'destructive' });
    },
  });

  const fbRemoveConversionsMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest('DELETE', '/api/integrations/facebook/conversions-config');
      return response.json();
    },
    onSuccess: () => {
      toast({ title: 'Conversions API Removed', description: 'Lead status events will no longer be sent to Meta.' });
      queryClient.invalidateQueries({ queryKey: ['/api/integrations/facebook/conversions-config'] });
      setCapiOpen(false);
    },
    onError: (error: any) => {
      toast({ title: 'Error', description: error.message || 'Failed to remove configuration.', variant: 'destructive' });
    },
  });

  const statusIcon = (() => {
    if (fbStatusLoading) return <></>;
    if (!fbStatus?.connected) return <XCircle className="h-5 w-5 text-muted-foreground" />;
    if (fbStatus.tokenHealth === 'expired') return <XCircle className="h-5 w-5 text-destructive" />;
    if (fbStatus.tokenHealth === 'expiring_soon') return <AlertTriangle className="h-5 w-5 text-yellow-500" />;
    return <CheckCircle className="h-5 w-5 text-green-600" />;
  })();

  const showWebhookNotSubscribedWarning =
    fbStatus?.connected &&
    fbStatus.webhookVerifyTokenSet &&
    fbStatus.webhookSubscribed === false;

  return (
    <IntegrationCardShell
      icon={<SiFacebook className="h-5 w-5 text-white" />}
      iconStyle={{ backgroundColor: '#1877F2' }}
      title="Facebook Lead Management"
      description="Pull leads from Facebook Lead Ads directly into the CRM"
      statusIcon={statusIcon}
      isLoading={false}
      data-testid="card-facebook-leads"
    >
      <div className="space-y-2">
        {fbStatusLoading ? (
          <div className="h-5 w-24 bg-muted animate-pulse rounded" />
        ) : fbStatus?.connected ? (
          <>
            <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between">
              <Badge variant="default" className="gap-1">
                <CheckCircle className="h-3 w-3" />Connected
              </Badge>
              <div className="flex items-center gap-2 flex-wrap">
                <Button variant="outline" size="sm" onClick={() => navigate('/facebook-setup')} data-testid="button-facebook-setup">
                  <Settings className="h-3 w-3 mr-1" />
                  Setup & Sync
                </Button>
                <Button variant="outline" size="sm" onClick={() => fbDisconnectMutation.mutate()} disabled={fbDisconnectMutation.isPending} data-testid="button-facebook-disconnect">
                  {fbDisconnectMutation.isPending ? 'Disconnecting...' : 'Disconnect'}
                </Button>
              </div>
            </div>
            {fbStatus.pageName && (
              <p className="text-sm text-muted-foreground">Connected page: {fbStatus.pageName}</p>
            )}
          </>
        ) : (
          <>
            <Badge variant="secondary">Not Connected</Badge>
            <div>
              <Button size="sm" onClick={() => fbConnectMutation.mutate()} disabled={fbConnectMutation.isPending} data-testid="button-facebook-connect" style={{ backgroundColor: '#1877F2', borderColor: '#1877F2' }}>
                {fbConnectMutation.isPending ? 'Connecting...' : 'Connect Facebook Page'}
              </Button>
            </div>
          </>
        )}
      </div>

      {fbStatus?.connected && fbStatus.tokenHealth === 'expired' && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 flex items-start gap-2" data-testid="facebook-token-expired-warning">
          <XCircle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
          <div className="space-y-1">
            <p className="text-sm font-medium text-destructive">Connection expired</p>
            <p className="text-xs text-muted-foreground">Your Facebook authorization has expired and new leads are no longer being received. Reconnect to restore automatic lead syncing.</p>
          </div>
        </div>
      )}

      {fbStatus?.connected && fbStatus.tokenHealth === 'expiring_soon' && (
        <div className="rounded-md border border-yellow-500/50 bg-yellow-500/10 p-3 flex items-start gap-2" data-testid="facebook-token-expiring-warning">
          <AlertTriangle className="h-4 w-4 text-yellow-600 dark:text-yellow-500 mt-0.5 shrink-0" />
          <div className="space-y-1">
            <p className="text-sm font-medium text-yellow-700 dark:text-yellow-400">
              Connection expiring {fbStatus.tokenExpiresInDays === 0 ? 'today' : fbStatus.tokenExpiresInDays === 1 ? 'tomorrow' : `in ${fbStatus.tokenExpiresInDays} days`}
            </p>
            <p className="text-xs text-muted-foreground">Reconnect your Facebook Page before it expires to avoid any gap in lead collection.</p>
          </div>
        </div>
      )}

      {fbStatus?.connected && (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="facebook-last-lead-info">
          <Clock className="h-3.5 w-3.5 shrink-0" />
          {fbStatus.lastWebhookLeadAt ? (
            <span>Last lead received {new Date(fbStatus.lastWebhookLeadAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
          ) : (
            <span>No leads received via webhook yet</span>
          )}
        </div>
      )}

      {fbStatus?.connected && fbStatus.webhookVerifyTokenSet === false && (
        <div className="rounded-md border border-yellow-500/50 bg-yellow-500/10 p-3 flex items-start gap-2" data-testid="facebook-webhook-missing-token">
          <WifiOff className="h-4 w-4 text-yellow-600 dark:text-yellow-500 mt-0.5 shrink-0" />
          <div className="space-y-1">
            <p className="text-sm font-medium text-yellow-700 dark:text-yellow-400">Webhook not configured</p>
            <p className="text-xs text-muted-foreground">FACEBOOK_VERIFY_TOKEN is not set. Real-time lead delivery is inactive. Leads can still be imported manually via the Setup & Sync page.</p>
          </div>
        </div>
      )}

      {showWebhookNotSubscribedWarning && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 flex items-start gap-2" data-testid="facebook-webhook-not-subscribed-warning">
          <WifiOff className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
          <div className="space-y-2 flex-1">
            <div className="space-y-1">
              <p className="text-sm font-medium text-destructive">Real-time leads not active</p>
              <p className="text-xs text-muted-foreground">Your page is not subscribed to receive webhooks. New leads will not arrive in real time until this is fixed.</p>
            </div>
            <Button
              size="sm"
              onClick={() => fbResubscribeMutation.mutate()}
              disabled={fbResubscribeMutation.isPending}
              data-testid="button-facebook-resubscribe"
            >
              {fbResubscribeMutation.isPending ? (
                <RefreshCw className="h-3 w-3 mr-1 animate-spin" />
              ) : (
                <RefreshCw className="h-3 w-3 mr-1" />
              )}
              {fbResubscribeMutation.isPending ? 'Re-subscribing...' : 'Re-subscribe'}
            </Button>
          </div>
        </div>
      )}

      {fbStatus?.connected && fbStatus.webhookVerifyTokenSet && (
        <div className="rounded-md border bg-muted/40 p-3 space-y-3" data-testid="facebook-webhook-setup-section">
          <div className="flex items-center gap-1.5">
            <Wifi className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <span className="text-xs text-muted-foreground">Webhook Setup</span>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-1.5">
                {fbStatus.appWebhookActive === true ? (
                  <CheckCircle className="h-3.5 w-3.5 text-green-600 shrink-0" />
                ) : fbStatus.appWebhookActive === false ? (
                  <XCircle className="h-3.5 w-3.5 text-destructive shrink-0" />
                ) : (
                  <Info className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                )}
                <span className="text-xs text-muted-foreground">App webhook registered</span>
              </div>
              {fbStatus.appWebhookActive === false && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => fbRegisterAppWebhookMutation.mutate()}
                  disabled={fbRegisterAppWebhookMutation.isPending}
                  data-testid="button-facebook-register-app-webhook"
                >
                  {fbRegisterAppWebhookMutation.isPending ? (
                    <RefreshCw className="h-3 w-3 mr-1 animate-spin" />
                  ) : (
                    <RefreshCw className="h-3 w-3 mr-1" />
                  )}
                  {fbRegisterAppWebhookMutation.isPending ? 'Registering...' : 'Re-register'}
                </Button>
              )}
            </div>

            <div className="flex items-center gap-1.5">
              {fbStatus.webhookSubscribed === true ? (
                <CheckCircle className="h-3.5 w-3.5 text-green-600 shrink-0" />
              ) : fbStatus.webhookSubscribed === false ? (
                <XCircle className="h-3.5 w-3.5 text-destructive shrink-0" />
              ) : (
                <Info className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              )}
              <span className="text-xs text-muted-foreground">Page subscribed</span>
            </div>
          </div>

          <p className="text-xs text-muted-foreground">
            Both webhook registrations happen automatically when you connect your Facebook Page. Use the Re-register button if the app webhook becomes inactive.
          </p>

          <div className="space-y-1.5">
            <p className="text-xs text-muted-foreground">Webhook callback URL:</p>
            <div className="flex items-center gap-2 min-w-0">
              <code className="flex-1 text-xs font-mono bg-background border rounded px-2 py-1 break-all min-w-0">
                {webhookCallbackUrl}
              </code>
              <Button
                size="icon"
                variant="ghost"
                className="shrink-0"
                onClick={() => {
                  navigator.clipboard.writeText(webhookCallbackUrl);
                  toast({ title: 'Copied', description: 'Webhook callback URL copied to clipboard.' });
                }}
                data-testid="button-facebook-copy-callback-url-connected"
              >
                <Copy className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>

          {!showWebhookNotSubscribedWarning && (
            <div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => fbResubscribeMutation.mutate()}
                disabled={fbResubscribeMutation.isPending}
                data-testid="button-facebook-resubscribe"
              >
                {fbResubscribeMutation.isPending ? (
                  <RefreshCw className="h-3 w-3 mr-1 animate-spin" />
                ) : (
                  <RefreshCw className="h-3 w-3 mr-1" />
                )}
                {fbResubscribeMutation.isPending ? 'Re-subscribing...' : 'Re-subscribe Webhook'}
              </Button>
            </div>
          )}
        </div>
      )}

      {!fbStatus?.connected && (
        <div className="rounded-md border bg-muted/40 p-3 space-y-2">
          <div className="flex items-start gap-2">
            <Info className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
            <p className="text-xs text-muted-foreground">
              Before connecting, add this <strong>Redirect URI</strong> to your Facebook App in the{' '}
              <strong>Meta Developer Portal</strong> under Facebook Login &rarr; Settings:
            </p>
          </div>
          <div className="flex items-center gap-2 min-w-0">
            <code className="flex-1 text-xs font-mono bg-background border rounded px-2 py-1 break-all min-w-0">
              {oauthCallbackUrl}
            </code>
            <Button
              size="icon"
              variant="ghost"
              className="shrink-0"
              onClick={() => {
                navigator.clipboard.writeText(oauthCallbackUrl);
                toast({ title: 'Copied', description: 'Callback URL copied to clipboard.' });
              }}
              data-testid="button-facebook-copy-callback-url"
            >
              <Copy className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}

      {fbStatus?.connected && (
        <div className="border-t pt-3 space-y-3">
          {fbConversionsLoading ? (
            <div className="h-5 w-24 bg-muted animate-pulse rounded" />
          ) : fbConversionsConfig?.configured ? (
            <div className="space-y-2">
              <p className="text-sm font-medium">Conversions API (CAPI)</p>
              <div className="flex items-center gap-2 flex-wrap">
                <Badge variant="default" className="gap-1">
                  <CheckCircle className="h-3 w-3" />Configured
                </Badge>
                {fbConversionsConfig.datasetId && (
                  <span className="text-xs text-muted-foreground font-mono">Dataset: {fbConversionsConfig.datasetId}</span>
                )}
              </div>
              <div>
                <Button variant="outline" size="sm" onClick={() => fbRemoveConversionsMutation.mutate()} disabled={fbRemoveConversionsMutation.isPending} data-testid="button-facebook-conversions-remove">
                  {fbRemoveConversionsMutation.isPending ? 'Removing...' : 'Remove'}
                </Button>
              </div>
            </div>
          ) : !capiOpen ? (
            <Button variant="outline" size="sm" onClick={() => setCapiOpen(true)} data-testid="button-facebook-configure-capi">
              Configure Conversions API
            </Button>
          ) : (
            <div className="space-y-3">
              <div>
                <p className="text-sm font-medium">Conversions API (CAPI)</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Send lead stage events back to Meta to optimize ad performance.
                  Your CAPI access token is in Meta Events Manager &rarr; your Dataset &rarr; Settings &rarr; Generate Access Token.
                </p>
              </div>
              <div className="space-y-2">
                <div className="space-y-1">
                  <Label htmlFor="fb-dataset-id" className="text-xs">Dataset ID (Pixel ID)</Label>
                  <Input id="fb-dataset-id" placeholder="e.g. 1265450504550073" value={fbDatasetId} onChange={(e) => setFbDatasetId(e.target.value)} data-testid="input-facebook-dataset-id" />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="fb-access-token" className="text-xs">CAPI Access Token</Label>
                  <Input id="fb-access-token" type="password" placeholder="Paste your Conversions API access token" value={fbAccessToken} onChange={(e) => setFbAccessToken(e.target.value)} data-testid="input-facebook-access-token" />
                </div>
                <Button size="sm" onClick={() => fbSaveConversionsMutation.mutate({ datasetId: fbDatasetId.trim(), accessToken: fbAccessToken.trim() })} disabled={fbSaveConversionsMutation.isPending || !fbDatasetId.trim() || !fbAccessToken.trim()} data-testid="button-facebook-conversions-save">
                  {fbSaveConversionsMutation.isPending ? 'Saving...' : 'Save Configuration'}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </IntegrationCardShell>
  );
}
