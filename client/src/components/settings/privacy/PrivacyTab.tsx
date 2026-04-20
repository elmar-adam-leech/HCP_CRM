import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Shield } from "lucide-react";

type PrivacySettings = {
  dataRetentionMonths: number | null;
  privacyNoticeMarkdown: string | null;
};

const RETENTION_OPTIONS = [
  { value: "12", label: "1 year" },
  { value: "24", label: "2 years" },
  { value: "36", label: "3 years" },
  { value: "60", label: "5 years" },
  { value: "84", label: "7 years (default)" },
  { value: "120", label: "10 years" },
];

export function PrivacyTab() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery<PrivacySettings>({
    queryKey: ["/api/settings/privacy"],
  });

  const [retentionMonths, setRetentionMonths] = useState<string | null>(null);
  const [noticeMarkdown, setNoticeMarkdown] = useState<string | null>(null);

  const currentRetention = retentionMonths ?? (data?.dataRetentionMonths ? String(data.dataRetentionMonths) : "84");
  const currentNotice = noticeMarkdown ?? (data?.privacyNoticeMarkdown ?? "");

  const saveMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("PATCH", "/api/settings/privacy", {
        dataRetentionMonths: parseInt(currentRetention, 10),
        privacyNoticeMarkdown: currentNotice || null,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings/privacy"] });
      setRetentionMonths(null);
      setNoticeMarkdown(null);
      toast({ title: "Privacy settings saved" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to save", description: err.message, variant: "destructive" });
    },
  });

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Shield className="h-5 w-5 text-muted-foreground" />
            <CardTitle>Data Retention Policy</CardTitle>
          </div>
          <CardDescription>
            Set how long contact data is retained before it is flagged for review and erasure. The
            daily retention job flags contacts whose last activity exceeds this threshold. Flagged
            contacts appear in the Contacts page under "Retention Review".
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {isLoading ? (
            <Skeleton className="h-10 w-48" />
          ) : (
            <div className="space-y-2">
              <Label>Retention period</Label>
              <Select
                value={currentRetention}
                onValueChange={setRetentionMonths}
              >
                <SelectTrigger className="w-48" data-testid="select-retention-months">
                  <SelectValue placeholder="Select period" />
                </SelectTrigger>
                <SelectContent>
                  {RETENTION_OPTIONS.map(opt => (
                    <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Custom Privacy Notice</CardTitle>
          <CardDescription>
            Optionally provide a custom privacy notice in Markdown format. This notice is displayed on
            your public booking page and accessible at{" "}
            <code className="text-xs bg-muted px-1 rounded">/privacy/[your-slug]</code>. Leave blank
            to use the default platform policy.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : (
            <Textarea
              value={currentNotice}
              onChange={e => setNoticeMarkdown(e.target.value)}
              placeholder="## Privacy Notice&#10;&#10;We respect your privacy..."
              className="min-h-[200px] font-mono text-sm"
              data-testid="textarea-privacy-notice"
            />
          )}
          <Button
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending}
            data-testid="button-save-privacy-settings"
          >
            {saveMutation.isPending ? "Saving..." : "Save Privacy Settings"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
