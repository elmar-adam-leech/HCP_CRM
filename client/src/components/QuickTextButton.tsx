import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MessageSquare } from "lucide-react";
import { useSendSms } from "@/hooks/useSendSms";

interface QuickTextButtonProps {
  recipientName: string;
  recipientPhone: string;
  fromNumber?: string;
  leadId?: string;
  customerId?: string;
  estimateId?: string;
  variant?: "default" | "outline" | "ghost";
  size?: "sm" | "default" | "lg";
  className?: string;
}

/**
 * Example component demonstrating how easy it is to add SMS functionality
 * anywhere in the application using the modular useSendSms hook
 */
export function QuickTextButton({
  recipientName,
  recipientPhone,
  fromNumber,
  leadId,
  customerId,
  estimateId,
  variant = "outline",
  size = "sm",
  className = "",
}: QuickTextButtonProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [message, setMessage] = useState("");
  const { sendSms, isLoading } = useSendSms();

  const handleSend = () => {
    if (!message.trim()) return;

    sendSms({
      content: message.trim(),
      toNumber: recipientPhone,
      fromNumber,
      leadId,
      customerId,
      estimateId,
    });

    // Reset state after sending
    setMessage("");
    setIsExpanded(false);
  };

  if (isExpanded) {
    return (
      <div className="flex gap-2 items-center">
        <Input
          placeholder={`Text ${recipientName}...`}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyPress={(e) => e.key === 'Enter' && handleSend()}
          className="flex-1 min-w-[200px]"
          autoFocus
        />
        <Button
          onClick={handleSend}
          disabled={!message.trim() || isLoading}
          size="sm"
        >
          {isLoading ? "Sending..." : "Send"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setIsExpanded(false);
            setMessage("");
          }}
        >
          Cancel
        </Button>
      </div>
    );
  }

  return (
    <Button
      variant={variant}
      size={size}
      className={className}
      onClick={() => setIsExpanded(true)}
    >
      <MessageSquare className="h-3 w-3 mr-1" />
      Text
    </Button>
  );
}