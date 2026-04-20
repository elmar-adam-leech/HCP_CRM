import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Settings, AlertTriangle } from 'lucide-react';
import type { UseMutationResult } from '@tanstack/react-query';

interface CredentialsStepProps {
  apiKey: string;
  userId: string;
  onApiKeyChange: (value: string) => void;
  onUserIdChange: (value: string) => void;
  onSubmit: () => void;
  saveMutation: UseMutationResult<any, any, any, any>;
}

export function CredentialsStep({
  apiKey,
  userId,
  onApiKeyChange,
  onUserIdChange,
  onSubmit,
  saveMutation,
}: CredentialsStepProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Settings className="h-5 w-5" />
          Step 1: Configure API Access
        </CardTitle>
        <CardDescription>
          Enter your Dialpad API key to connect your account. You can find this in your Dialpad admin settings.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="api-key">Dialpad API Key</Label>
          <Input
            id="api-key"
            type="password"
            placeholder="Enter your Dialpad API key"
            value={apiKey}
            onChange={(e) => onApiKeyChange(e.target.value)}
            data-testid="input-dialpad-api-key"
          />
          <p className="text-sm text-muted-foreground">
            Your API key will be stored securely and encrypted.
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="user-id">Dialpad User ID</Label>
          <Input
            id="user-id"
            type="text"
            placeholder="Enter your Dialpad User ID"
            value={userId}
            onChange={(e) => onUserIdChange(e.target.value)}
            data-testid="input-dialpad-user-id"
          />
          <p className="text-sm text-muted-foreground">
            Your User ID is required for making calls. Find it in Dialpad settings or your admin panel.
          </p>
        </div>

        <Alert>
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            <strong>Important:</strong> Make sure your Dialpad API key has permissions for SMS and calling features, and your User ID is correct.
          </AlertDescription>
        </Alert>

        <Button
          onClick={onSubmit}
          disabled={saveMutation.isPending}
          className="w-full"
          data-testid="button-save-api-key"
        >
          {saveMutation.isPending ? 'Saving...' : 'Save Credentials & Continue'}
        </Button>
      </CardContent>
    </Card>
  );
}
