import { Button } from "@/components/ui/button";
import { Phone } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useProviderStatus } from "@/hooks/use-provider-config";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useEffect, useRef, useState } from "react";
import { CallingModal } from "./CallingModal";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { dialPhone } from "@/lib/dialPhone";
import { parseCallError } from "@/lib/parseCallError";

interface CallButtonProps {
  recipientName: string;
  recipientPhone: string;
  fromNumber?: string;
  variant?: "default" | "outline" | "ghost" | "destructive" | "secondary";
  size?: "default" | "sm" | "lg" | "icon";
  className?: string;
  children?: React.ReactNode;
  customerId?: string;
  leadId?: string;
  estimateId?: string;
  onCallCompleted?: () => void;
  /**
   * Hook fired the moment the user clicks the Call button, before any dialing
   * side effects (modal open, Dialpad initiate, tel: handoff). Used by the
   * Follow-Ups task row to reveal an inline call talk-track panel as soon as
   * the rep starts the call. Task #729.
   */
  onClickBeforeCall?: () => void;
}

export function CallButton({ 
  recipientName, 
  recipientPhone,
  fromNumber,
  variant = "outline",
  size = "default",
  className = "",
  children,
  customerId,
  leadId,
  estimateId: _estimateId,
  onCallCompleted,
  onClickBeforeCall,
}: CallButtonProps) {
  const { toast } = useToast();
  const { calling } = useProviderStatus();
  const { data: currentUser } = useCurrentUser();
  const queryClient = useQueryClient();
  const [isInitiating, setIsInitiating] = useState(false);
  const [showCallingModal, setShowCallingModal] = useState(false);
  const [cooldownRemaining, setCooldownRemaining] = useState(0);
  const cooldownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearCooldown = () => {
    if (cooldownTimerRef.current) {
      clearInterval(cooldownTimerRef.current);
      cooldownTimerRef.current = null;
    }
  };

  const startCooldown = (seconds: number) => {
    clearCooldown();
    if (seconds <= 0) {
      setCooldownRemaining(0);
      return;
    }
    setCooldownRemaining(seconds);
    cooldownTimerRef.current = setInterval(() => {
      setCooldownRemaining((prev) => {
        if (prev <= 1) {
          clearCooldown();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  };

  useEffect(() => () => clearCooldown(), []);

  const initiateCallMutation = useMutation({
    mutationFn: async (data: { toNumber: string; fromNumber?: string; customerId?: string; leadId?: string }) => {
      const response = await apiRequest('POST', '/api/calls/initiate', data);
      return response.json();
    },
    onSuccess: (data: { success: boolean; callId?: string; callUrl?: string }) => {
      setIsInitiating(false);
      toast({
        title: "Call initiated",
        description: data.callUrl 
          ? "Your Dialpad app will open shortly" 
          : `Calling ${recipientName}...`,
      });
      
      queryClient.invalidateQueries({ queryKey: ['/api/activities'] });
      queryClient.invalidateQueries({ queryKey: ['/api/contacts/paginated'] });
      
      if (data.callUrl) {
        window.open(data.callUrl, '_blank');
      }
      onCallCompleted?.();
    },
    onError: (error: unknown) => {
      setIsInitiating(false);
      const parsed = parseCallError(error);
      toast({
        title: "Call failed",
        description: parsed.userMessage,
        variant: "destructive",
      });
      startCooldown(parsed.retryAfterSeconds);
    },
  });

  const handleCall = async () => {
    onClickBeforeCall?.();
    if (!recipientPhone) {
      toast({
        title: "No phone number",
        description: "This contact doesn't have a phone number",
        variant: "destructive",
      });
      return;
    }

    const cleanPhoneNumber = recipientPhone.replace(/[^\d+]/g, '');
    const usePersonal = currentUser?.user?.callPreference === 'personal';

    if (usePersonal) {
      dialPhone({ contactId: customerId || leadId, phone: cleanPhoneNumber, name: recipientName });
      queryClient.invalidateQueries({ queryKey: ['/api/activities'] });
      queryClient.invalidateQueries({ queryKey: ['/api/contacts/paginated'] });
      onCallCompleted?.();
      return;
    }

    // Otherwise use the calling integration if configured
    if (calling.isConfigured) {
      if (fromNumber) {
        setIsInitiating(true);
        initiateCallMutation.mutate({
          toNumber: cleanPhoneNumber,
          fromNumber,
          customerId,
          leadId,
        });
      } else {
        setShowCallingModal(true);
      }
    } else {
      dialPhone({ contactId: customerId || leadId, phone: cleanPhoneNumber, name: recipientName });
      queryClient.invalidateQueries({ queryKey: ['/api/activities'] });
      queryClient.invalidateQueries({ queryKey: ['/api/contacts/paginated'] });
      onCallCompleted?.();
    }
  };

  return (
    <>
      <Button
        onClick={handleCall}
        disabled={!recipientPhone || isInitiating || initiateCallMutation.isPending || cooldownRemaining > 0}
        variant={variant}
        size={size}
        className={className}
        data-testid={`button-call-${recipientPhone}`}
      >
        <Phone className={`${size === 'icon' ? 'h-4 w-4' : 'h-4 w-4 mr-2'}`} />
        {children || (size !== 'icon' && (
          isInitiating || initiateCallMutation.isPending
            ? 'Calling...'
            : cooldownRemaining > 0
              ? `Try again in ${cooldownRemaining}s`
              : 'Call'
        ))}
      </Button>

      <CallingModal
        open={showCallingModal}
        onOpenChange={setShowCallingModal}
        recipientName={recipientName}
        recipientPhone={recipientPhone}
        customerId={customerId}
        leadId={leadId}
        onCallCompleted={onCallCompleted}
      />
    </>
  );
}
