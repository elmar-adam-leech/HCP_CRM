import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ArrowLeft, AlertTriangle, CheckCircle2, Clock, RefreshCw, Webhook, Phone, RotateCcw, XCircle, ChevronDown, ChevronRight, Database } from "lucide-react";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useState } from "react";

interface DiagnoseData {
  eventReception: {
    callEventsReceived: boolean;
    lastCallEventAt: string | null;
    staleDays: number | null;
  };
  webhooks: Array<{
    id: string;
    hook_url: string;
    urlMismatch: boolean;
    matchesExpected?: boolean;
  }>;
  driftDetected?: boolean;
  driftSource?: 'live' | 'persisted';
  webhooksError: string | null;
  subscriptions: Array<{
    id: string;
    enabled: boolean;
    target_type?: string;
    target_id?: string;
    call_states?: string[];
    endpoint_id?: string;
    webhook_id?: string;
    webhookLinked?: boolean;
    webhookHookUrl?: string | null;
    webhook_present?: boolean;
  }>;
  subscriptionsError: string | null;
  activeSubscriptionCount: number;
  smsSubscriptions: Array<{
    id: string;
    enabled: boolean;
    direction?: string;
    webhook_id?: string;
    hook_url?: string;
    webhookLinked?: boolean;
  }>;
  smsSubscriptionsError: string | null;
  activeSmsSubscriptionCount: number;
  expectedCallUrl: string;
  expectedSmsUrl: string;
  persistedState: {
    smsWebhookId: string | null;
    smsSubscriptionId: string | null;
    callWebhookId: string | null;
    callSubscriptionIds: string[] | null;
    lastRegisteredCallUrl: string | null;
    lastRegisteredSmsUrl: string | null;
    lastRegisteredAt: string | null;
  } | null;
  currentHost: string;
}

function EventReceptionStatus({ data }: { data: DiagnoseData['eventReception'] }) {
  const { callEventsReceived, lastCallEventAt, staleDays } = data;

  let badgeVariant: "default" | "secondary" | "destructive" | "outline" = "secondary";
  let badgeLabel = "Never Received";
  let icon = <XCircle className="h-4 w-4 text-destructive" />;

  if (callEventsReceived) {
    if (staleDays !== null && staleDays > 7) {
      badgeVariant = "outline";
      badgeLabel = "Stale";
      icon = <Clock className="h-4 w-4 text-amber-500" />;
    } else {
      badgeVariant = "default";
      badgeLabel = "Healthy";
      icon = <CheckCircle2 className="h-4 w-4 text-green-600" />;
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        {icon}
        <span className="text-sm font-medium">Call event reception status:</span>
        <Badge variant={badgeVariant}>{badgeLabel}</Badge>
      </div>
      {callEventsReceived && lastCallEventAt ? (
        <p className="text-sm text-muted-foreground">
          Last received: <span className="text-foreground">{new Date(lastCallEventAt).toLocaleString()}</span>
          {staleDays !== null && (
            <span className="ml-1">({staleDays} day{staleDays !== 1 ? 's' : ''} ago)</span>
          )}
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">
          No call events have ever been received from Dialpad. This typically means call subscriptions are missing or misconfigured.
        </p>
      )}
    </div>
  );
}

interface RawStateData {
  webhooks: Array<{
    id: string;
    hook_url: string;
    hook_type?: string;
    enabled?: boolean;
  }>;
  webhooksError: string | null;
  subscriptions: Array<{
    id: string;
    enabled: boolean;
    target_type?: string;
    target_id?: string;
    call_states?: string[];
    webhook?: { hook_url?: string; id?: string } | null;
  }>;
  subscriptionsError: string | null;
}

interface ReregisterWebhookResponse {
  callSubscriptionsActive?: boolean;
  callSubscriptionWarning?: string;
  callSubscriptionError?: string;
  message?: string;
  error?: string;
}

interface RetrySubsResponse {
  subscriptionIds?: string[];
  targetType?: string;
  message?: string;
}

function RawStatePanel() {
  const [expanded, setExpanded] = useState(false);
  const { data, isFetching, isError, refetch } = useQuery<RawStateData>({
    queryKey: ['/api/dialpad/health/raw-state'],
    enabled: false,
    staleTime: 0,
  });

  const handleRefresh = () => {
    setExpanded(true);
    refetch();
  };

  const handleToggle = () => {
    if (!expanded) {
      setExpanded(true);
      if (!data) refetch();
    } else {
      setExpanded(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <button
            className="flex items-center gap-2 text-base font-semibold"
            onClick={handleToggle}
            type="button"
          >
            {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            <Database className="h-4 w-4 text-muted-foreground" />
            Raw Dialpad API State
          </button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleRefresh}
            disabled={isFetching}
            data-testid="button-refresh-raw-state"
          >
            <RefreshCw className={`h-4 w-4 mr-2 ${isFetching ? 'animate-spin' : ''}`} />
            {isFetching ? 'Loading...' : 'Refresh'}
          </Button>
        </div>
      </CardHeader>

      {expanded && (
        <CardContent className="space-y-5">
          {isFetching && (
            <div className="flex items-center justify-center py-6">
              <RefreshCw className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          )}

          {isError && !data && (
            <Alert>
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription className="text-sm">Failed to load raw Dialpad state.</AlertDescription>
            </Alert>
          )}

          {data && (
            <>
              <div className="space-y-2">
                <h3 className="text-sm font-medium">Registered Webhooks</h3>
                {data.webhooksError ? (
                  <Alert>
                    <AlertTriangle className="h-4 w-4" />
                    <AlertDescription className="text-sm">{data.webhooksError}</AlertDescription>
                  </Alert>
                ) : data.webhooks.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No webhooks registered.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm border-collapse">
                      <thead>
                        <tr className="border-b text-muted-foreground text-xs">
                          <th className="text-left py-1.5 pr-3 font-medium">ID</th>
                          <th className="text-left py-1.5 pr-3 font-medium">URL</th>
                          <th className="text-left py-1.5 pr-3 font-medium">Type</th>
                          <th className="text-left py-1.5 font-medium">Enabled</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.webhooks.map((w) => {
                          const isForeign = w.hook_url && !w.hook_url.includes('hcpcrm.com');
                          return (
                            <tr
                              key={w.id}
                              className={`border-b last:border-b-0 ${isForeign ? 'bg-destructive/5' : ''}`}
                            >
                              <td className="py-2 pr-3 text-muted-foreground font-mono text-xs">{w.id}</td>
                              <td className={`py-2 pr-3 break-all ${isForeign ? 'text-destructive font-medium' : ''}`}>
                                {w.hook_url || <span className="text-muted-foreground italic">—</span>}
                                {isForeign && (
                                  <span className="ml-1.5 text-xs text-destructive">(not hcpcrm.com)</span>
                                )}
                              </td>
                              <td className="py-2 pr-3 text-muted-foreground">{w.hook_type ?? '—'}</td>
                              <td className="py-2">
                                {w.enabled === undefined ? (
                                  <span className="text-muted-foreground">—</span>
                                ) : w.enabled ? (
                                  <CheckCircle2 className="h-4 w-4 text-green-600" />
                                ) : (
                                  <XCircle className="h-4 w-4 text-destructive" />
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              <div className="space-y-2">
                <h3 className="text-sm font-medium">Active Call Subscriptions</h3>
                {data.subscriptionsError ? (
                  <Alert>
                    <AlertTriangle className="h-4 w-4" />
                    <AlertDescription className="text-sm">{data.subscriptionsError}</AlertDescription>
                  </Alert>
                ) : data.subscriptions.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No call subscriptions found.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm border-collapse">
                      <thead>
                        <tr className="border-b text-muted-foreground text-xs">
                          <th className="text-left py-1.5 pr-3 font-medium">ID</th>
                          <th className="text-left py-1.5 pr-3 font-medium">Target</th>
                          <th className="text-left py-1.5 pr-3 font-medium">States</th>
                          <th className="text-left py-1.5 font-medium">Webhook URL</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.subscriptions.map((s) => {
                          const webhookUrl = s.webhook?.hook_url ?? null;
                          const noWebhook = !webhookUrl;
                          return (
                            <tr
                              key={s.id}
                              className={`border-b last:border-b-0 ${noWebhook ? 'bg-destructive/5' : ''}`}
                            >
                              <td className="py-2 pr-3 text-muted-foreground font-mono text-xs">{s.id}</td>
                              <td className="py-2 pr-3">
                                {s.target_type ? (
                                  <span>{s.target_type}{s.target_id ? ` (${s.target_id})` : ''}</span>
                                ) : (
                                  <span className="text-muted-foreground italic">no target</span>
                                )}
                              </td>
                              <td className="py-2 pr-3">
                                {s.call_states && s.call_states.length > 0 ? (
                                  <span className="text-muted-foreground text-xs">{s.call_states.join(', ')}</span>
                                ) : (
                                  <span className="text-muted-foreground italic text-xs">none</span>
                                )}
                              </td>
                              <td className={`py-2 break-all ${noWebhook ? 'text-destructive font-medium' : ''}`}>
                                {noWebhook ? (
                                  <span className="flex items-center gap-1">
                                    <XCircle className="h-3.5 w-3.5 shrink-0" />
                                    No webhook linked
                                  </span>
                                ) : (
                                  webhookUrl
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </>
          )}
        </CardContent>
      )}
    </Card>
  );
}

export default function DialpadHealth() {
  const [, navigate] = useLocation();
  const [reregisterResult, setReregisterResult] = useState<{ success: boolean; message: string } | null>(null);
  const [retrySubsResult, setRetrySubsResult] = useState<{ success: boolean; message: string } | null>(null);

  const { data, isLoading, isError, refetch, isFetching } = useQuery<DiagnoseData>({
    queryKey: ['/api/dialpad/health/diagnose'],
    staleTime: 0,
  });

  const callWebhook = data?.webhooks?.find((w) => w.hook_url?.includes('/calls/'));
  const firstWebhook = data?.webhooks?.[0] ?? null;
  const webhookForSubs = callWebhook ?? firstWebhook;

  const reregisterMutation = useMutation<ReregisterWebhookResponse, Error>({
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
      queryClient.invalidateQueries({ queryKey: ['/api/dialpad/health/diagnose'] });
      if (result.callSubscriptionsActive) {
        setReregisterResult({ success: true, message: result.callSubscriptionWarning ? `Registered with warning: ${result.callSubscriptionWarning}` : 'Webhook and call subscriptions registered successfully.' });
      } else {
        const errorDetail = result.callSubscriptionError ?? result.message ?? 'Call subscriptions could not be created.';
        setReregisterResult({ success: false, message: `Webhook created but call subscriptions failed: ${errorDetail}` });
      }
    },
    onError: (error) => {
      setReregisterResult({ success: false, message: error.message || 'Failed to re-register webhook.' });
    },
  });

  const retrySubsMutation = useMutation<RetrySubsResponse, Error>({
    mutationFn: async () => {
      if (!webhookForSubs) throw new Error('No webhook found. Re-register a webhook first.');
      const response = await apiRequest('POST', '/api/dialpad/subscriptions/call/reregister', {
        callWebhookId: webhookForSubs.id,
        callHookUrl: webhookForSubs.hook_url,
      });
      return response.json() as Promise<RetrySubsResponse>;
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['/api/dialpad/health/diagnose'] });
      const count = result.subscriptionIds?.length ?? 0;
      setRetrySubsResult({ success: true, message: result.message ?? `Call subscriptions registered (${count} subscription${count !== 1 ? 's' : ''}, ${result.targetType} targeting).` });
    },
    onError: (error) => {
      setRetrySubsResult({ success: false, message: error.message || 'Failed to retry call subscriptions.' });
    },
  });

  const handleRefresh = () => {
    setReregisterResult(null);
    setRetrySubsResult(null);
    refetch();
  };

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <div className="flex items-center gap-3 flex-wrap">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate('/settings?tab=integrations')}
          data-testid="button-back-to-integrations"
        >
          <ArrowLeft className="h-4 w-4 mr-1" />
          Back to Integrations
        </Button>
      </div>

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold">Dialpad Webhook Health</h1>
          <p className="text-sm text-muted-foreground mt-1">Diagnose call event delivery, registered webhooks, and call subscriptions.</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={handleRefresh}
          disabled={isFetching}
          data-testid="button-refresh-health"
        >
          <RefreshCw className={`h-4 w-4 mr-2 ${isFetching ? 'animate-spin' : ''}`} />
          {isFetching ? 'Refreshing...' : 'Refresh'}
        </Button>
      </div>

      {isLoading && (
        <div className="flex items-center justify-center py-12">
          <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      )}

      {isError && (
        <Alert>
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>Failed to load diagnostic data. Make sure Dialpad is enabled and configured.</AlertDescription>
        </Alert>
      )}

      {data && (
        <div className="space-y-4">
          {(data.driftDetected
              || data.webhooks.some((w) => w.urlMismatch || w.matchesExpected === false)
              || data.subscriptions.some((s) => !s.webhookLinked)
              || data.subscriptions.length === 0
            ) && (
            <Alert className="border-amber-500/50 bg-amber-50 dark:bg-amber-950/20">
              <AlertTriangle className="h-4 w-4 text-amber-600" />
              <AlertDescription className="text-sm text-amber-700 dark:text-amber-400">
                <span className="font-semibold">Webhook configuration drift detected.</span> One or more registered webhooks no longer match the expected URL ({data.currentHost}), call subscriptions are unlinked, or no call subscriptions exist. Re-register to push the current host to Dialpad.
                <div className="mt-2">
                  <Button
                    size="sm"
                    onClick={() => { setReregisterResult(null); reregisterMutation.mutate(); }}
                    disabled={reregisterMutation.isPending || retrySubsMutation.isPending}
                    data-testid="button-reregister-webhook-banner"
                  >
                    {reregisterMutation.isPending ? (
                      <><RefreshCw className="h-4 w-4 mr-2 animate-spin" />Re-registering...</>
                    ) : (
                      <><Webhook className="h-4 w-4 mr-2" />Re-register Webhook Now</>
                    )}
                  </Button>
                </div>
              </AlertDescription>
            </Alert>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Phone className="h-4 w-4 text-muted-foreground" />
                Event Reception
              </CardTitle>
            </CardHeader>
            <CardContent>
              <EventReceptionStatus data={data.eventReception} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Webhook className="h-4 w-4 text-muted-foreground" />
                Expected Webhook URLs
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Calls</p>
                <p className="text-sm font-mono break-all" data-testid="text-expected-call-url">{data.expectedCallUrl}</p>
              </div>
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">SMS</p>
                <p className="text-sm font-mono break-all" data-testid="text-expected-sms-url">{data.expectedSmsUrl}</p>
              </div>
              {data.persistedState && (
                <div className="pt-2 border-t space-y-1 text-xs text-muted-foreground">
                  <p>
                    Last registered:{' '}
                    <span className="text-foreground">
                      {data.persistedState.lastRegisteredAt
                        ? new Date(data.persistedState.lastRegisteredAt).toLocaleString()
                        : '—'}
                    </span>
                  </p>
                  {data.persistedState.callWebhookId && (
                    <p>Stored call webhook ID: <span className="text-foreground font-mono">{data.persistedState.callWebhookId}</span></p>
                  )}
                  {data.persistedState.smsWebhookId && (
                    <p>Stored SMS webhook ID: <span className="text-foreground font-mono">{data.persistedState.smsWebhookId}</span></p>
                  )}
                  {data.persistedState.callSubscriptionIds && data.persistedState.callSubscriptionIds.length > 0 && (
                    <p>Stored call subscription IDs: <span className="text-foreground font-mono">{data.persistedState.callSubscriptionIds.join(', ')}</span></p>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Webhook className="h-4 w-4 text-muted-foreground" />
                Registered Webhooks
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {data.webhooksError ? (
                <Alert>
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription className="text-sm">{data.webhooksError}</AlertDescription>
                </Alert>
              ) : data.webhooks.length === 0 ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <XCircle className="h-4 w-4 shrink-0" />
                  No webhooks registered in Dialpad.
                </div>
              ) : (
                <div className="space-y-2">
                  {data.webhooks.map((webhook) => (
                    <div key={webhook.id} className="space-y-1">
                      <div className="flex items-start gap-2 flex-wrap">
                        <Badge variant="outline" className="shrink-0">ID: {webhook.id}</Badge>
                        <span className="text-sm text-muted-foreground break-all">{webhook.hook_url || '—'}</span>
                      </div>
                      {webhook.urlMismatch && (
                        <div className="flex items-center gap-1.5 text-xs text-amber-600 pl-1">
                          <AlertTriangle className="h-3 w-3 shrink-0" />
                          URL mismatch — this webhook points to a different host than the current app ({data.currentHost})
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              <div className="pt-2 border-t">
                <div className="space-y-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => { setReregisterResult(null); reregisterMutation.mutate(); }}
                    disabled={reregisterMutation.isPending || retrySubsMutation.isPending}
                    data-testid="button-reregister-webhook"
                  >
                    {reregisterMutation.isPending ? (
                      <><RefreshCw className="h-4 w-4 mr-2 animate-spin" />Re-registering...</>
                    ) : (
                      <><Webhook className="h-4 w-4 mr-2" />Re-register Webhook</>
                    )}
                  </Button>
                  {reregisterResult && (
                    <Alert className={reregisterResult.success ? 'border-green-500/50 bg-green-50 dark:bg-green-950/20' : 'border-destructive/50 bg-destructive/5'}>
                      {reregisterResult.success
                        ? <CheckCircle2 className="h-4 w-4 text-green-600" />
                        : <AlertTriangle className="h-4 w-4 text-destructive" />
                      }
                      <AlertDescription className="text-sm">{reregisterResult.message}</AlertDescription>
                    </Alert>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Phone className="h-4 w-4 text-muted-foreground" />
                Call Subscriptions
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {data.subscriptionsError ? (
                <Alert>
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription className="text-sm">{data.subscriptionsError}</AlertDescription>
                </Alert>
              ) : data.subscriptions.length === 0 ? (
                <div className="flex items-center gap-2 text-sm">
                  <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />
                  <span className="text-muted-foreground">No call subscriptions found. Call events will not be delivered without active subscriptions.</span>
                </div>
              ) : (
                <div className="space-y-2">
                  {data.activeSubscriptionCount === 0 && (
                    <Alert className="border-amber-500/50 bg-amber-50 dark:bg-amber-950/20">
                      <AlertTriangle className="h-4 w-4 text-amber-600" />
                      <AlertDescription className="text-sm text-amber-700 dark:text-amber-400">
                        No active call subscriptions. Call events will not be delivered.
                      </AlertDescription>
                    </Alert>
                  )}
                  {data.subscriptions.map((sub) => (
                    <div key={sub.id} className="space-y-1.5 pb-2 last:pb-0 border-b last:border-b-0" data-testid={`call-sub-${sub.id}`}>
                      <div className="flex items-center gap-2 flex-wrap">
                        <Badge variant={sub.enabled ? "default" : "secondary"}>
                          {sub.enabled ? 'Active' : 'Disabled'}
                        </Badge>
                        {sub.webhookLinked ? (
                          <Badge variant="outline" className="text-xs gap-1" data-testid={`badge-webhook-linked-${sub.id}`}>
                            <CheckCircle2 className="h-3 w-3 text-green-600" />
                            Webhook linked
                          </Badge>
                        ) : (
                          <Badge variant="destructive" className="text-xs gap-1" data-testid={`badge-webhook-missing-${sub.id}`}>
                            <XCircle className="h-3 w-3" />
                            Webhook missing
                          </Badge>
                        )}
                        <span className="text-sm text-muted-foreground">
                          Target: <span className="text-foreground">{sub.target_type ?? 'account (no target)'}</span>
                          {sub.target_id ? <span> ({sub.target_id})</span> : null}
                        </span>
                        <span className="text-xs text-muted-foreground ml-auto">ID: {sub.id}</span>
                      </div>
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-xs text-muted-foreground">States:</span>
                        {sub.call_states && sub.call_states.length > 0 ? (
                          sub.call_states.map((state) => (
                            <Badge key={state} variant="outline" className="text-xs px-1.5 py-0">
                              {state}
                            </Badge>
                          ))
                        ) : (
                          <span className="text-xs text-muted-foreground italic">none returned</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <div className="pt-2 border-t">
                <div className="space-y-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => { setRetrySubsResult(null); retrySubsMutation.mutate(); }}
                    disabled={retrySubsMutation.isPending || reregisterMutation.isPending || !webhookForSubs}
                    data-testid="button-retry-call-subscriptions"
                  >
                    {retrySubsMutation.isPending ? (
                      <><RefreshCw className="h-4 w-4 mr-2 animate-spin" />Retrying...</>
                    ) : (
                      <><RotateCcw className="h-4 w-4 mr-2" />Retry Call Subscriptions</>
                    )}
                  </Button>
                  {!webhookForSubs && !retrySubsMutation.isPending && (
                    <p className="text-xs text-muted-foreground">No webhook found — re-register a webhook first before retrying subscriptions.</p>
                  )}
                  {retrySubsResult && (
                    <Alert className={retrySubsResult.success ? 'border-green-500/50 bg-green-50 dark:bg-green-950/20' : 'border-destructive/50 bg-destructive/5'}>
                      {retrySubsResult.success
                        ? <CheckCircle2 className="h-4 w-4 text-green-600" />
                        : <AlertTriangle className="h-4 w-4 text-destructive" />
                      }
                      <AlertDescription className="text-sm">{retrySubsResult.message}</AlertDescription>
                    </Alert>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Webhook className="h-4 w-4 text-muted-foreground" />
                SMS Subscriptions
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {data.smsSubscriptionsError ? (
                <Alert>
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription className="text-sm">{data.smsSubscriptionsError}</AlertDescription>
                </Alert>
              ) : data.smsSubscriptions.length === 0 ? (
                <div className="flex items-center gap-2 text-sm">
                  <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />
                  <span className="text-muted-foreground">No SMS subscriptions found. Inbound SMS will not be delivered.</span>
                </div>
              ) : (
                <div className="space-y-2">
                  {data.activeSmsSubscriptionCount === 0 && (
                    <Alert className="border-amber-500/50 bg-amber-50 dark:bg-amber-950/20">
                      <AlertTriangle className="h-4 w-4 text-amber-600" />
                      <AlertDescription className="text-sm text-amber-700 dark:text-amber-400">
                        No active SMS subscriptions. SMS events will not be delivered.
                      </AlertDescription>
                    </Alert>
                  )}
                  {data.smsSubscriptions.map((sub) => (
                    <div key={sub.id} className="space-y-1 pb-2 last:pb-0 border-b last:border-b-0" data-testid={`sms-sub-${sub.id}`}>
                      <div className="flex items-center gap-2 flex-wrap">
                        <Badge variant="outline">ID: {sub.id}</Badge>
                        {sub.direction && <Badge variant="secondary">{sub.direction}</Badge>}
                        {sub.enabled ? (
                          <Badge>Enabled</Badge>
                        ) : (
                          <Badge variant="destructive">Disabled</Badge>
                        )}
                        {sub.webhook_id && (
                          sub.webhookLinked ? (
                            <span className="flex items-center gap-1 text-xs text-green-600">
                              <CheckCircle2 className="h-3 w-3" />
                              Webhook linked ({sub.webhook_id})
                            </span>
                          ) : (
                            <span className="flex items-center gap-1 text-xs text-destructive">
                              <XCircle className="h-3 w-3" />
                              Webhook missing ({sub.webhook_id})
                            </span>
                          )
                        )}
                      </div>
                      {sub.hook_url && (
                        <p className="text-xs text-muted-foreground break-all">{sub.hook_url}</p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <RawStatePanel />
        </div>
      )}
    </div>
  );
}
