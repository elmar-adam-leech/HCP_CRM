import { useEffect } from "react";
import { useLocation } from "wouter";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Mail, RefreshCw, CheckCircle, XCircle, AlertTriangle } from "lucide-react";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { IntegrationCardShell } from "./IntegrationCardShell";

export function GmailConnectionCard() {
  const { data: currentUser } = useCurrentUser();
  const gmailConnected = currentUser?.user?.gmailConnected || false;
  const gmailEmail = currentUser?.user?.gmailEmail;
  const gmailExpired = !gmailConnected && !!gmailEmail;
  const { toast } = useToast();
  const [, navigate] = useLocation();

  const syncGmailMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest('POST', '/api/emails/fetch-gmail', {});
      return response.json();
    },
    onSuccess: (data) => {
      toast({
        title: "Gmail synced",
        description: `Fetched ${data.count} new email${data.count !== 1 ? 's' : ''}`,
      });
      queryClient.invalidateQueries({ queryKey: ['/api/conversations'] });
      queryClient.invalidateQueries({ queryKey: ['/api/messages'] });
    },
    onError: (error: any) => {
      toast({
        variant: "destructive",
        title: "Sync failed",
        description: error.message || "Failed to sync Gmail emails",
      });
    }
  });

  const connectGmailMutation = useMutation({
    mutationFn: async () => {
      const response = await fetch('/api/oauth/gmail/connect', {
        method: 'GET',
        credentials: 'include'
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'Failed to connect Gmail');
      }
      return response.json();
    },
    onSuccess: (data: { authUrl?: string }) => {
      if (!data.authUrl) {
        toast({
          title: "Gmail Connection Failed",
          description: "No authorization URL received. Please try again.",
          variant: "destructive",
        });
        return;
      }
      window.location.href = data.authUrl;
    },
    onError: (error: any) => {
      toast({
        title: "Gmail Connection Failed",
        description: error.message || "Failed to initiate Gmail connection. Please try again.",
        variant: "destructive",
      });
    },
  });

  const disconnectGmailMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest('POST', '/api/oauth/gmail/disconnect');
      return response.json();
    },
    onSuccess: () => {
      toast({
        title: "Gmail Disconnected",
        description: "Your Gmail account has been disconnected successfully.",
      });
      queryClient.invalidateQueries({ queryKey: ['/api/auth/me'] });
    },
    onError: (error: any) => {
      toast({
        title: "Disconnection Failed",
        description: error.message || "Failed to disconnect Gmail. Please try again.",
        variant: "destructive",
      });
    },
  });

  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const gmailStatus = urlParams.get('gmail');

    if (gmailStatus === 'connected') {
      toast({
        title: "Gmail Connected",
        description: "Your Gmail account has been connected successfully!",
      });
      queryClient.invalidateQueries({ queryKey: ['/api/auth/me'] });
      navigate('/settings?tab=integrations', { replace: true });
    } else if (gmailStatus === 'error') {
      const reason = urlParams.get('reason');
      toast({
        title: "Gmail Connection Failed",
        description: reason === 'no_refresh_token'
          ? "No refresh token received. Please disconnect the app from Google Account Permissions and try again."
          : "Failed to connect Gmail. Please try again.",
        variant: "destructive",
      });
      navigate('/settings?tab=integrations', { replace: true });
    }
  }, [toast, navigate]);

  const statusIcon = gmailConnected
    ? <CheckCircle className="h-5 w-5 text-green-600" />
    : gmailExpired
      ? <AlertTriangle className="h-5 w-5 text-amber-500" />
      : <XCircle className="h-5 w-5 text-muted-foreground" />;

  return (
    <IntegrationCardShell
      icon={<Mail className="h-5 w-5" />}
      title="Gmail Connection"
      description="Connect your Gmail account to send and receive emails from the CRM"
      statusIcon={statusIcon}
      isLoading={false}
    >
      <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between">
        {gmailConnected ? (
          <Badge variant="default">
            <CheckCircle className="h-3 w-3 mr-1" />
            Connected
          </Badge>
        ) : gmailExpired ? (
          <Badge variant="outline" className="border-amber-500 text-amber-600 dark:text-amber-400 gap-1">
            <AlertTriangle className="h-3 w-3" />
            Connection Expired
          </Badge>
        ) : (
          <Badge variant="secondary">
            <XCircle className="h-3 w-3 mr-1" />
            Not Connected
          </Badge>
        )}
        <div className="flex items-center gap-2 flex-wrap">
          {gmailConnected ? (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => syncGmailMutation.mutate()}
                disabled={syncGmailMutation.isPending}
                data-testid="button-sync-gmail"
              >
                {syncGmailMutation.isPending ? (
                  <><RefreshCw className="h-4 w-4 mr-2 animate-spin" />Syncing...</>
                ) : (
                  <><RefreshCw className="h-4 w-4 mr-2" />Sync Emails</>
                )}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => disconnectGmailMutation.mutate()}
                disabled={disconnectGmailMutation.isPending}
                data-testid="button-disconnect-gmail"
              >
                {disconnectGmailMutation.isPending ? (
                  <><RefreshCw className="h-4 w-4 mr-2 animate-spin" />Disconnecting...</>
                ) : (
                  'Disconnect'
                )}
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              onClick={() => connectGmailMutation.mutate()}
              disabled={connectGmailMutation.isPending}
              data-testid="button-connect-gmail"
            >
              {connectGmailMutation.isPending ? (
                <><RefreshCw className="h-4 w-4 mr-2 animate-spin" />Connecting...</>
              ) : gmailExpired ? (
                <><Mail className="h-4 w-4 mr-2" />Reconnect Gmail</>
              ) : (
                <><Mail className="h-4 w-4 mr-2" />Connect Gmail</>
              )}
            </Button>
          )}
        </div>
      </div>
      {gmailConnected && gmailEmail && (
        <p className="text-sm text-muted-foreground" data-testid="text-gmail-email">
          Connected as: {gmailEmail}
        </p>
      )}
      {gmailExpired && gmailEmail && (
        <p className="text-sm text-amber-600 dark:text-amber-400" data-testid="text-gmail-expired">
          Your Gmail connection for <strong>{gmailEmail}</strong> has expired. Please reconnect to continue sending and receiving emails.
        </p>
      )}
    </IntegrationCardShell>
  );
}
