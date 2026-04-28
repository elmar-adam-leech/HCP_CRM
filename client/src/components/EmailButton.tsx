import { useState } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Mail, Loader2 } from "lucide-react";

interface FromAddress {
  email: string;
  label: string;
  type: 'personal' | 'shared';
}

interface EmailButtonProps {
  recipientName: string;
  recipientEmail: string;
  variant?: "default" | "outline" | "ghost" | "destructive" | "secondary";
  size?: "default" | "sm" | "lg" | "icon";
  className?: string;
  children?: React.ReactNode;
  onSendEmail: () => void;
  leadId?: string;
  customerId?: string;
  estimateId?: string;
  hasUnread?: boolean;
  forceInAppCompose?: boolean;
}

export function EmailButton({
  recipientName: _recipientName,
  recipientEmail,
  variant = "outline",
  size = "default",
  className = "",
  children,
  onSendEmail,
  leadId,
  customerId,
  estimateId,
  hasUnread,
  forceInAppCompose = false,
}: EmailButtonProps) {
  const [, navigate] = useLocation();
  const [showConnectPrompt, setShowConnectPrompt] = useState(false);

  const { data: fromAddresses, isLoading } = useQuery<FromAddress[]>({
    queryKey: ['/api/messages/from-addresses'],
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const entityType = leadId ? 'lead' : customerId ? 'customer' : estimateId ? 'estimate' : 'contact';
  const entityId = leadId || customerId || estimateId || '';

  if (!recipientEmail) {
    return null;
  }

  const hasAnyAddress = (fromAddresses?.length ?? 0) > 0;
  const disabled = !forceInAppCompose && isLoading;

  const handleClick = () => {
    if (forceInAppCompose || hasAnyAddress) {
      onSendEmail();
      return;
    }
    setShowConnectPrompt(true);
  };

  const dot = hasUnread ? (
    <span className="absolute -top-1 -right-1 flex h-2.5 w-2.5" data-testid={`unread-dot-email-${entityId}`}>
      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
      <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-red-500" />
    </span>
  ) : null;

  return (
    <>
      <div className={`relative inline-flex ${className}`}>
        <Button
          variant={variant}
          size={size}
          className="w-full"
          onClick={handleClick}
          disabled={disabled}
          data-testid={`button-email-${entityType}-${entityId}`}
        >
          {children || (
            <>
              {disabled ? (
                <Loader2 className="h-3 w-3 mr-1 shrink-0 animate-spin" />
              ) : (
                <Mail className="h-3 w-3 mr-1 shrink-0" />
              )}
              Email
            </>
          )}
        </Button>
        {dot}
      </div>

      <AlertDialog open={showConnectPrompt} onOpenChange={setShowConnectPrompt}>
        <AlertDialogContent data-testid="dialog-connect-email">
          <AlertDialogHeader>
            <AlertDialogTitle>Connect your email to send from the CRM</AlertDialogTitle>
            <AlertDialogDescription>
              You don't have an email account connected yet. Connect your Gmail
              (or ask an admin to set up a shared company email) so you can send
              from the CRM with templates and full message history.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-connect-email-cancel">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => navigate('/settings?tab=integrations')}
              data-testid="button-connect-email-go-to-settings"
            >
              Go to Settings
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
