import { useState, useEffect } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useToast } from '@/hooks/use-toast';
import { queryClient } from '@/lib/queryClient';
import { Phone, Info } from 'lucide-react';

interface DialpadPhoneNumber {
  id: string;
  phoneNumber: string;
  displayName?: string;
  department?: string;
  canSendSms: boolean;
  canMakeCalls: boolean;
  isActive: boolean;
}

export default function DialpadDefaultNumberSettings() {
  const { toast } = useToast();
  const [selectedNumber, setSelectedNumber] = useState<string>('');

  // Get user's default Dialpad number
  const { data: defaultNumberData, isLoading: defaultNumberLoading } = useQuery<{ dialpadDefaultNumber: string | null }>({
    queryKey: ['/api/users/me/dialpad-default-number'],
  });

  // Get available phone numbers for SMS
  const { data: availableNumbers = [], isLoading: numbersLoading } = useQuery<DialpadPhoneNumber[]>({
    queryKey: ['/api/dialpad/users/available-phone-numbers', 'sms'],
    queryFn: async () => {
      const response = await fetch('/api/dialpad/users/available-phone-numbers?action=sms');
      if (!response.ok) throw new Error('Failed to fetch available numbers');
      return response.json();
    }
  });

  // Update default number mutation
  const updateDefaultNumber = useMutation({
    mutationFn: async (dialpadDefaultNumber: string | null) => {
      const response = await fetch('/api/users/me/dialpad-default-number', {
        method: 'PUT',
        body: JSON.stringify({ dialpadDefaultNumber }),
        headers: { 'Content-Type': 'application/json' },
      });
      if (!response.ok) throw new Error('Failed to update default number');
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/users/me/dialpad-default-number'] });
      toast({
        title: 'Success',
        description: 'Default phone number updated successfully',
      });
    },
    onError: () => {
      toast({
        title: 'Error',
        description: 'Failed to update default phone number',
        variant: 'destructive',
      });
    },
  });

  const handleSave = () => {
    updateDefaultNumber.mutate(selectedNumber || null);
  };

  const handleClear = () => {
    setSelectedNumber('');
    updateDefaultNumber.mutate(null);
  };

  // Set initial selected value when default number loads
  useEffect(() => {
    if (defaultNumberData?.dialpadDefaultNumber) {
      setSelectedNumber(defaultNumberData.dialpadDefaultNumber);
    }
  }, [defaultNumberData?.dialpadDefaultNumber]);

  if (numbersLoading || defaultNumberLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Phone className="h-5 w-5" />
            Dialpad Settings
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Loading...</p>
        </CardContent>
      </Card>
    );
  }

  // Don't show if no available numbers
  if (availableNumbers.length === 0) {
    return null;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Phone className="h-5 w-5" />
          Dialpad Settings
        </CardTitle>
        <CardDescription>
          Set your default phone number for making calls and sending text messages
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="default-number">Default Phone Number</Label>
          <Select
            value={selectedNumber || defaultNumberData?.dialpadDefaultNumber || ''}
            onValueChange={setSelectedNumber}
          >
            <SelectTrigger id="default-number" data-testid="select-default-phone-number">
              <SelectValue placeholder="Select a phone number" />
            </SelectTrigger>
            <SelectContent>
              {availableNumbers.map((number) => (
                <SelectItem key={number.id} value={number.phoneNumber}>
                  {number.displayName || number.phoneNumber}
                  {number.department && ` (${number.department})`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            This number will be used by default when you make calls or send texts from the CRM
          </p>
        </div>

        <Alert>
          <Info className="h-4 w-4" />
          <AlertDescription className="text-sm">
            Multiple users can use the same phone number if they have permission to do so.
          </AlertDescription>
        </Alert>

        <div className="flex gap-2">
          <Button
            onClick={handleSave}
            disabled={!selectedNumber || selectedNumber === defaultNumberData?.dialpadDefaultNumber || updateDefaultNumber.isPending}
            data-testid="button-save-default-number"
          >
            {updateDefaultNumber.isPending ? 'Saving...' : 'Save'}
          </Button>
          {defaultNumberData?.dialpadDefaultNumber && (
            <Button
              variant="outline"
              onClick={handleClear}
              disabled={updateDefaultNumber.isPending}
              data-testid="button-clear-default-number"
            >
              Clear
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
