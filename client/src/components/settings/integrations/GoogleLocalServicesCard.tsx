import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CheckCircle, XCircle, Info, AlertTriangle, Clock, RefreshCw, Copy } from "lucide-react";
import { SiGoogle } from "react-icons/si";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { IntegrationCardShell } from "./IntegrationCardShell";

interface GlsStatus {
  configured: boolean;
  developerTokenSet: boolean;
  connected: boolean;
  accountSelected: boolean;
  enabled: boolean;
  accountId: string | null;
  accountName: string | null;
  lastPollAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
}

interface GlsAccount {
  accountId: string;
  businessName: string;
  currencyCode?: string;
}

const GLS_ERROR_MESSAGES: Record<string, string> = {
  token_exchange:
    'The OAuth authorization code could not be exchanged for a token. Make sure the Redirect URI in your Google Cloud OAuth client exactly matches the callback URL shown below.',
};

export function GoogleLocalServicesCard() {
  const { toast } = useToast();
  const oauthCallbackUrl = `${window.location.origin}/api/integrations/google-local-services/callback`;
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selectedAccountId, setSelectedAccountId] = useState<string>('');

  const { data: status, isLoading: statusLoading } = useQuery<GlsStatus>({
    queryKey: ['/api/integrations/google-local-services/status'],
  });

  // After OAuth redirect we land here with ?google_local_services=pick_account
  // Open the account picker automatically once on first render.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const flag = params.get('google_local_services');
    if (flag === 'pick_account') {
      setPickerOpen(true);
      const newUrl = new URL(window.location.href);
      newUrl.searchParams.delete('google_local_services');
      window.history.replaceState({}, '', newUrl.toString());
    } else if (flag === 'error') {
      const reason = params.get('reason') || '';
      toast({
        title: 'Google Local Services Connection Failed',
        description: GLS_ERROR_MESSAGES[reason] || 'Something went wrong connecting to Google. Please try again.',
        variant: 'destructive',
      });
      const newUrl = new URL(window.location.href);
      newUrl.searchParams.delete('google_local_services');
      newUrl.searchParams.delete('reason');
      window.history.replaceState({}, '', newUrl.toString());
    }
  }, []);

  const { data: accountsData, isFetching: accountsLoading } = useQuery<{ accounts: GlsAccount[] }>({
    queryKey: ['/api/integrations/google-local-services/accounts'],
    enabled: pickerOpen && !!status?.connected,
  });

  const connectMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest('GET', '/api/integrations/google-local-services/connect');
      return res.json() as Promise<{ authUrl: string }>;
    },
    onSuccess: (data) => { window.location.href = data.authUrl; },
    onError: (err: any) => {
      toast({ title: 'Connection Failed', description: err.message || 'Could not start Google connection.', variant: 'destructive' });
    },
  });

  const selectAccountMutation = useMutation({
    mutationFn: async (account: GlsAccount) => {
      const res = await apiRequest('POST', '/api/integrations/google-local-services/select-account', {
        accountId: account.accountId,
        accountName: account.businessName,
      });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: 'Google Local Services Connected', description: 'Leads will start arriving within 5 minutes.' });
      setPickerOpen(false);
      queryClient.invalidateQueries({ queryKey: ['/api/integrations/google-local-services/status'] });
    },
    onError: (err: any) => {
      toast({ title: 'Failed to Save Account', description: err.message || 'Try again.', variant: 'destructive' });
    },
  });

  const disconnectMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest('POST', '/api/integrations/google-local-services/disconnect');
      return res.json();
    },
    onSuccess: () => {
      toast({ title: 'Disconnected', description: 'Google Local Services has been disconnected.' });
      queryClient.invalidateQueries({ queryKey: ['/api/integrations/google-local-services/status'] });
    },
    onError: (err: any) => {
      toast({ title: 'Error', description: err.message || 'Failed to disconnect.', variant: 'destructive' });
    },
  });

  const syncNowMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest('POST', '/api/integrations/google-local-services/sync-now');
      return res.json();
    },
    onSuccess: () => {
      toast({ title: 'Sync Complete', description: 'Latest Google Local Services leads have been pulled.' });
      queryClient.invalidateQueries({ queryKey: ['/api/integrations/google-local-services/status'] });
    },
    onError: (err: any) => {
      toast({ title: 'Sync Failed', description: err.message || 'Could not pull leads.', variant: 'destructive' });
    },
  });

  const fullyConnected = !!status?.connected && !!status?.accountSelected;
  const statusIcon = (() => {
    if (statusLoading) return <></>;
    if (!status?.connected) return <XCircle className="h-5 w-5 text-muted-foreground" />;
    if (status.lastError) return <AlertTriangle className="h-5 w-5 text-yellow-500" />;
    return <CheckCircle className="h-5 w-5 text-green-600" />;
  })();

  return (
    <IntegrationCardShell
      icon={<SiGoogle className="h-5 w-5 text-white" />}
      iconStyle={{ backgroundColor: '#4285F4' }}
      title="Google Local Services"
      description="Pull leads from your Google Local Services Ads account into the CRM"
      statusIcon={statusIcon}
      isLoading={false}
      data-testid="card-google-local-services"
    >
      {!status?.configured && (
        <div className="rounded-md border border-yellow-500/50 bg-yellow-500/10 p-3 flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 text-yellow-600 dark:text-yellow-500 mt-0.5 shrink-0" />
          <div className="space-y-1">
            <p className="text-sm font-medium text-yellow-700 dark:text-yellow-400">Not configured</p>
            <p className="text-xs text-muted-foreground">
              Set <code>GOOGLE_LOCAL_SERVICES_CLIENT_ID</code> and <code>GOOGLE_LOCAL_SERVICES_CLIENT_SECRET</code> on the server to enable this integration.
            </p>
          </div>
        </div>
      )}

      {status?.configured && !status.developerTokenSet && (
        <div className="rounded-md border bg-muted/40 p-3 flex items-start gap-2">
          <Info className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
          <p className="text-xs text-muted-foreground">
            <code>GOOGLE_LOCAL_SERVICES_DEVELOPER_TOKEN</code> is not set. The Google Local Services API requires a developer token issued by the Google Ads API team.
          </p>
        </div>
      )}

      <div className="space-y-2">
        {statusLoading ? (
          <div className="h-5 w-24 bg-muted animate-pulse rounded" />
        ) : fullyConnected ? (
          <>
            <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between">
              <Badge variant="default" className="gap-1">
                <CheckCircle className="h-3 w-3" />Connected
              </Badge>
              <div className="flex items-center gap-2 flex-wrap">
                <Button
                  variant="outline" size="sm"
                  onClick={() => syncNowMutation.mutate()}
                  disabled={syncNowMutation.isPending}
                  data-testid="button-gls-sync-now"
                >
                  {syncNowMutation.isPending ? <RefreshCw className="h-3 w-3 mr-1 animate-spin" /> : <RefreshCw className="h-3 w-3 mr-1" />}
                  {syncNowMutation.isPending ? 'Syncing...' : 'Sync Now'}
                </Button>
                <Button
                  variant="outline" size="sm"
                  onClick={() => disconnectMutation.mutate()}
                  disabled={disconnectMutation.isPending}
                  data-testid="button-gls-disconnect"
                >
                  {disconnectMutation.isPending ? 'Disconnecting...' : 'Disconnect'}
                </Button>
              </div>
            </div>
            {status.accountName && (
              <p className="text-sm text-muted-foreground" data-testid="text-gls-account-name">
                Connected account: {status.accountName}
                <span className="font-mono text-xs ml-1">({status.accountId})</span>
              </p>
            )}
          </>
        ) : status?.connected ? (
          <>
            <Badge variant="secondary">Account not selected</Badge>
            <div>
              <Button size="sm" onClick={() => setPickerOpen(true)} data-testid="button-gls-pick-account">
                Choose Account
              </Button>
            </div>
          </>
        ) : (
          <>
            <Badge variant="secondary">Not Connected</Badge>
            <div>
              <Button
                size="sm"
                onClick={() => connectMutation.mutate()}
                disabled={connectMutation.isPending || !status?.configured}
                data-testid="button-gls-connect"
                style={{ backgroundColor: '#4285F4', borderColor: '#4285F4' }}
              >
                {connectMutation.isPending ? 'Connecting...' : 'Connect Google Account'}
              </Button>
            </div>
          </>
        )}
      </div>

      {pickerOpen && status?.connected && !fullyConnected && (
        <div className="rounded-md border bg-muted/40 p-3 space-y-3" data-testid="gls-account-picker">
          <p className="text-sm font-medium">Select your Google Local Services account</p>
          {accountsLoading ? (
            <div className="h-5 w-32 bg-muted animate-pulse rounded" />
          ) : !accountsData?.accounts?.length ? (
            <p className="text-xs text-muted-foreground">
              No Google Local Services accounts were found on this Google login.
            </p>
          ) : (
            <div className="space-y-2">
              <Label className="text-xs">Account</Label>
              <Select value={selectedAccountId} onValueChange={setSelectedAccountId}>
                <SelectTrigger data-testid="select-gls-account">
                  <SelectValue placeholder="Pick an account" />
                </SelectTrigger>
                <SelectContent>
                  {accountsData.accounts.map(a => (
                    <SelectItem key={a.accountId} value={a.accountId}>
                      {a.businessName || `Account ${a.accountId}`} ({a.accountId})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                size="sm"
                onClick={() => {
                  const account = accountsData.accounts.find(a => a.accountId === selectedAccountId);
                  if (account) selectAccountMutation.mutate(account);
                }}
                disabled={!selectedAccountId || selectAccountMutation.isPending}
                data-testid="button-gls-confirm-account"
              >
                {selectAccountMutation.isPending ? 'Saving...' : 'Save Account'}
              </Button>
            </div>
          )}
        </div>
      )}

      {fullyConnected && (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="gls-last-poll">
          <Clock className="h-3.5 w-3.5 shrink-0" />
          {status.lastSuccessAt ? (
            <span>Last successful sync {new Date(status.lastSuccessAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
          ) : (
            <span>Awaiting first poll (runs every 5 minutes)</span>
          )}
        </div>
      )}

      {fullyConnected && status.lastError && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 flex items-start gap-2" data-testid="gls-last-error">
          <AlertTriangle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
          <div className="space-y-1">
            <p className="text-sm font-medium text-destructive">Last sync failed</p>
            <p className="text-xs text-muted-foreground break-all">{status.lastError}</p>
          </div>
        </div>
      )}

      {!status?.connected && (
        <div className="rounded-md border bg-muted/40 p-3 space-y-2">
          <div className="flex items-start gap-2">
            <Info className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
            <p className="text-xs text-muted-foreground">
              Add this <strong>Authorized redirect URI</strong> to your Google Cloud OAuth 2.0 client (APIs &amp; Services &rarr; Credentials):
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
              data-testid="button-gls-copy-callback-url"
            >
              <Copy className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}
    </IntegrationCardShell>
  );
}
