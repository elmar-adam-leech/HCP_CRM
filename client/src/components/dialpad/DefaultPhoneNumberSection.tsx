import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useToast } from '@/hooks/use-toast';
import { apiRequest } from '@/lib/queryClient';
import { AlertTriangle, Star } from 'lucide-react';
import type { DialpadPhoneNumber } from './types';

interface DefaultPhoneNumberSectionProps {
  phoneNumbers: DialpadPhoneNumber[];
}

export function DefaultPhoneNumberSection({ phoneNumbers }: DefaultPhoneNumberSectionProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: defaultNumberData } = useQuery({
    queryKey: ['/api/contractor/dialpad-default-number']
  });
  const currentDefaultNumber = (defaultNumberData as { defaultDialpadNumber: string | null })?.defaultDialpadNumber || null;

  const updateDefaultNumberMutation = useMutation({
    mutationFn: async (phoneNumber: string | null) => {
      return await apiRequest('PUT', '/api/contractor/dialpad-default-number', {
        defaultDialpadNumber: phoneNumber
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/contractor/dialpad-default-number'] });
      toast({
        title: "Success",
        description: "Organization default phone number updated successfully"
      });
    },
    onError: (error: any) => {
      toast({
        title: "Error",
        description: error.message || "Failed to update default phone number",
        variant: "destructive"
      });
    }
  });

  return (
    <div className="space-y-3">
      <div>
        <h4 className="text-sm font-semibold">Organization Default Phone Number</h4>
        <p className="text-sm text-muted-foreground">
          Set a default phone number for all users who haven't configured their own. This number will be used for calls and SMS.
        </p>
      </div>

      <div className="flex items-center gap-3">
        <div className="flex-1">
          <Select
            value={currentDefaultNumber || 'none'}
            onValueChange={(value) => updateDefaultNumberMutation.mutate(value === 'none' ? null : value)}
            disabled={updateDefaultNumberMutation.isPending || phoneNumbers.length === 0}
          >
            <SelectTrigger data-testid="select-org-default-number">
              <SelectValue placeholder="Select default phone number..." />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">No default (users must set their own)</SelectItem>
              {phoneNumbers.map((phoneNumber) => (
                <SelectItem key={phoneNumber.id} value={phoneNumber.phoneNumber}>
                  {phoneNumber.phoneNumber}
                  {phoneNumber.department && ` (${phoneNumber.department})`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {currentDefaultNumber && (
          <Badge variant="outline" className="shrink-0">
            <Star className="h-3 w-3 mr-1" />
            Default Set
          </Badge>
        )}
      </div>

      {phoneNumbers.length === 0 && (
        <Alert>
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription className="text-sm">
            Sync phone numbers first to set an organization default.
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}
