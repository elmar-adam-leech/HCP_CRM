import { useMutation, useQuery } from "@tanstack/react-query";
import { CheckCircle, XCircle, AlertTriangle, Settings as SettingsIcon, Mail, Phone, Calendar } from "lucide-react";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useCurrentUser } from "@/hooks/useCurrentUser";

interface IntegrationData {
  name: string;
  hasCredentials: boolean;
  isEnabled: boolean;
}

export interface Integration {
  name: string;
  displayName: string;
  description: string;
  icon: any;
  type: 'communication' | 'business' | 'other';
  hasCredentials: boolean;
  isEnabled: boolean;
  setupInstructions?: { title: string; steps: string[] };
}

export function getIntegrationConfig(data: IntegrationData): Integration {
  const base: Integration = {
    name: data.name,
    displayName: data.name,
    description: 'Third-party service integration',
    hasCredentials: data.hasCredentials,
    isEnabled: data.isEnabled,
    type: 'other',
    icon: SettingsIcon,
  };
  switch (data.name) {
    case 'dialpad':
      return { ...base, displayName: 'Dialpad', description: 'SMS and calling services for customer communication', icon: Phone, type: 'communication' };
    case 'twilio':
      return { ...base, displayName: 'Twilio', description: 'SMS and calling services for customer communication', icon: Phone, type: 'communication' };
    case 'gmail':
      return { ...base, displayName: 'Gmail', description: 'Email services for customer communication via Gmail API', icon: Mail, type: 'communication' };
    case 'sendgrid':
      return { ...base, displayName: 'SendGrid', description: 'Email services for customer communication via SendGrid', icon: Mail, type: 'communication' };
    case 'housecall-pro':
      return {
        ...base,
        displayName: 'Housecall Pro',
        description: 'Business management and scheduling integration',
        icon: Calendar,
        type: 'business',
        setupInstructions: {
          title: 'Set up Housecall Pro Integration',
          steps: [
            'Log in to your Housecall Pro account',
            'Go to App Store → API Key Management',
            'Generate a new API key',
            'Contact your admin to add the API key to this CRM',
          ],
        },
      };
    default:
      return base;
  }
}

export function getStatusIcon(integration: Integration) {
  if (!integration.hasCredentials) return <XCircle className="h-5 w-5 text-destructive" />;
  if (integration.isEnabled) return <CheckCircle className="h-5 w-5 text-green-600" />;
  return <AlertTriangle className="h-5 w-5 text-yellow-600" />;
}

export function getStatusText(integration: Integration): { text: string; variant: 'default' | 'secondary' | 'destructive' } {
  if (!integration.hasCredentials) return { text: 'Not Configured', variant: 'destructive' };
  if (integration.isEnabled) return { text: 'Connected', variant: 'default' };
  return { text: 'Disabled', variant: 'secondary' };
}

export function useIntegrationCard(name: string) {
  const { toast } = useToast();
  const { data: currentUserData, isLoading: userLoading } = useCurrentUser();
  const isAdmin = currentUserData?.user?.role === 'admin' || currentUserData?.user?.role === 'super_admin' || currentUserData?.user?.role === 'manager';

  const { data: integrationsResponse, isLoading: integrationsLoading, isError: integrationsError } = useQuery<{ integrations: IntegrationData[] }>({
    queryKey: ['/api/integrations'],
  });

  const rawData = integrationsResponse?.integrations?.find(i => i.name === name) ?? null;
  const integration = rawData ? getIntegrationConfig(rawData) : null;

  const enableMutation = useMutation({
    mutationFn: async (enable: boolean) => {
      const response = await apiRequest('POST', `/api/integrations/${name}/${enable ? 'enable' : 'disable'}`);
      return response.json();
    },
    onSuccess: (_, enable) => {
      toast({ title: "Integration Updated", description: `${integration?.displayName ?? name} has been ${enable ? 'enabled' : 'disabled'} successfully.` });
      queryClient.invalidateQueries({ queryKey: ['/api/integrations'] });
    },
    onError: (error: any) => { toast({ title: "Error", description: error.message, variant: "destructive" }); },
  });

  const saveCredentialsMutation = useMutation({
    mutationFn: async (apiKey: string) => {
      const response = await apiRequest('POST', `/api/integrations/${name}/credentials`, { credentials: { api_key: apiKey } });
      return response.json();
    },
    onSuccess: () => {
      toast({ title: "Credentials Saved", description: `${integration?.displayName ?? name} credentials have been saved successfully.` });
      queryClient.invalidateQueries({ queryKey: ['/api/integrations'] });
    },
    onError: (error: any) => { toast({ title: "Error", description: error.message, variant: "destructive" }); },
  });

  return {
    integration,
    isLoading: integrationsLoading || userLoading,
    isError: integrationsError,
    isAdmin,
    toggleEnabled: (currentEnabled: boolean) => enableMutation.mutate(!currentEnabled),
    isTogglingEnabled: enableMutation.isPending,
    saveCredentials: (apiKey: string) => saveCredentialsMutation.mutate(apiKey),
    isSavingCredentials: saveCredentialsMutation.isPending,
  };
}
