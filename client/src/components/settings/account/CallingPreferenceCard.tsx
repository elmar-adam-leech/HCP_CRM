import { useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Phone, Smartphone } from "lucide-react";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useProviderStatus } from "@/hooks/use-provider-config";

export function CallingPreferenceCard() {
  const { toast } = useToast();
  const { data: me } = useCurrentUser();
  const { calling } = useProviderStatus();

  const callPreferenceMutation = useMutation({
    mutationFn: async (callPreference: 'integration' | 'personal') => {
      const response = await apiRequest('PATCH', '/api/user/call-preference', { callPreference });
      return response.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['/api/auth/me'] });
      toast({
        title: "Call preference updated",
        description: data.callPreference === 'personal'
          ? "You'll now use your personal phone when calling contacts."
          : "You'll now use the calling integration when calling contacts.",
      });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to update", description: error.message, variant: "destructive" });
    },
  });

  if (calling.isLoading) return null;
  if (!calling.isConfigured) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Phone className="h-5 w-5" />Calling Preference</CardTitle>
        <CardDescription>Choose how you want to make calls from the CRM</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <button
            type="button"
            onClick={() => callPreferenceMutation.mutate('integration')}
            disabled={callPreferenceMutation.isPending}
            data-testid="button-call-pref-integration"
            className={`flex items-start gap-3 p-4 rounded-md border text-left transition-colors ${
              (me?.user?.callPreference ?? 'integration') === 'integration'
                ? 'border-primary bg-primary/5'
                : 'border-border hover-elevate'
            }`}
          >
            <Phone className="h-5 w-5 mt-0.5 shrink-0 text-muted-foreground" />
            <div>
              <div className="text-sm font-medium">Calling integration</div>
              <div className="text-xs text-muted-foreground mt-0.5">Uses your connected calling service. Calls are automatically logged.</div>
            </div>
          </button>
          <button
            type="button"
            onClick={() => callPreferenceMutation.mutate('personal')}
            disabled={callPreferenceMutation.isPending}
            data-testid="button-call-pref-personal"
            className={`flex items-start gap-3 p-4 rounded-md border text-left transition-colors ${
              me?.user?.callPreference === 'personal'
                ? 'border-primary bg-primary/5'
                : 'border-border hover-elevate'
            }`}
          >
            <Smartphone className="h-5 w-5 mt-0.5 shrink-0 text-muted-foreground" />
            <div>
              <div className="text-sm font-medium">Personal phone</div>
              <div className="text-xs text-muted-foreground mt-0.5">Opens your device's native dialer. Calls won't be automatically logged.</div>
            </div>
          </button>
        </div>
      </CardContent>
    </Card>
  );
}
