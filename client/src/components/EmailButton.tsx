import { Button } from "@/components/ui/button";
import { Mail } from "lucide-react";
import { useCurrentUser } from "@/hooks/useCurrentUser";

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
  const { data: currentUser } = useCurrentUser();
  const gmailConnected = currentUser?.user?.gmailConnected || false;
  const useInAppCompose = forceInAppCompose || gmailConnected;

  // Determine test ID based on entity type
  const entityType = leadId ? 'lead' : customerId ? 'customer' : estimateId ? 'estimate' : 'contact';
  const entityId = leadId || customerId || estimateId || '';

  if (!recipientEmail) {
    return null;
  }

  const dot = hasUnread ? (
    <span className="absolute -top-1 -right-1 flex h-2.5 w-2.5" data-testid={`unread-dot-email-${entityId}`}>
      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
      <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-red-500" />
    </span>
  ) : null;

  if (!useInAppCompose) {
    return (
      <div className={`relative inline-flex ${className}`}>
        <Button
          variant={variant}
          size={size}
          className="w-full"
          asChild
          data-testid={`button-email-${entityType}-${entityId}`}
        >
          <a href={`mailto:${recipientEmail}`}>
            {children || (
              <>
                <Mail className="h-3 w-3 mr-1 shrink-0" />
                Email
              </>
            )}
          </a>
        </Button>
        {dot}
      </div>
    );
  }

  return (
    <div className={`relative inline-flex ${className}`}>
      <Button
        variant={variant}
        size={size}
        className="w-full"
        onClick={onSendEmail}
        data-testid={`button-email-${entityType}-${entityId}`}
      >
        {children || (
          <>
            <Mail className="h-3 w-3 mr-1 shrink-0" />
            Email
          </>
        )}
      </Button>
      {dot}
    </div>
  );
}
