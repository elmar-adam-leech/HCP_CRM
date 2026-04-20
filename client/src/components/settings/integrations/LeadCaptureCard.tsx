import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { Inbox, RefreshCw, CheckCircle, XCircle, Shield, KeyRound, AlertTriangle } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { formatDateTime } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { SenderRulesSection } from "./SenderRulesSection";
import { SpamAuditLogSection } from "./SpamAuditLogSection";
import { IntegrationCardShell } from "./IntegrationCardShell";

interface LeadCaptureInboxData {
  id: string;
  emailAddress: string;
  lastSyncAt: string | null;
  spamFilterEnabled: boolean;
  spamConfidenceThreshold: number;
  isActive: boolean;
  createdAt: string;
}

function SpamThresholdSlider({ serverValue, onCommit, disabled }: { serverValue: number; onCommit: (v: number) => void; disabled: boolean }) {
  const [localValue, setLocalValue] = useState(serverValue);

  useEffect(() => {
    setLocalValue(serverValue);
  }, [serverValue]);

  return (
    <div className="space-y-2 pt-1 min-w-0 w-full">
      <div className="flex items-center justify-between gap-2">
        <Label className="text-sm font-medium">
          Spam Confidence Threshold
        </Label>
        <span className="text-sm font-medium tabular-nums">
          {localValue}
        </span>
      </div>
      <div className="w-full min-w-0 overflow-hidden">
        <Slider
          min={1}
          max={100}
          step={1}
          value={[localValue]}
          onValueChange={([v]) => setLocalValue(v)}
          onValueCommit={([v]) => onCommit(v)}
          disabled={disabled}
          data-testid="slider-spam-threshold"
        />
      </div>
      <p className="text-xs text-muted-foreground">
        Emails with a spam confidence score at or above this threshold will be flagged as spam. Lower values are more aggressive.
      </p>
    </div>
  );
}

export function LeadCaptureCard() {
  const { toast } = useToast();
  const [, navigate] = useLocation();

  const { data: inbox, isLoading } = useQuery<LeadCaptureInboxData | null>({
    queryKey: ['/api/settings/lead-capture-inbox'],
  });

  const isConnected = !!inbox;

  const connectMutation = useMutation({
    mutationFn: async () => {
      const response = await fetch('/api/settings/lead-capture-inbox/oauth/start', {
        method: 'GET',
        credentials: 'include',
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'Failed to start connection');
      }
      return response.json();
    },
    onSuccess: (data: { authUrl?: string }) => {
      if (data.authUrl) {
        window.location.href = data.authUrl;
      } else {
        toast({
          title: "Connection Failed",
          description: "No authorization URL received.",
          variant: "destructive",
        });
      }
    },
    onError: (error: any) => {
      toast({
        title: "Connection Failed",
        description: error.message || "Failed to connect lead capture inbox.",
        variant: "destructive",
      });
    },
  });

  const disconnectMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest('DELETE', '/api/settings/lead-capture-inbox');
      return response.json();
    },
    onSuccess: () => {
      toast({ title: "Disconnected", description: "Lead capture inbox has been disconnected." });
      queryClient.invalidateQueries({ queryKey: ['/api/settings/lead-capture-inbox'] });
    },
    onError: (error: any) => {
      toast({
        title: "Disconnect Failed",
        description: error.message || "Failed to disconnect inbox.",
        variant: "destructive",
      });
    },
  });

  const syncMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest('POST', '/api/settings/lead-capture-inbox/sync');
      return response.json();
    },
    onSuccess: (data) => {
      toast({
        title: "Sync Complete",
        description: data.message || "Lead capture sync completed.",
      });
      queryClient.invalidateQueries({ queryKey: ['/api/settings/lead-capture-inbox'] });
    },
    onError: (error: any) => {
      toast({
        title: "Sync Failed",
        description: error.message || "Failed to sync inbox.",
        variant: "destructive",
      });
    },
  });

  const spamFilterMutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      const response = await apiRequest('POST', '/api/settings/lead-capture-inbox/spam-filter', { enabled });
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/settings/lead-capture-inbox'] });
    },
    onError: (error: any) => {
      toast({
        title: "Update Failed",
        description: error.message || "Failed to update spam filter setting.",
        variant: "destructive",
      });
    },
  });

  const thresholdMutation = useMutation({
    mutationFn: async (threshold: number) => {
      const response = await apiRequest('POST', '/api/settings/lead-capture-inbox/spam-threshold', { threshold });
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/settings/lead-capture-inbox'] });
    },
    onError: (error: any) => {
      toast({
        title: "Update Failed",
        description: error.message || "Failed to update spam threshold.",
        variant: "destructive",
      });
    },
  });

  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const status = urlParams.get('lead_capture');

    if (status === 'success') {
      toast({
        title: "Lead Capture Connected",
        description: "Your lead capture inbox has been connected successfully!",
      });
      queryClient.invalidateQueries({ queryKey: ['/api/settings/lead-capture-inbox'] });
      navigate('/settings?tab=integrations', { replace: true });
    } else if (status === 'error') {
      const reason = urlParams.get('reason');
      toast({
        title: "Connection Failed",
        description: reason === 'no_refresh_token'
          ? "No refresh token received. Please try again."
          : "Failed to connect lead capture inbox. Please try again.",
        variant: "destructive",
      });
      navigate('/settings?tab=integrations', { replace: true });
    }
  }, [toast, navigate]);

  const statusIcon = isConnected
    ? <CheckCircle className="h-5 w-5 text-green-600" />
    : <XCircle className="h-5 w-5 text-muted-foreground" />;

  return (
    <IntegrationCardShell
      icon={<Inbox className="h-5 w-5" />}
      title="Lead Capture Inbox"
      description="Auto-create leads from emails sent to a designated Gmail inbox"
      statusIcon={statusIcon}
      isLoading={false}
    >
      <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between">
        {isConnected ? (
          <Badge variant="default">
            <CheckCircle className="h-3 w-3 mr-1" />
            Connected
          </Badge>
        ) : (
          <Badge variant="secondary">
            <XCircle className="h-3 w-3 mr-1" />
            Not Connected
          </Badge>
        )}
        <div className="flex items-center gap-2 flex-wrap">
          {isConnected ? (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => syncMutation.mutate()}
                disabled={syncMutation.isPending}
                data-testid="button-sync-lead-capture"
              >
                {syncMutation.isPending ? (
                  <><RefreshCw className="h-4 w-4 mr-2 animate-spin" />Syncing...</>
                ) : (
                  <><RefreshCw className="h-4 w-4 mr-2" />Sync Now</>
                )}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => connectMutation.mutate()}
                disabled={connectMutation.isPending}
                data-testid="button-reconnect-lead-capture"
              >
                {connectMutation.isPending ? (
                  <><RefreshCw className="h-4 w-4 mr-2 animate-spin" />Reconnecting...</>
                ) : (
                  <><KeyRound className="h-4 w-4 mr-2" />Reconnect</>
                )}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => disconnectMutation.mutate()}
                disabled={disconnectMutation.isPending}
                data-testid="button-disconnect-lead-capture"
              >
                {disconnectMutation.isPending ? (
                  <><RefreshCw className="h-4 w-4 mr-2 animate-spin" />Disconnecting...</>
                ) : (
                  'Disconnect'
                )}
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              onClick={() => connectMutation.mutate()}
              disabled={connectMutation.isPending || isLoading}
              data-testid="button-connect-lead-capture"
            >
              {connectMutation.isPending ? (
                <><RefreshCw className="h-4 w-4 mr-2 animate-spin" />Connecting...</>
              ) : (
                <><Inbox className="h-4 w-4 mr-2" />Connect Gmail Account</>
              )}
            </Button>
          )}
        </div>
      </div>

      {isConnected && inbox && (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Connected inbox: <span className="font-medium text-foreground">{inbox.emailAddress}</span>
          </p>
          <p className="text-sm text-muted-foreground">
            Last synced: {formatDateTime(inbox.lastSyncAt)}
          </p>
          {(() => {
            if (!inbox.lastSyncAt) return null;
            const minutesAgo = (Date.now() - new Date(inbox.lastSyncAt).getTime()) / 60_000;
            if (minutesAgo <= 30) return null;
            return (
              <Alert className="border-yellow-500/50 bg-yellow-500/10 text-yellow-700 dark:text-yellow-400">
                <AlertTriangle className="h-4 w-4 text-yellow-500" />
                <AlertDescription>
                  Sync appears stale. If leads are missing, try reconnecting your inbox.
                </AlertDescription>
              </Alert>
            );
          })()}
          <Separator />
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Shield className="h-4 w-4 text-muted-foreground" />
              <Label htmlFor="spam-filter" className="text-sm font-medium cursor-pointer">
                Spam Filter
              </Label>
            </div>
            <Switch
              id="spam-filter"
              checked={inbox.spamFilterEnabled}
              onCheckedChange={(checked) => spamFilterMutation.mutate(checked)}
              disabled={spamFilterMutation.isPending}
              data-testid="switch-spam-filter"
            />
          </div>
          <p className="text-xs text-muted-foreground">
            When enabled, AI screens incoming emails and skips spam or solicitations before creating leads.
          </p>
          {inbox.spamFilterEnabled && (
            <>
              <SpamThresholdSlider
                serverValue={inbox.spamConfidenceThreshold}
                onCommit={(value) => thresholdMutation.mutate(value)}
                disabled={thresholdMutation.isPending}
              />
              <SpamAuditLogSection />
            </>
          )}
          <SenderRulesSection spamFilterEnabled={inbox.spamFilterEnabled} />
        </div>
      )}
    </IntegrationCardShell>
  );
}
