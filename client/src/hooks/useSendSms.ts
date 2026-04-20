import { useMutation } from '@tanstack/react-query';
import { queryClient, apiRequest } from '@/lib/queryClient';
import { useToast } from '@/hooks/use-toast';

export interface SendSmsOptions {
  content: string;
  toNumber: string;
  fromNumber?: string;
  contactId?: string;
  leadId?: string; // Legacy - prefer contactId
  customerId?: string; // Legacy - prefer contactId
  estimateId?: string;
}

export interface SendSmsResult {
  success: boolean;
  message?: any;
  messageId?: string;
  error?: string;
}

/**
 * Custom hook for sending SMS messages throughout the application
 * Provides consistent error handling, loading states, and cache invalidation
 */
export function useSendSms() {
  const { toast } = useToast();

  const mutation = useMutation({
    mutationFn: async (options: SendSmsOptions): Promise<SendSmsResult> => {
      const payload = {
        type: 'text',
        content: options.content,
        toNumber: options.toNumber,
        fromNumber: options.fromNumber,
        contactId: options.contactId,
        leadId: options.leadId,
        customerId: options.customerId,
        estimateId: options.estimateId,
      };

      const response = await apiRequest('POST', '/api/messages/send-text', payload);
      const data = await response.json() as SendSmsResult;
      return data;
    },
    onSuccess: (data: SendSmsResult, variables: SendSmsOptions) => {
      if (data.success) {
        toast({
          title: "Text sent successfully",
          description: `Message sent to ${variables.toNumber}`,
        });
        
        // Invalidate relevant queries to refresh conversation views
        queryClient.invalidateQueries({ queryKey: ['/api/messages'] });
        queryClient.invalidateQueries({ queryKey: ['/api/conversations'] });
        queryClient.invalidateQueries({ queryKey: ['/api/contacts/paginated'] });
        
        // Invalidate specific conversation if we have contact/lead/customer ID
        const contactIdToInvalidate = variables.contactId || variables.leadId || variables.customerId;
        if (contactIdToInvalidate) {
          queryClient.invalidateQueries({ 
            queryKey: ['/api/conversations', contactIdToInvalidate] 
          });
        }
      } else {
        toast({
          title: "Failed to send text",
          description: data.error || "An error occurred",
          variant: "destructive",
        });
      }
    },
    onError: (error: any) => {
      const errorMessage = error?.response?.data?.error?.message || 
                          error.message || 
                          "An error occurred while sending the text";
      toast({
        title: "Failed to send text",
        description: errorMessage,
        variant: "destructive",
      });
    },
  });

  return {
    sendSms: mutation.mutate,
    sendSmsAsync: mutation.mutateAsync,
    isLoading: mutation.isPending,
    error: mutation.error,
    data: mutation.data,
    reset: mutation.reset,
  };
}

/**
 * Utility function for formatting phone numbers for Dialpad
 */
export function formatForDialpad(phoneNumber: string): string {
  if (!phoneNumber) return '';
  
  const digits = phoneNumber.replace(/\D/g, '');
  
  if (digits.length === 10) {
    return `+1${digits}`;
  }
  
  if (digits.length === 11 && digits.startsWith('1')) {
    return `+${digits}`;
  }
  
  if (phoneNumber.startsWith('+')) {
    return phoneNumber;
  }
  
  return phoneNumber;
}