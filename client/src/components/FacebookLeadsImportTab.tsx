import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { DatePicker } from "@/components/ui/date-picker";
import { AlertCircle, CheckCircle, Facebook, Loader2 } from "lucide-react";
import { Link } from "wouter";

interface FacebookLeadsImportTabProps {
  onImportSuccess: () => void;
  onCancel: () => void;
}

export function FacebookLeadsImportTab({ onImportSuccess, onCancel }: FacebookLeadsImportTabProps) {
  const { toast } = useToast();
  const [sinceDate, setSinceDate] = useState<Date | undefined>(() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return d;
  });

  const { data: status, isLoading: isLoadingStatus } = useQuery<{ connected: boolean; pageName?: string }>({
    queryKey: ["/api/integrations/facebook/status"],
  });

  const syncMutation = useMutation({
    mutationFn: async (date?: Date) => {
      const res = await apiRequest("POST", "/api/integrations/facebook/sync-leads", {
        sinceDate: date?.toISOString(),
      });
      const data = await res.json();
      if (!res.ok) throw data;
      return data;
    },
    onSuccess: (data) => {
      toast({
        title: "Facebook Sync Complete",
        description: `Imported ${data.imported} new leads, skipped ${data.skipped} duplicates.`,
      });
      onImportSuccess();
    },
    onError: (error: any) => {
      const fbDetail = error?.detail;
      const code = error?.code;
      let description = error?.message || "Failed to sync leads from Facebook";
      if (fbDetail) {
        description = fbDetail;
        if (code === 100) {
          description += " — Go to Meta Business Manager → Lead Access and assign this app as a CRM for your page.";
        } else if (code === 200) {
          description += " — Check that your Meta account has admin access to this page.";
        } else if (code === 190) {
          description += " — Your token has expired. Please reconnect Facebook in Settings → Integrations.";
        }
      }
      toast({
        title: "Sync Failed",
        description,
        variant: "destructive",
      });
    },
  });

  if (isLoadingStatus) {
    return (
      <div className="flex items-center justify-center p-8">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!status?.connected) {
    return (
      <div className="space-y-4 py-4">
        <div className="border bg-muted p-4 rounded-md">
          <div className="flex items-center gap-2 mb-2">
            <AlertCircle className="h-4 w-4 text-muted-foreground" />
            <h4 className="font-medium">Facebook Not Connected</h4>
          </div>
          <p className="text-sm text-muted-foreground mb-4">
            Connect your Facebook Page in Settings → Integrations to import leads directly from Facebook Lead Ads.
          </p>
          <Link href="/settings?tab=integrations">
            <Button variant="outline" size="sm">
              Go to Integrations
            </Button>
          </Link>
        </div>
        <div className="flex justify-end">
          <Button variant="outline" onClick={onCancel}>
            Close
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 py-4">
      <div className="border bg-muted/50 p-4 rounded-md">
        <div className="flex items-center gap-2 mb-2">
          <CheckCircle className="h-4 w-4 text-green-600" />
          <h4 className="font-medium">Connected to {status.pageName || "Facebook Page"}</h4>
        </div>
        <p className="text-sm text-muted-foreground">
          Import your latest leads from Facebook Lead Ads. We'll automatically match them with your CRM.
        </p>
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium block">Import leads since</label>
        <DatePicker 
          value={sinceDate} 
          onChange={setSinceDate}
        />
        <p className="text-xs text-muted-foreground">
          Optional: Choose a start date for historical lead import. Defaults to last 30 days.
        </p>
      </div>

      <div className="flex justify-end gap-2 pt-4">
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button 
          onClick={() => syncMutation.mutate(sinceDate)}
          disabled={syncMutation.isPending}
        >
          {syncMutation.isPending ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Fetching Leads...
            </>
          ) : (
            <>
              <Facebook className="mr-2 h-4 w-4" />
              Fetch Leads
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
