import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Separator } from '@/components/ui/separator';
import { CheckCircle } from 'lucide-react';
import type { UseMutationResult } from '@tanstack/react-query';
import { DefaultPhoneNumberSection } from './DefaultPhoneNumberSection';
import type { DialpadPhoneNumber } from './types';

interface FinalSetupStepProps {
  phoneNumbers: DialpadPhoneNumber[];
  isEnabled: boolean;
  enableMutation: UseMutationResult<any, any, void, any>;
}

export function FinalSetupStep({ phoneNumbers, isEnabled, enableMutation }: FinalSetupStepProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CheckCircle className="h-5 w-5" />
          {isEnabled ? 'Configuration Complete' : 'Step 3: Complete Setup'}
        </CardTitle>
        <CardDescription>
          {isEnabled
            ? 'Your Dialpad integration is active and configured.'
            : 'Review your configuration and enable the Dialpad integration for your CRM.'
          }
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-3">
          <div className="flex items-center justify-between p-3 bg-muted rounded-lg">
            <span>Phone Numbers Configured</span>
            <Badge>{phoneNumbers.length}</Badge>
          </div>
          <div className="flex items-center justify-between p-3 bg-muted rounded-lg">
            <span>Calling Capability</span>
            <Badge variant={phoneNumbers.some((pn) => pn.canMakeCalls) ? "default" : "secondary"}>
              {phoneNumbers.some((pn) => pn.canMakeCalls) ? "Enabled" : "Not Available"}
            </Badge>
          </div>
        </div>

        <Alert>
          <CheckCircle className="h-4 w-4" />
          <AlertDescription>
            Your Dialpad integration is ready! Users will only be able to send SMS or make calls from phone numbers they have permissions for.
          </AlertDescription>
        </Alert>

        <Separator />

        <DefaultPhoneNumberSection phoneNumbers={phoneNumbers} />

        {!isEnabled ? (
          <Button
            onClick={() => enableMutation.mutate()}
            disabled={enableMutation.isPending}
            className="w-full"
            data-testid="button-enable-dialpad"
          >
            {enableMutation.isPending ? 'Enabling...' : 'Enable Dialpad Integration'}
          </Button>
        ) : (
          <Alert>
            <CheckCircle className="h-4 w-4" />
            <AlertDescription>
              Your Dialpad integration is active! You can modify phone number assignments and user permissions above.
            </AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
