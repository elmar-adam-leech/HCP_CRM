import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { formatPhoneNumber } from "@/lib/utils";

interface PhoneNumber {
  id: string;
  phoneNumber: string;
  displayName?: string;
}

interface PhoneNumberSelectorProps {
  value: string;
  onValueChange: (value: string) => void;
  label?: string;
  placeholder?: string;
  className?: string;
  dataTestId?: string;
  disabled?: boolean;
  /**
   * Which capability the numbers must support. Defaults to 'sms' (texting).
   * The Call modal passes 'call' so call-capable numbers are surfaced.
   */
  action?: 'sms' | 'call';
}

export function PhoneNumberSelector({
  value,
  onValueChange,
  label = "From Number",
  placeholder = "Select phone number...",
  className,
  dataTestId = "select-from-number",
  disabled = false,
  action = 'sms'
}: PhoneNumberSelectorProps) {
  // Get current user data (cached and shared across the app)
  const { data: currentUser } = useCurrentUser();

  // Fetch available phone numbers from every enabled communication provider
  // (Dialpad, Twilio, ...) via the provider-agnostic endpoint.
  const { data: availableNumbers = [], isLoading: numbersLoading } = useQuery<PhoneNumber[]>({
    queryKey: ['/api/messages/available-from-numbers', action],
    queryFn: async () => {
      const response = await fetch(`/api/messages/available-from-numbers?action=${action}`, {
        credentials: 'include'
      });
      if (!response.ok) throw new Error('Failed to fetch phone numbers');
      return response.json();
    },
  });

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

  // Set user's default number when numbers load, or fallback to organization default, then first available
  useEffect(() => {
    if (availableNumbers.length > 0 && !value) {
      const userDefaultNumber = currentUser?.user?.dialpadDefaultNumber;
      const orgDefaultNumber = orgDefaultData?.defaultDialpadNumber;
      
      // Priority: 1) User's default, 2) Organization default, 3) First available
      if (userDefaultNumber && availableNumbers.some(num => num.phoneNumber === userDefaultNumber)) {
        onValueChange(userDefaultNumber);
      } else if (orgDefaultNumber && availableNumbers.some(num => num.phoneNumber === orgDefaultNumber)) {
        onValueChange(orgDefaultNumber);
      } else {
        // Fallback to first available number
        onValueChange(availableNumbers[0].phoneNumber);
      }
    }
  }, [availableNumbers, currentUser, orgDefaultData, value, onValueChange]);

  // Check if display name is just a phone number format
  const isPhoneNumberFormat = (str: string): boolean => {
    if (!str) return false;
    return /^[\+\d\(\)\-\s]+$/.test(str);
  };

  // Get display text for a phone number
  const getDisplayText = (number: PhoneNumber): string => {
    if (!number.displayName || isPhoneNumberFormat(number.displayName)) {
      // No display name or it's just a phone number - show formatted number only
      return formatPhoneNumber(number.phoneNumber);
    }
    // Has a real display name - show both
    return `${number.displayName} ${formatPhoneNumber(number.phoneNumber)}`;
  };

  if (numbersLoading) {
    return (
      <div className={`grid gap-2 ${className || ''}`}>
        <Label>{label}</Label>
        <div className="text-sm text-muted-foreground">Loading phone numbers...</div>
      </div>
    );
  }

  if (availableNumbers.length === 0) {
    return (
      <div className={`grid gap-2 ${className || ''}`}>
        <Label>{label}</Label>
        <div className="text-sm text-muted-foreground">No phone numbers available</div>
      </div>
    );
  }

  // Find the display text for the selected number
  const selectedNumber = availableNumbers.find(num => num.phoneNumber === value);
  const displayText = selectedNumber ? getDisplayText(selectedNumber) : placeholder;

  return (
    <div className={`grid gap-2 ${className || ''}`}>
      <Label htmlFor="from-number" className="text-xs">{label}</Label>
      <Select value={value} onValueChange={onValueChange} disabled={disabled}>
        <SelectTrigger data-testid={dataTestId} className="text-sm">
          <SelectValue placeholder={placeholder}>
            {displayText}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {availableNumbers.map((number) => (
            <SelectItem key={number.id} value={number.phoneNumber}>
              {getDisplayText(number)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}