import { useCredentialManager } from "@/hooks/useCredentialManager";
import { useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Mail, Star, AlertTriangle, BookOpen, Power } from "lucide-react";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useProviderConfig } from "@/hooks/use-provider-config";
import { useIntegrationCard, getStatusIcon, getStatusText } from "@/hooks/use-integration-card";
import { IntegrationCardShell } from "./IntegrationCardShell";

export function SendGridCard() {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const { integration, isLoading, isAdmin, toggleEnabled, isTogglingEnabled, saveCredentials, isSavingCredentials } = useIntegrationCard('sendgrid');
  const { data: providerData } = useProviderConfig();
  const {
    editingCredential,
    setEditingCredential,
    credentialInput,
    setCredentialInput,
    handleSaveCredentials,
    handleCancelEdit,
  } = useCredentialManager({ onSave: saveCredentials });

  const isDefaultEmailProvider = providerData?.configured?.find(
    p => p.providerType === 'email' && p.isActive && p.emailProvider === 'sendgrid'
  ) !== undefined;

  const setDefaultMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest('POST', '/api/providers', { providerType: 'email', providerName: 'sendgrid' });
      return response.json();
    },
    onSuccess: () => {
      toast({ title: "Provider Set", description: "SendGrid has been set as your email provider." });
      queryClient.invalidateQueries({ queryKey: ['/api/providers'] });
    },
    onError: (error: any) => { toast({ title: "Error", description: error.message || "Failed to set provider", variant: "destructive" }); },
  });

  if (isLoading) {
    return (
      <IntegrationCardShell
        icon={<Mail className="h-5 w-5" />}
        title="SendGrid"
        description="Email services for customer communication via SendGrid"
        statusIcon={<></>}
        isLoading={true}
      >
        <></>
      </IntegrationCardShell>
    );
  }

  if (!integration) return null;

  const status = getStatusText(integration);

  const headerExtra = isDefaultEmailProvider ? (
    <Badge variant="default" className="gap-1"><Star className="h-3 w-3" />Default</Badge>
  ) : undefined;

  return (
    <IntegrationCardShell
      icon={<Mail className="h-5 w-5" />}
      title="SendGrid"
      description="Email services for customer communication via SendGrid"
      statusIcon={getStatusIcon(integration)}
      headerExtra={headerExtra}
      isLoading={false}
    >
      <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between">
        <Badge variant={status.variant}>{status.text}</Badge>
        {!isDefaultEmailProvider && integration.hasCredentials && (
          <Button variant="outline" size="sm" onClick={() => setDefaultMutation.mutate()} disabled={setDefaultMutation.isPending} data-testid="button-set-default-sendgrid">
            <Star className="h-3 w-3 mr-1" />Set as Default
          </Button>
        )}
      </div>
      {integration.hasCredentials && (
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Power className="h-4 w-4 text-muted-foreground" />
            <Label htmlFor="sendgrid-enabled" className="text-sm font-medium cursor-pointer">Enabled</Label>
          </div>
          <Switch id="sendgrid-enabled" checked={integration.isEnabled} onCheckedChange={() => toggleEnabled(integration.isEnabled)} disabled={isTogglingEnabled} data-testid="switch-sendgrid" />
        </div>
      )}

      {integration.hasCredentials && isAdmin && !editingCredential && (
        <div className="pt-3 border-t flex gap-2 flex-wrap">
          <Button variant="outline" size="sm" onClick={() => setEditingCredential(true)} data-testid="button-update-sendgrid-api-key">
            Update API Key
          </Button>
          <Button variant="outline" size="sm" onClick={() => navigate('/sendgrid-setup')} data-testid="button-sendgrid-setup-guide">
            <BookOpen className="h-3 w-3 mr-1" />
            Setup Guide
          </Button>
        </div>
      )}

      {(!integration.hasCredentials || editingCredential) && (
        isAdmin ? (
          <div className="space-y-3">
            <Label htmlFor="sendgrid-api-key" className="text-sm font-medium">
              {integration.hasCredentials ? 'Update API Key' : 'API Key'}
            </Label>
            <div className="flex flex-col sm:flex-row gap-2">
              <Input
                id="sendgrid-api-key"
                type="password"
                placeholder={integration.hasCredentials ? "Enter new API key..." : "Enter your API key..."}
                value={credentialInput}
                onChange={(e) => setCredentialInput(e.target.value)}
                className="w-full"
                data-testid="input-sendgrid-api-key"
              />
              <div className="flex gap-2 shrink-0">
                <Button onClick={handleSaveCredentials} disabled={isSavingCredentials || !credentialInput.trim()} data-testid="button-save-sendgrid">
                  {isSavingCredentials ? "Saving..." : integration.hasCredentials ? "Update" : "Save"}
                </Button>
                {editingCredential && (
                  <Button variant="outline" onClick={handleCancelEdit} data-testid="button-cancel-sendgrid">
                    Cancel
                  </Button>
                )}
              </div>
            </div>
            {!integration.hasCredentials && (
              <div className="pt-3 border-t">
                <Button variant="outline" size="sm" onClick={() => navigate('/sendgrid-setup')} data-testid="button-sendgrid-setup-guide-empty">
                  <BookOpen className="h-3 w-3 mr-1" />
                  Setup Guide
                </Button>
              </div>
            )}
          </div>
        ) : (
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription className="text-sm">Contact your administrator to configure SendGrid credentials.</AlertDescription>
          </Alert>
        )
      )}
    </IntegrationCardShell>
  );
}
