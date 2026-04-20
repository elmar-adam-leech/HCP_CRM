import { useState, useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useDialpadPhoneNumbers } from '@/hooks/useDialpadPhoneNumbers';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { useToast } from '@/hooks/use-toast';
import { apiRequest } from '@/lib/queryClient';
import { CheckCircle } from 'lucide-react';
import { CredentialsStep } from './dialpad/CredentialsStep';
import { PhoneNumberSyncStep } from './dialpad/PhoneNumberSyncStep';
import { FinalSetupStep } from './dialpad/FinalSetupStep';
import type { DialpadPhoneNumber, DialpadUser } from './dialpad/types';

interface EnhancedDialpadConfigProps {
  onComplete?: () => void;
}

export default function EnhancedDialpadConfig({ onComplete }: EnhancedDialpadConfigProps) {
  const [currentStep, setCurrentStep] = useState(1);
  const [apiKey, setApiKey] = useState('');
  const [userId, setUserId] = useState('');
  const [phoneNumberDepartments, setPhoneNumberDepartments] = useState<Record<string, string>>({});
  const [isLoadingState, setIsLoadingState] = useState(true);

  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: integrationStatus } = useQuery({
    queryKey: ['/api/integrations/dialpad/status']
  });
  const typedIntegrationStatus = integrationStatus as { hasCredentials: boolean; isEnabled: boolean } | undefined;

  const { data: phoneNumbersRaw = [], isLoading: phoneNumbersLoading, refetch: refetchPhoneNumbers } = useDialpadPhoneNumbers();
  const typedPhoneNumbers = phoneNumbersRaw as DialpadPhoneNumber[];

  const { data: dialpadUsers = [] } = useQuery({
    queryKey: ['/api/dialpad/users']
  });
  const typedDialpadUsers = dialpadUsers as DialpadUser[];

  const { data: existingCredentials } = useQuery({
    queryKey: ['/api/integrations/dialpad/credentials'],
    enabled: !!typedIntegrationStatus?.hasCredentials
  });

  useEffect(() => {
    if (!typedIntegrationStatus || phoneNumbersLoading) return;
    const { hasCredentials, isEnabled } = typedIntegrationStatus;
    const hasPhoneNumbers = typedPhoneNumbers.length > 0;
    if (isEnabled || (hasPhoneNumbers && hasCredentials)) {
      setCurrentStep(3);
    } else if (hasCredentials) {
      setCurrentStep(2);
    } else {
      setCurrentStep(1);
    }
    setIsLoadingState(false);
  }, [typedIntegrationStatus, typedPhoneNumbers.length, phoneNumbersLoading]);

  useEffect(() => {
    if (existingCredentials) {
      const response = existingCredentials as { credentials?: { user_id?: string } };
      if (response.credentials?.user_id) {
        setUserId(response.credentials.user_id);
      }
    }
  }, [existingCredentials]);

  const saveCrendentialsMutation = useMutation({
    mutationFn: async ({ apiKey, userId }: { apiKey: string; userId: string }) => {
      const response = await apiRequest('POST', '/api/integrations/dialpad/credentials', {
        credentials: { api_key: apiKey, user_id: userId }
      });
      return response.json();
    },
    onSuccess: () => {
      toast({ title: "Credentials Saved", description: "Dialpad API key and User ID have been saved successfully." });
      setCurrentStep(2);
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to save credentials. Please check your inputs and try again.", variant: "destructive" });
    }
  });

  const syncPhoneNumbersMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest('POST', '/api/dialpad/sync-phone-numbers');
      return response.json();
    },
    onSuccess: (data) => {
      toast({ title: "Phone Numbers Synced", description: `Successfully synced ${data.synced} phone numbers from Dialpad.` });
      refetchPhoneNumbers();
      setCurrentStep(3);
    },
    onError: () => {
      toast({ title: "Sync Failed", description: "Failed to sync phone numbers. Please try again.", variant: "destructive" });
    }
  });

  const updatePhoneNumberMutation = useMutation({
    mutationFn: async ({ id, displayName, department }: { id: string; displayName?: string; department?: string }) => {
      const response = await apiRequest('PUT', `/api/dialpad/phone-numbers/${id}`, { displayName, department });
      return response.json();
    },
    onSuccess: () => { refetchPhoneNumbers(); }
  });

  const enableIntegrationMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest('POST', '/api/integrations/dialpad/enable');
      return response.json();
    },
    onSuccess: (data) => {
      if (data.webhookCreated) {
        toast({ title: "Dialpad Enabled", description: "Dialpad integration and SMS webhook have been configured successfully." });
      } else if (data.webhookError) {
        toast({
          title: "Dialpad Enabled (Webhook Failed)",
          description: `Integration enabled, but webhook creation failed: ${data.webhookError}. You can create it manually from the Complete Setup step.`,
          variant: "destructive"
        });
      } else {
        toast({ title: "Dialpad Enabled", description: "Dialpad integration has been enabled successfully." });
      }
      queryClient.invalidateQueries({ queryKey: ['/api/integrations'] });
      queryClient.invalidateQueries({ queryKey: ['/api/dialpad/webhooks/list'] });
      onComplete?.();
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to enable Dialpad integration.", variant: "destructive" });
    }
  });

  const handleApiKeySubmit = () => {
    if (!apiKey.trim() && !userId.trim()) {
      toast({ title: "Credentials Required", description: "Please enter at least API Key or User ID to update.", variant: "destructive" });
      return;
    }
    saveCrendentialsMutation.mutate({ apiKey: apiKey.trim(), userId: userId.trim() });
  };

  const handlePhoneNumberUpdate = (phoneNumberId: string, field: 'displayName' | 'department', value: string) => {
    if (field === 'department') {
      setPhoneNumberDepartments(prev => ({ ...prev, [phoneNumberId]: value }));
    }
    const phoneNumber = typedPhoneNumbers.find((pn) => pn.id === phoneNumberId);
    if (phoneNumber) {
      updatePhoneNumberMutation.mutate({
        id: phoneNumberId,
        displayName: field === 'displayName' ? value : phoneNumber.displayName,
        department: field === 'department' ? value : phoneNumber.department
      });
    }
  };

  const departments = Array.from(
    new Set(typedDialpadUsers.map((user) => user.department).filter(Boolean))
  ) as string[];

  const isEnabled = !!typedIntegrationStatus?.isEnabled;

  if (isLoadingState) {
    return (
      <div className="space-y-6">
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold">Loading Dialpad Configuration...</h3>
          </div>
          <div className="text-center py-8">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto"></div>
            <p className="text-sm text-muted-foreground mt-2">Checking existing configuration...</p>
          </div>
        </div>
      </div>
    );
  }

  const stepTitles = ['API Configuration', 'Phone Numbers', isEnabled ? 'Management' : 'Complete Setup'];

  const renderStep = () => {
    switch (currentStep) {
      case 1:
        return (
          <CredentialsStep
            apiKey={apiKey}
            userId={userId}
            onApiKeyChange={setApiKey}
            onUserIdChange={setUserId}
            onSubmit={handleApiKeySubmit}
            saveMutation={saveCrendentialsMutation}
          />
        );
      case 2:
        return (
          <PhoneNumberSyncStep
            phoneNumbers={typedPhoneNumbers}
            phoneNumbersLoading={phoneNumbersLoading}
            phoneNumberDepartments={phoneNumberDepartments}
            departments={departments}
            syncMutation={syncPhoneNumbersMutation}
            onPhoneNumberUpdate={handlePhoneNumberUpdate}
            onContinue={() => setCurrentStep(3)}
          />
        );
      case 3:
        return (
          <FinalSetupStep
            phoneNumbers={typedPhoneNumbers}
            isEnabled={isEnabled}
            enableMutation={enableIntegrationMutation}
          />
        );
      default:
        return null;
    }
  };

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-1">
          <h3 className="text-lg font-semibold">Enhanced Dialpad Setup</h3>
          <Badge variant="outline">Step {currentStep} of 3</Badge>
        </div>

        <div className="space-y-2">
          <div className="flex justify-between text-sm">
            <span>{isEnabled ? 'Configuration Status' : 'Setup Progress'}</span>
            <span>{isEnabled ? 'Active' : `${Math.round((currentStep / 3) * 100)}%`}</span>
          </div>
          <Progress value={isEnabled ? 100 : (currentStep / 3) * 100} className="h-2" />
        </div>

        <div className="flex items-center gap-4 text-sm flex-wrap">
          {stepTitles.map((title, index) => (
            <div
              key={index}
              className={`flex items-center gap-2 ${
                index + 1 === currentStep ? 'text-primary font-medium' : 'text-muted-foreground'
              }`}
            >
              <div
                className={`w-6 h-6 rounded-full flex items-center justify-center text-xs ${
                  index + 1 === currentStep
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted'
                }`}
              >
                {index + 1 < currentStep ? <CheckCircle className="h-3 w-3" /> : index + 1}
              </div>
              <span className="hidden sm:inline">{title}</span>
            </div>
          ))}
        </div>
      </div>

      {renderStep()}
    </div>
  );
}
