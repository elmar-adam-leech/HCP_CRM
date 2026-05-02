import { useEffect, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Bot, Info } from "lucide-react";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useCurrentUser, isStrictAdmin } from "@/hooks/useCurrentUser";

interface AiSchedulingSettings {
  aiSchedulingEnabled: boolean;
  aiSchedulingPersonality: string;
  aiSchedulingCompanyContext: string;
}

const PERSONALITY_PLACEHOLDER =
  "Friendly and professional. Warm but concise. Avoid jargon. Always thank the customer for their patience.";

const COMPANY_CONTEXT_PLACEHOLDER =
  "We're Elmar Heating & Cooling, a family-owned HVAC company serving the New Hampshire seacoast since 1985. We install and service furnaces, heat pumps, and central AC. Our office is in Hampton, NH.";

const MAX_CHARS = 2000;

export function AiSchedulingAgentCard() {
  const { toast } = useToast();
  const { data: currentUser } = useCurrentUser();
  const isAdmin = isStrictAdmin(currentUser?.user?.role);

  const { data: settings, isLoading } = useQuery<AiSchedulingSettings>({
    queryKey: ['/api/settings/ai-scheduling'],
    enabled: isAdmin,
  });

  const [enabled, setEnabled] = useState<boolean | undefined>(undefined);
  const [personality, setPersonality] = useState<string | undefined>(undefined);
  const [companyContext, setCompanyContext] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (settings) {
      setEnabled(settings.aiSchedulingEnabled);
      setPersonality(settings.aiSchedulingPersonality);
      setCompanyContext(settings.aiSchedulingCompanyContext);
    }
  }, [settings]);

  const effectiveEnabled = enabled ?? settings?.aiSchedulingEnabled ?? false;
  const effectivePersonality = personality ?? settings?.aiSchedulingPersonality ?? "";
  const effectiveCompanyContext = companyContext ?? settings?.aiSchedulingCompanyContext ?? "";

  const dirty =
    settings !== undefined &&
    (effectiveEnabled !== settings.aiSchedulingEnabled ||
      effectivePersonality !== settings.aiSchedulingPersonality ||
      effectiveCompanyContext !== settings.aiSchedulingCompanyContext);

  const saveMutation = useMutation({
    mutationFn: async (payload: AiSchedulingSettings) => {
      const response = await apiRequest('PATCH', '/api/settings/ai-scheduling', payload);
      return response.json() as Promise<AiSchedulingSettings>;
    },
    onSuccess: (data) => {
      // Write the saved values into the cache synchronously so the dirty
      // baseline updates immediately and the "Unsaved changes" hint clears
      // before the (eventual) refetch resolves. Then refetch in background
      // so any concurrent edits from another tab/session pick up too.
      queryClient.setQueryData(['/api/settings/ai-scheduling'], data);
      setEnabled(data.aiSchedulingEnabled);
      setPersonality(data.aiSchedulingPersonality);
      setCompanyContext(data.aiSchedulingCompanyContext);
      toast({
        title: "AI Scheduling Settings Saved",
        description: data.aiSchedulingEnabled
          ? "The AI scheduling agent is on."
          : "The AI scheduling agent is off.",
      });
      queryClient.invalidateQueries({ queryKey: ['/api/settings/ai-scheduling'] });
    },
    onError: (error: Error) => {
      toast({
        title: "Could not save",
        description: error.message || "Something went wrong saving these settings.",
        variant: "destructive",
      });
    },
  });

  if (!isAdmin) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bot className="h-5 w-5" />
          AI Scheduling Agent
        </CardTitle>
        <CardDescription>
          When a lead replies by text, the AI agent can collect their address, check the calendar, and book the appointment with the next available salesperson — all without a human touching it.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-6">
          <div className="flex flex-wrap items-start justify-between gap-4 rounded-md border p-4">
            <div className="space-y-1">
              <Label htmlFor="ai-scheduling-enabled" className="text-base">
                Enable AI Scheduling Agent
              </Label>
              <p className="text-sm text-muted-foreground">
                Off means inbound text replies are never answered by AI.
              </p>
            </div>
            <Switch
              id="ai-scheduling-enabled"
              checked={effectiveEnabled}
              onCheckedChange={(val) => setEnabled(val)}
              disabled={isLoading || saveMutation.isPending}
              data-testid="switch-ai-scheduling-enabled"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="ai-personality">Personality &amp; Tone</Label>
            <Textarea
              id="ai-personality"
              placeholder={PERSONALITY_PLACEHOLDER}
              value={effectivePersonality}
              onChange={(e) => setPersonality(e.target.value.slice(0, MAX_CHARS))}
              rows={4}
              disabled={isLoading || saveMutation.isPending}
              data-testid="textarea-ai-personality"
            />
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">
                Tell the agent how it should sound — friendly, formal, casual, etc.
              </p>
              <p className="text-xs text-muted-foreground tabular-nums">
                {effectivePersonality.length} / {MAX_CHARS}
              </p>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="ai-company-context">Company Context</Label>
            <Textarea
              id="ai-company-context"
              placeholder={COMPANY_CONTEXT_PLACEHOLDER}
              value={effectiveCompanyContext}
              onChange={(e) => setCompanyContext(e.target.value.slice(0, MAX_CHARS))}
              rows={6}
              disabled={isLoading || saveMutation.isPending}
              data-testid="textarea-ai-company-context"
            />
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">
                Background facts the agent should know — your company name, service area, what you sell, hours, anything else worth mentioning.
              </p>
              <p className="text-xs text-muted-foreground tabular-nums">
                {effectiveCompanyContext.length} / {MAX_CHARS}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <Button
              onClick={() =>
                saveMutation.mutate({
                  aiSchedulingEnabled: effectiveEnabled,
                  aiSchedulingPersonality: effectivePersonality,
                  aiSchedulingCompanyContext: effectiveCompanyContext,
                })
              }
              disabled={!dirty || saveMutation.isPending || isLoading}
              data-testid="button-save-ai-scheduling"
            >
              {saveMutation.isPending ? "Saving..." : "Save AI Settings"}
            </Button>
            {dirty && !saveMutation.isPending && (
              <span className="text-xs text-muted-foreground">Unsaved changes</span>
            )}
          </div>

          <Alert>
            <Info className="h-4 w-4" />
            <AlertDescription>
              The AI agent only responds to inbound text messages — it never sends the first message. You can turn it off at any time and any in-progress conversations will hand back to your team.
            </AlertDescription>
          </Alert>
        </div>
      </CardContent>
    </Card>
  );
}
