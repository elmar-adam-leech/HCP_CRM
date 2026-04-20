import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Settings2 } from "lucide-react";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useCurrentUser, isStrictAdmin } from "@/hooks/useCurrentUser";
import { useTerminologyContext } from "@/contexts/TerminologyContext";

type TerminologyLabels = {
  leadLabel: string; leadsLabel: string;
  estimateLabel: string; estimatesLabel: string;
  jobLabel: string; jobsLabel: string;
  messageLabel: string; messagesLabel: string;
  templateLabel: string; templatesLabel: string;
};

const DEFAULT_TERMINOLOGY: TerminologyLabels = {
  leadLabel: 'Lead', leadsLabel: 'Leads',
  estimateLabel: 'Estimate', estimatesLabel: 'Estimates',
  jobLabel: 'Job', jobsLabel: 'Jobs',
  messageLabel: 'Message', messagesLabel: 'Messages',
  templateLabel: 'Template', templatesLabel: 'Templates',
};

const TERMINOLOGY_FIELDS = [
  { id: 'leads', pluralKey: 'leadsLabel' as const, singularKey: 'leadLabel' as const, pluralPlaceholder: 'Leads', singularPlaceholder: 'Lead' },
  { id: 'estimates', pluralKey: 'estimatesLabel' as const, singularKey: 'estimateLabel' as const, pluralPlaceholder: 'Estimates', singularPlaceholder: 'Estimate' },
  { id: 'jobs', pluralKey: 'jobsLabel' as const, singularKey: 'jobLabel' as const, pluralPlaceholder: 'Jobs', singularPlaceholder: 'Job' },
];

export function TerminologyCard() {
  const { toast } = useToast();
  const { data: currentUser } = useCurrentUser();
  const isAdmin = isStrictAdmin(currentUser?.user?.role);

  const contextTerminology = useTerminologyContext();
  const [pendingTerminology, setPendingTerminology] = useState<TerminologyLabels | undefined>(undefined);
  const effectiveTerminology: TerminologyLabels = { ...DEFAULT_TERMINOLOGY, ...contextTerminology, ...pendingTerminology };

  const saveTerminologyMutation = useMutation({
    mutationFn: async (settings: TerminologyLabels) => {
      const response = await apiRequest('POST', '/api/terminology', settings);
      return response.json();
    },
    onSuccess: () => {
      toast({ title: "Terminology Settings Saved", description: "Your navigation terminology has been updated successfully." });
      queryClient.invalidateQueries({ queryKey: ['/api/terminology'] });
      setPendingTerminology(undefined);
    },
    onError: (error: any) => {
      toast({ title: "Error", description: error.message || "Failed to save terminology settings.", variant: "destructive" });
    },
  });

  if (!isAdmin) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Settings2 className="h-5 w-5" />Terminology Settings</CardTitle>
        <CardDescription>Customize the labels used throughout the application to match your business terminology</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-6">
          {TERMINOLOGY_FIELDS.map((field) => (
            <div key={field.id} className="space-y-3">
              <h4 className="text-sm font-medium capitalize">{field.id}</h4>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor={`${field.id}-singular`} className="text-xs text-muted-foreground">Singular</Label>
                  <Input
                    id={`${field.id}-singular`}
                    placeholder={field.singularPlaceholder}
                    value={effectiveTerminology[field.singularKey]}
                    onChange={(e) => setPendingTerminology({ ...effectiveTerminology, [field.singularKey]: e.target.value })}
                    data-testid={`input-terminology-${field.id}-singular`}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`${field.id}-plural`} className="text-xs text-muted-foreground">Plural</Label>
                  <Input
                    id={`${field.id}-plural`}
                    placeholder={field.pluralPlaceholder}
                    value={effectiveTerminology[field.pluralKey]}
                    onChange={(e) => setPendingTerminology({ ...effectiveTerminology, [field.pluralKey]: e.target.value })}
                    data-testid={`input-terminology-${field.id}-plural`}
                  />
                </div>
              </div>
              <Separator />
            </div>
          ))}
          <Button
            onClick={() => saveTerminologyMutation.mutate(effectiveTerminology)}
            disabled={saveTerminologyMutation.isPending || !pendingTerminology}
            data-testid="button-save-terminology"
          >
            {saveTerminologyMutation.isPending ? "Saving..." : "Save Terminology"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
