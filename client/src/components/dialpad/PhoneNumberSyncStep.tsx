import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Phone, MessageSquare, PhoneCall, RotateCcw, AlertTriangle } from 'lucide-react';
import type { UseMutationResult } from '@tanstack/react-query';
import type { DialpadPhoneNumber } from './types';

interface PhoneNumberSyncStepProps {
  phoneNumbers: DialpadPhoneNumber[];
  phoneNumbersLoading: boolean;
  phoneNumberDepartments: Record<string, string>;
  departments: string[];
  syncMutation: UseMutationResult<any, any, void, any>;
  onPhoneNumberUpdate: (id: string, field: 'displayName' | 'department', value: string) => void;
  onContinue: () => void;
}

export function PhoneNumberSyncStep({
  phoneNumbers,
  phoneNumbersLoading,
  phoneNumberDepartments,
  departments,
  syncMutation,
  onPhoneNumberUpdate,
  onContinue,
}: PhoneNumberSyncStepProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Phone className="h-5 w-5" />
          Step 2: Sync Phone Numbers
        </CardTitle>
        <CardDescription>
          Import your Dialpad phone numbers and assign them to departments for better organization.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-1">
          <div>
            <h4 className="text-sm font-medium">Phone Numbers</h4>
            <p className="text-sm text-muted-foreground">
              {phoneNumbers.length} phone numbers currently synced
            </p>
          </div>
          <Button
            onClick={() => syncMutation.mutate()}
            disabled={syncMutation.isPending}
            variant="outline"
            size="sm"
            data-testid="button-sync-phone-numbers"
          >
            <RotateCcw className="h-4 w-4 mr-2" />
            {syncMutation.isPending ? 'Syncing...' : 'Sync from Dialpad'}
          </Button>
        </div>

        {phoneNumbersLoading ? (
          <div className="text-center py-4">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto"></div>
            <p className="text-sm text-muted-foreground mt-2">Loading phone numbers...</p>
          </div>
        ) : phoneNumbers.length > 0 ? (
          <div className="space-y-3">
            {phoneNumbers.map((phoneNumber) => (
              <Card key={phoneNumber.id} className="p-4">
                <div className="flex items-center justify-between flex-wrap gap-3">
                  <div className="flex items-center gap-3">
                    <div className="p-2 bg-muted rounded-lg">
                      <Phone className="h-4 w-4" />
                    </div>
                    <div>
                      <p className="font-medium">{phoneNumber.phoneNumber}</p>
                      <div className="flex items-center gap-2 mt-1">
                        {phoneNumber.canSendSms && (
                          <Badge variant="outline" className="text-xs">
                            <MessageSquare className="h-3 w-3 mr-1" />
                            SMS
                          </Badge>
                        )}
                        {phoneNumber.canMakeCalls && (
                          <Badge variant="outline" className="text-xs">
                            <PhoneCall className="h-3 w-3 mr-1" />
                            Calls
                          </Badge>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label className="text-xs">Department</Label>
                    <Select
                      value={phoneNumberDepartments[phoneNumber.id] || phoneNumber.department || 'none'}
                      onValueChange={(value) =>
                        onPhoneNumberUpdate(phoneNumber.id, 'department', value === 'none' ? '' : value)
                      }
                    >
                      <SelectTrigger className="w-32">
                        <SelectValue placeholder="Select..." />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">None</SelectItem>
                        {departments.map((dept) => (
                          <SelectItem key={dept} value={dept}>{dept}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        ) : (
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              No phone numbers found. Click "Sync from Dialpad" to import your phone numbers.
            </AlertDescription>
          </Alert>
        )}

        {phoneNumbers.length > 0 && (
          <Button
            onClick={onContinue}
            className="w-full"
            data-testid="button-continue-final"
          >
            Continue to Final Setup
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
