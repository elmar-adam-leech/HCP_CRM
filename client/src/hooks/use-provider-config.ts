import { useQuery } from "@tanstack/react-query";

export interface ProviderConfig {
  available: {
    email: string[];
    sms: string[];
    calling: string[];
  };
  configured: Array<{
    contractorId: string;
    providerType: 'email' | 'sms' | 'calling';
    emailProvider?: string;
    smsProvider?: string;
    callingProvider?: string;
    isActive: boolean;
  }>;
}

export function useProviderConfig() {
  return useQuery<ProviderConfig>({
    queryKey: ['/api/providers'],
    queryFn: async () => {
      const response = await fetch('/api/providers');
      if (!response.ok) {
        throw new Error('Failed to fetch provider configuration');
      }
      return response.json();
    },
  });
}

export function useProviderStatus() {
  const { data: config, isLoading, isError } = useProviderConfig();

  const getProviderStatus = (type: 'email' | 'sms' | 'calling') => {
    if (isLoading) {
      return { isConfigured: false, isLoading: true };
    }
    if (isError || !config) {
      return { isConfigured: false, isLoading: false };
    }

    const configured = config.configured.find(p => p.providerType === type);
    let hasProvider = false;

    if (configured) {
      switch (type) {
        case 'email':
          hasProvider = !!configured.emailProvider;
          break;
        case 'sms':
          hasProvider = !!configured.smsProvider;
          break;
        case 'calling':
          hasProvider = !!configured.callingProvider;
          break;
      }
    }

    return {
      isConfigured: hasProvider,
      isLoading: false,
      availableProviders: config.available[type] || [],
    };
  };

  return {
    email: getProviderStatus('email'),
    sms: getProviderStatus('sms'),
    calling: getProviderStatus('calling'),
    isLoading,
  };
}