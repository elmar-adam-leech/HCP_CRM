import { useEffect } from "react";
import { useLocation } from "wouter";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Calendar, RefreshCw, CheckCircle, XCircle, AlertTriangle } from "lucide-react";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { IntegrationCardShell } from "./IntegrationCardShell";

export function GoogleCalendarConnectionCard() {
  const { data: currentUser } = useCurrentUser();
  const calendarConnected = currentUser?.user?.googleCalendarConnected || false;
  const calendarEmail = currentUser?.user?.googleCalendarEmail;
  const calendarExpired = !calendarConnected && !!calendarEmail;
  const { toast } = useToast();
  const [, navigate] = useLocation();

  const connectMutation = useMutation({
    mutationFn: async () => {
      const response = await fetch('/api/oauth/google-calendar/connect', {
        method: 'GET',
        credentials: 'include'
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'Failed to connect Google Calendar');
      }
      return response.json();
    },
    onSuccess: (data: { authUrl?: string }) => {
      if (!data.authUrl) {
        toast({
          title: "Google Calendar Connection Failed",
          description: "No authorization URL received. Please try again.",
          variant: "destructive",
        });
        return;
      }
      window.location.href = data.authUrl;
    },
    onError: (error: any) => {
      toast({
        title: "Google Calendar Connection Failed",
        description: error.message || "Failed to initiate Google Calendar connection. Please try again.",
        variant: "destructive",
      });
    },
  });

  const disconnectMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest('POST', '/api/oauth/google-calendar/disconnect');
      return response.json();
    },
    onSuccess: () => {
      toast({
        title: "Google Calendar Disconnected",
        description: "Your Google Calendar account has been disconnected successfully.",
      });
      queryClient.invalidateQueries({ queryKey: ['/api/auth/me'] });
    },
    onError: (error: any) => {
      toast({
        title: "Disconnection Failed",
        description: error.message || "Failed to disconnect Google Calendar. Please try again.",
        variant: "destructive",
      });
    },
  });

  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const status = urlParams.get('google_calendar');

    if (status === 'connected') {
      toast({
        title: "Google Calendar Connected",
        description: "Your Google Calendar account has been connected successfully!",
      });
      queryClient.invalidateQueries({ queryKey: ['/api/auth/me'] });
      navigate('/settings?tab=integrations', { replace: true });
    } else if (status === 'error') {
      const reason = urlParams.get('reason');
      toast({
        title: "Google Calendar Connection Failed",
        description: reason === 'no_refresh_token'
          ? "No refresh token received. Please disconnect the app from Google Account Permissions and try again."
          : "Failed to connect Google Calendar. Please try again.",
        variant: "destructive",
      });
      navigate('/settings?tab=integrations', { replace: true });
    }
  }, [toast, navigate]);

  const statusIcon = calendarConnected
    ? <CheckCircle className="h-5 w-5 text-green-600" />
    : calendarExpired
      ? <AlertTriangle className="h-5 w-5 text-amber-500" />
      : <XCircle className="h-5 w-5 text-muted-foreground" />;

  return (
    <IntegrationCardShell
      icon={<Calendar className="h-5 w-5" />}
      title="Google Calendar Connection"
      description="Connect your Google Calendar so booked appointments are added to your calendar and your busy times block availability"
      statusIcon={statusIcon}
      isLoading={false}
    >
      <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between">
        {calendarConnected ? (
          <Badge variant="default">
            <CheckCircle className="h-3 w-3 mr-1" />
            Connected
          </Badge>
        ) : calendarExpired ? (
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
          {calendarConnected ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => disconnectMutation.mutate()}
              disabled={disconnectMutation.isPending}
              data-testid="button-disconnect-google-calendar"
            >
              {disconnectMutation.isPending ? (
                <><RefreshCw className="h-4 w-4 mr-2 animate-spin" />Disconnecting...</>
              ) : (
                'Disconnect'
              )}
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={() => connectMutation.mutate()}
              disabled={connectMutation.isPending}
              data-testid="button-connect-google-calendar"
            >
              {connectMutation.isPending ? (
                <><RefreshCw className="h-4 w-4 mr-2 animate-spin" />Connecting...</>
              ) : calendarExpired ? (
                <><Calendar className="h-4 w-4 mr-2" />Reconnect Google Calendar</>
              ) : (
                <><Calendar className="h-4 w-4 mr-2" />Connect Google Calendar</>
              )}
            </Button>
          )}
        </div>
      </div>
      {calendarConnected && calendarEmail && (
        <p className="text-sm text-muted-foreground" data-testid="text-google-calendar-email">
          Connected as: {calendarEmail}
        </p>
      )}
      {calendarExpired && calendarEmail && (
        <p className="text-sm text-amber-600 dark:text-amber-400" data-testid="text-google-calendar-expired">
          Your Google Calendar connection for <strong>{calendarEmail}</strong> has expired. Please reconnect to keep syncing appointments and availability.
        </p>
      )}
    </IntegrationCardShell>
  );
}
