import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Phone, MessageSquare, RefreshCw, AlertTriangle, Power, XCircle, CheckCircle2 } from "lucide-react";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useProviderConfig } from "@/hooks/use-provider-config";
import { useIntegrationCard, getStatusIcon, getStatusText } from "@/hooks/use-integration-card";
import { IntegrationCardShell } from "./IntegrationCardShell";

interface TwilioNumber {
  id: string;
  phoneNumber: string;
  friendlyName?: string | null;
}

interface TwilioSettings {
  defaultTwilioNumber: string | null;
  twilioRecordCalls: boolean;
  twilioInboundCallMode: "crm" | "external";
}

interface InboundRoutingStatus {
  ok: boolean;
  numbers: Array<{
    phoneNumber: string;
    sid: string;
    smsUrlConfigured: boolean;
    messagingServiceSid?: string;
  }>;
  messagingServices: Array<{
    sid: string;
    friendlyName?: string;
    routedToUs: boolean;
    mode: "direct" | "deferral" | "none";
  }>;
  warnings: string[];
}

export function TwilioCard() {
  const { toast } = useToast();
  const { integration, isLoading, isError, isAdmin, toggleEnabled, isTogglingEnabled } =
    useIntegrationCard("twilio");
  const { data: providerData } = useProviderConfig();
  const [accountSid, setAccountSid] = useState("");
  const [authToken, setAuthToken] = useState("");
  const [editingCredential, setEditingCredential] = useState(false);

  const isEnabled = integration?.isEnabled ?? false;
  const hasCredentials = integration?.hasCredentials ?? false;

  const { data: numbersData } = useQuery<{ numbers: TwilioNumber[] }>({
    queryKey: ["/api/twilio/numbers"],
    enabled: hasCredentials && isEnabled,
  });
  const numbers = numbersData?.numbers ?? [];

  const { data: settings } = useQuery<TwilioSettings>({
    queryKey: ["/api/twilio/settings"],
    enabled: hasCredentials && isEnabled && isAdmin,
  });

  const { data: inboundRouting, isFetching: isCheckingRouting } = useQuery<InboundRoutingStatus>({
    queryKey: ["/api/twilio/inbound-routing"],
    enabled: hasCredentials && isEnabled && isAdmin,
  });

  const saveCredentialsMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/integrations/twilio/credentials", {
        credentials: { account_sid: accountSid.trim(), auth_token: authToken.trim() },
      });
      return response.json();
    },
    onSuccess: () => {
      toast({ title: "Credentials Saved", description: "Twilio credentials have been saved successfully." });
      setAccountSid("");
      setAuthToken("");
      setEditingCredential(false);
      queryClient.invalidateQueries({ queryKey: ["/api/integrations"] });
    },
    onError: (error: any) => {
      toast({ title: "Error", description: error.message || "Failed to save credentials", variant: "destructive" });
    },
  });

  const setProviderMutation = useMutation({
    mutationFn: async ({ providerType }: { providerType: "sms" | "calling" }) => {
      const response = await apiRequest("POST", "/api/providers", { providerType, providerName: "twilio" });
      return response.json();
    },
    onSuccess: (_, { providerType }) => {
      toast({ title: "Provider Set", description: `Twilio has been set as your ${providerType} provider.` });
      queryClient.invalidateQueries({ queryKey: ["/api/providers"] });
    },
    onError: (error: any) => {
      toast({ title: "Error", description: error.message || "Failed to set provider", variant: "destructive" });
    },
  });

  const syncMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/twilio/sync");
      return response.json();
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/twilio/numbers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/integrations"] });
      queryClient.invalidateQueries({ queryKey: ["/api/twilio/inbound-routing"] });
      const inboundOk = data?.inboundRouting?.ok;
      toast({
        title: "Twilio sync completed",
        description:
          inboundOk === false
            ? `Synced ${data.synced ?? 0} numbers, but inbound texts may not be wired up — see the status below.`
            : `Synced ${data.synced ?? 0} numbers, configured ${data.configured ?? 0} webhooks.`,
        variant: inboundOk === false ? "destructive" : undefined,
      });
    },
    onError: (error: any) => {
      toast({ title: "Twilio sync failed", description: error.message || "Failed to sync with Twilio.", variant: "destructive" });
    },
  });

  const settingsMutation = useMutation({
    mutationFn: async (updates: Partial<TwilioSettings>) => {
      const response = await apiRequest("PATCH", "/api/twilio/settings", updates);
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/twilio/settings"] });
    },
    onError: (error: any) => {
      toast({ title: "Error", description: error.message || "Failed to update settings", variant: "destructive" });
    },
  });

  const handleSaveCredentials = () => {
    if (!accountSid.trim() || !authToken.trim()) return;
    saveCredentialsMutation.mutate();
  };

  if (isLoading) {
    return (
      <IntegrationCardShell
        icon={<Phone className="h-5 w-5" />}
        title="Twilio"
        description="SMS and calling services for customer communication"
        statusIcon={<></>}
        isLoading={true}
      >
        <></>
      </IntegrationCardShell>
    );
  }

  const renderCredentialForm = (update: boolean) => (
    <div className="space-y-3">
      <Label htmlFor="twilio-account-sid" className="text-sm font-medium">Account SID</Label>
      <Input
        id="twilio-account-sid"
        type="text"
        placeholder="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
        value={accountSid}
        onChange={(e) => setAccountSid(e.target.value)}
        className="w-full"
        data-testid="input-twilio-account-sid"
      />
      <Label htmlFor="twilio-auth-token" className="text-sm font-medium">Auth Token</Label>
      <div className="flex flex-col sm:flex-row gap-2">
        <Input
          id="twilio-auth-token"
          type="password"
          placeholder={update ? "Enter new auth token..." : "Enter your auth token..."}
          value={authToken}
          onChange={(e) => setAuthToken(e.target.value)}
          className="w-full"
          data-testid="input-twilio-auth-token"
        />
        <div className="flex gap-2 shrink-0">
          <Button
            onClick={handleSaveCredentials}
            disabled={saveCredentialsMutation.isPending || !accountSid.trim() || !authToken.trim()}
            data-testid="button-save-twilio"
          >
            {saveCredentialsMutation.isPending ? "Saving..." : update ? "Update" : "Save"}
          </Button>
          {editingCredential && (
            <Button variant="outline" onClick={() => { setEditingCredential(false); setAccountSid(""); setAuthToken(""); }} data-testid="button-cancel-twilio">
              Cancel
            </Button>
          )}
        </div>
      </div>
    </div>
  );

  if (!integration) {
    return (
      <IntegrationCardShell
        icon={<Phone className="h-5 w-5" />}
        title="Twilio"
        description="SMS and calling services for customer communication"
        statusIcon={<XCircle className="h-5 w-5 text-destructive" />}
        isLoading={false}
      >
        {isError ? (
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription className="text-sm flex items-center justify-between gap-2 flex-wrap">
              <span>Could not load Twilio configuration.</span>
              <Button variant="outline" size="sm" onClick={() => queryClient.invalidateQueries({ queryKey: ["/api/integrations"] })}>
                <RefreshCw className="h-3 w-3 mr-1" />
                Retry
              </Button>
            </AlertDescription>
          </Alert>
        ) : (
          <>
            <Badge variant="destructive">Not Configured</Badge>
            {isAdmin ? renderCredentialForm(false) : (
              <Alert>
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription className="text-sm">Contact your administrator to configure Twilio credentials.</AlertDescription>
              </Alert>
            )}
          </>
        )}
      </IntegrationCardShell>
    );
  }

  const status = getStatusText(integration);

  return (
    <IntegrationCardShell
      icon={<Phone className="h-5 w-5" />}
      title="Twilio"
      description="SMS and calling services for customer communication"
      statusIcon={getStatusIcon(integration)}
      isLoading={false}
    >
      <Badge variant={status.variant}>{status.text}</Badge>

      {hasCredentials && (
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Power className="h-4 w-4 text-muted-foreground" />
            <Label htmlFor="twilio-enabled" className="text-sm font-medium cursor-pointer">Enabled</Label>
          </div>
          <Switch
            id="twilio-enabled"
            checked={integration.isEnabled}
            onCheckedChange={() => toggleEnabled(integration.isEnabled)}
            disabled={isTogglingEnabled}
            data-testid="switch-twilio"
          />
        </div>
      )}

      {hasCredentials && isEnabled && (
        <div className="pt-3 border-t space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="twilio-sms-service"
                checked={providerData?.configured?.find(p => p.providerType === "sms" && p.isActive && p.smsProvider === "twilio") !== undefined}
                onChange={(e) => { if (e.target.checked) setProviderMutation.mutate({ providerType: "sms" }); }}
                disabled={setProviderMutation.isPending}
                className="rounded border-gray-300"
                data-testid="checkbox-twilio-sms"
              />
              <Label htmlFor="twilio-sms-service" className="text-sm cursor-pointer">Enable SMS Service</Label>
            </div>
            <MessageSquare className="h-4 w-4 text-muted-foreground" />
          </div>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="twilio-calling-service"
                checked={providerData?.configured?.find(p => p.providerType === "calling" && p.isActive && p.callingProvider === "twilio") !== undefined}
                onChange={(e) => { if (e.target.checked) setProviderMutation.mutate({ providerType: "calling" }); }}
                disabled={setProviderMutation.isPending}
                className="rounded border-gray-300"
                data-testid="checkbox-twilio-calling"
              />
              <Label htmlFor="twilio-calling-service" className="text-sm cursor-pointer">Enable Calling Service</Label>
            </div>
            <Phone className="h-4 w-4 text-muted-foreground" />
          </div>

          <Button variant="outline" size="sm" onClick={() => syncMutation.mutate()} disabled={syncMutation.isPending} data-testid="button-twilio-sync">
            <RefreshCw className={`h-4 w-4 mr-2 ${syncMutation.isPending ? "animate-spin" : ""}`} />
            {syncMutation.isPending ? "Syncing..." : "Sync Numbers & Webhooks"}
          </Button>

          {isAdmin && (
            <div className="space-y-2" data-testid="twilio-inbound-routing">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">Incoming text routing</span>
                {isCheckingRouting && <RefreshCw className="h-3 w-3 animate-spin text-muted-foreground" />}
              </div>

              {inboundRouting?.ok && (
                <Alert>
                  <CheckCircle2 className="h-4 w-4 text-green-600" />
                  <AlertDescription className="text-sm">
                    Incoming texts are wired up to reach the CRM.
                  </AlertDescription>
                </Alert>
              )}

              {inboundRouting && !inboundRouting.ok && (
                <Alert variant="destructive">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription className="text-sm space-y-1">
                    <p className="font-medium">Incoming texts may not reach the CRM.</p>
                    {inboundRouting.warnings.length > 0 ? (
                      <ul className="list-disc pl-4 space-y-0.5">
                        {inboundRouting.warnings.map((w, i) => (
                          <li key={i}>{w}</li>
                        ))}
                      </ul>
                    ) : (
                      <p>Click "Sync Numbers &amp; Webhooks" to set up incoming text routing.</p>
                    )}
                  </AlertDescription>
                </Alert>
              )}

              {inboundRouting && inboundRouting.messagingServices.length > 0 && (
                <div className="text-xs text-muted-foreground space-y-0.5">
                  {inboundRouting.messagingServices.map((svc) => (
                    <div key={svc.sid} className="flex items-center justify-between gap-2">
                      <span className="truncate">{svc.friendlyName || svc.sid}</span>
                      <Badge variant={svc.routedToUs ? "secondary" : "destructive"} className="shrink-0">
                        {svc.routedToUs ? "Routed to CRM" : "Not routed"}
                      </Badge>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {hasCredentials && isEnabled && isAdmin && (
        <div className="pt-3 border-t space-y-3">
          <div className="space-y-2">
            <Label className="text-sm font-medium">Default Number</Label>
            <Select
              value={settings?.defaultTwilioNumber ?? ""}
              onValueChange={(value) => settingsMutation.mutate({ defaultTwilioNumber: value })}
            >
              <SelectTrigger data-testid="select-twilio-default-number">
                <SelectValue placeholder="Select a number" />
              </SelectTrigger>
              <SelectContent>
                {numbers.map((n) => (
                  <SelectItem key={n.id} value={n.phoneNumber}>
                    {n.friendlyName ? `${n.friendlyName} (${n.phoneNumber})` : n.phoneNumber}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label className="text-sm font-medium">Incoming call handling</Label>
            <Select
              value={settings?.twilioInboundCallMode ?? "crm"}
              onValueChange={(value) =>
                settingsMutation.mutate({ twilioInboundCallMode: value as "crm" | "external" })
              }
              disabled={settingsMutation.isPending}
            >
              <SelectTrigger data-testid="select-twilio-inbound-call-mode">
                <SelectValue placeholder="Select how incoming calls are handled" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="crm">CRM answers calls (ring a rep, voicemail fallback)</SelectItem>
                <SelectItem value="external">Keep my Twilio setup (Studio Flow/IVR)</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {(settings?.twilioInboundCallMode ?? "crm") === "external"
                ? 'With "Keep my Twilio setup", Sync will not touch call routing — your Studio Flow or IVR keeps answering. The CRM still logs incoming calls and handles texts. CRM voicemail and call recording are not used; recordings only appear if your Flow records.'
                : "The CRM answers incoming calls by ringing a rep, with a voicemail fallback. Sync sets call routing on your numbers."}
            </p>
          </div>

          <div className="flex items-center justify-between gap-2">
            <div className="flex flex-col">
              <Label htmlFor="twilio-record-calls" className="text-sm font-medium cursor-pointer">Record Calls</Label>
              <span className="text-xs text-muted-foreground">
                Off by default. When on, a consent notice is played to both parties.
              </span>
            </div>
            <Switch
              id="twilio-record-calls"
              checked={settings?.twilioRecordCalls ?? false}
              onCheckedChange={(checked) => settingsMutation.mutate({ twilioRecordCalls: checked })}
              disabled={settingsMutation.isPending}
              data-testid="switch-twilio-record-calls"
            />
          </div>
        </div>
      )}

      {hasCredentials && isAdmin && !editingCredential && (
        <div className="pt-3 border-t flex gap-2 flex-wrap">
          <Button variant="outline" size="sm" onClick={() => setEditingCredential(true)} data-testid="button-update-twilio-credentials">
            Update Credentials
          </Button>
        </div>
      )}

      {(!hasCredentials || editingCredential) && (
        isAdmin ? renderCredentialForm(hasCredentials) : (
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription className="text-sm">Contact your administrator to configure Twilio credentials.</AlertDescription>
          </Alert>
        )
      )}
    </IntegrationCardShell>
  );
}
