import { useEffect } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Mail, CheckCircle, XCircle, RefreshCw, Building2 } from "lucide-react";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { IntegrationCardShell } from "./IntegrationCardShell";

interface SharedEmailStatus {
  connected: boolean;
  email?: string;
  displayName?: string;
  connectedByName?: string;
  createdAt?: string;
  lastSyncAt?: string | null;
}

function formatRelative(when: string): string {
  const then = new Date(when).getTime();
  if (Number.isNaN(then)) return 'unknown';
  const diffSec = Math.round((Date.now() - then) / 1000);
  if (diffSec < 60) return 'just now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} min ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} hr ago`;
  return `${Math.floor(diffSec / 86400)} days ago`;
}

export function SharedEmailCard() {
  const { toast } = useToast();
  const [, navigate] = useLocation();

  const { data: status, isLoading } = useQuery<SharedEmailStatus>({
    queryKey: ['/api/settings/shared-email'],
  });

  const connectMutation = useMutation({
    mutationFn: async () => {
      const response = await fetch('/api/settings/shared-email/oauth/start', {
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
      if (!data.authUrl) {
        toast({ title: "Connection Failed", description: "No authorization URL received.", variant: "destructive" });
        return;
      }
      window.location.href = data.authUrl;
    },
    onError: (error: any) => {
      toast({ title: "Connection Failed", description: error.message || "Failed to initiate connection.", variant: "destructive" });
    },
  });

  const disconnectMutation = useMutation({
    mutationFn: async () => {
      return apiRequest('DELETE', '/api/settings/shared-email');
    },
    onSuccess: () => {
      toast({ title: "Disconnected", description: "Shared company email has been disconnected." });
      queryClient.invalidateQueries({ queryKey: ['/api/settings/shared-email'] });
    },
    onError: (error: any) => {
      toast({ title: "Disconnection Failed", description: error.message || "Failed to disconnect.", variant: "destructive" });
    },
  });

  const syncNowMutation = useMutation({
    mutationFn: async () => {
      return apiRequest('POST', '/api/settings/shared-email/sync');
    },
    onSuccess: () => {
      toast({ title: "Sync Started", description: "Checking the shared inbox for new emails." });
      // Refresh the lastSyncAt timestamp shortly after the sync runs.
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ['/api/settings/shared-email'] });
      }, 3000);
    },
    onError: (error: any) => {
      toast({ title: "Sync Failed", description: error.message || "Failed to start sync.", variant: "destructive" });
    },
  });

  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const sharedEmailStatus = urlParams.get('shared_email');
    if (sharedEmailStatus === 'success') {
      toast({ title: "Connected", description: "Shared company email has been connected successfully!" });
      queryClient.invalidateQueries({ queryKey: ['/api/settings/shared-email'] });
      navigate('/settings?tab=integrations', { replace: true });
    } else if (sharedEmailStatus === 'error') {
      const reason = urlParams.get('reason');
      toast({
        title: "Connection Failed",
        description: reason === 'no_refresh_token'
          ? "No refresh token received. Please disconnect the app from Google Account Permissions and try again."
          : "Failed to connect shared email. Please try again.",
        variant: "destructive",
      });
      navigate('/settings?tab=integrations', { replace: true });
    }
  }, [toast, navigate]);

  const connected = status?.connected || false;

  const statusIcon = connected
    ? <CheckCircle className="h-5 w-5 text-green-600" />
    : <XCircle className="h-5 w-5 text-muted-foreground" />;

  return (
    <IntegrationCardShell
      icon={<Building2 className="h-5 w-5" />}
      title="Shared Company Email"
      description="Connect a company Gmail account for team-wide outbound email"
      statusIcon={statusIcon}
      isLoading={isLoading}
      data-testid="card-shared-email"
    >
      <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between">
        {connected ? (
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
          {connected ? (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => syncNowMutation.mutate()}
                disabled={syncNowMutation.isPending}
                data-testid="button-sync-shared-email"
              >
                {syncNowMutation.isPending ? (
                  <><RefreshCw className="h-4 w-4 mr-2 animate-spin" />Syncing...</>
                ) : (
                  <><RefreshCw className="h-4 w-4 mr-2" />Sync Now</>
                )}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => disconnectMutation.mutate()}
                disabled={disconnectMutation.isPending}
                data-testid="button-disconnect-shared-email"
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
              disabled={connectMutation.isPending}
              data-testid="button-connect-shared-email"
            >
              {connectMutation.isPending ? (
                <><RefreshCw className="h-4 w-4 mr-2 animate-spin" />Connecting...</>
              ) : (
                <><Mail className="h-4 w-4 mr-2" />Connect Gmail</>
              )}
            </Button>
          )}
        </div>
      </div>
      {connected && status?.email && (
        <p className="text-sm text-muted-foreground" data-testid="text-shared-email-address">
          Connected as: {status.email}
        </p>
      )}
      {connected && (
        <p className="text-xs text-muted-foreground" data-testid="text-shared-email-last-sync">
          Last synced: {status?.lastSyncAt ? formatRelative(status.lastSyncAt) : 'never'}
        </p>
      )}
      {connected && status?.connectedByName && (
        <p className="text-xs text-muted-foreground">
          Connected by {status.connectedByName}
          {status.createdAt && ` on ${new Date(status.createdAt).toLocaleDateString()}`}
        </p>
      )}
    </IntegrationCardShell>
  );
}
