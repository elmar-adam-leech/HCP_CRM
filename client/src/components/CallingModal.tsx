import { useState, useEffect, useRef } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Phone } from "lucide-react";
import { PhoneNumberSelector } from "./PhoneNumberSelector";
import { useToast } from "@/hooks/use-toast";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { parseCallError } from "@/lib/parseCallError";

interface CallingModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  recipientName: string;
  recipientPhone: string;
  customerId?: string;
  leadId?: string;
  onCallCompleted?: () => void;
}

export function CallingModal({
  open,
  onOpenChange,
  recipientName,
  recipientPhone,
  customerId,
  leadId,
  onCallCompleted
}: CallingModalProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [selectedFromNumber, setSelectedFromNumber] = useState<string>("");
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

  // Always clean up the timer when the modal closes or the component unmounts.
  useEffect(() => {
    if (!open) {
      clearCooldown();
      setCooldownRemaining(0);
    }
    return () => clearCooldown();
  }, [open]);

  // Get current user data (cached and shared across the app)
  const { data: currentUser } = useCurrentUser();

  // Fetch organization default phone number (for users without personal defaults)
  const { data: orgDefaultData } = useQuery<{ defaultDialpadNumber: string | null }>({
    queryKey: ['/api/contractor/dialpad-default-number'],
    queryFn: async () => {
      const response = await fetch('/api/contractor/dialpad-default-number', {
        credentials: 'include'
      });
      if (!response.ok) throw new Error('Failed to fetch organization default');
      return response.json();
    },
  });

  // Set default phone number when modal opens (user default or organization default)
  useEffect(() => {
    if (open && !selectedFromNumber) {
      const userDefault = currentUser?.user?.dialpadDefaultNumber;
      const orgDefault = orgDefaultData?.defaultDialpadNumber;
      
      // Priority: 1) User's default, 2) Organization default
      if (userDefault) {
        setSelectedFromNumber(userDefault);
      } else if (orgDefault) {
        setSelectedFromNumber(orgDefault);
      }
    }
  }, [open, currentUser, orgDefaultData, selectedFromNumber]);

  const initiateCallMutation = useMutation({
    mutationFn: async (data: { toNumber: string; fromNumber?: string; customerId?: string; leadId?: string }) => {
      const response = await apiRequest('POST', '/api/calls/initiate', data);
      return response.json();
    },
    onSuccess: (data: { success: boolean; callId?: string; callUrl?: string }) => {
      toast({
        title: "Call initiated",
        description: data.callUrl 
          ? "Your Dialpad app will open shortly" 
          : `Calling ${recipientName}...`,
      });
      
      // Invalidate activities to refresh the activity list
      queryClient.invalidateQueries({ queryKey: ['/api/activities'] });
      queryClient.invalidateQueries({ queryKey: ['/api/contacts/paginated'] });
      
      // Open call URL if provided (will launch Dialpad app)
      if (data.callUrl) {
        window.open(data.callUrl, '_blank');
      }
      
      onOpenChange(false);
      onCallCompleted?.();
    },
    onError: (error: unknown) => {
      const parsed = parseCallError(error);
      toast({
        title: "Call failed",
        description: parsed.userMessage,
        variant: "destructive",
      });
      startCooldown(parsed.retryAfterSeconds);
    },
  });

  const handleCall = () => {
    if (!recipientPhone) {
      toast({
        title: "No phone number",
        description: "This contact doesn't have a phone number",
        variant: "destructive",
      });
      return;
    }

    // Clean the phone number
    const cleanPhoneNumber = recipientPhone.replace(/[^\d+]/g, '');
    
    initiateCallMutation.mutate({
      toNumber: cleanPhoneNumber,
      fromNumber: selectedFromNumber || undefined,
      customerId,
      leadId,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Phone className="h-5 w-5" />
            Call {recipientName}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              Calling: <span className="font-medium text-foreground">{recipientPhone}</span>
            </p>
          </div>

          <PhoneNumberSelector
            value={selectedFromNumber}
            onValueChange={setSelectedFromNumber}
            label="Call From"
            placeholder="Select your phone number"
            dataTestId="select-call-from-number"
          />

          <div className="flex gap-2 pt-4">
            <Button
              onClick={handleCall}
              disabled={!selectedFromNumber || initiateCallMutation.isPending || cooldownRemaining > 0}
              className="flex-1"
              data-testid="button-initiate-call"
            >
              <Phone className="h-4 w-4 mr-2" />
              {initiateCallMutation.isPending
                ? 'Calling...'
                : cooldownRemaining > 0
                  ? `Try again in ${cooldownRemaining}s`
                  : 'Call Now'}
            </Button>
            <Button
              onClick={() => onOpenChange(false)}
              variant="outline"
              disabled={initiateCallMutation.isPending}
              data-testid="button-cancel-call"
            >
              Cancel
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
