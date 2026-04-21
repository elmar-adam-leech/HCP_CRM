import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { AlertTriangle, RefreshCw, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { formatDistanceToNow } from "date-fns";
import type { TaskInstanceWithLead } from "@/components/SalesProcessFollowUpView";

interface SalesProcessNeedsAttentionBannerProps {
  failed: TaskInstanceWithLead[];
  onOpenLead: (leadId: string) => void;
}

export function SalesProcessNeedsAttentionBanner({
  failed,
  onOpenLead,
}: SalesProcessNeedsAttentionBannerProps) {
  const [open, setOpen] = useState(false);
  const { toast } = useToast();

  const retryMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("POST", `/api/sales-process/tasks/${id}/retry`);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Retry scheduled", description: "The task will be retried on the next tick." });
      queryClient.invalidateQueries({ queryKey: ["/api/sales-process/tasks"] });
    },
    onError: (err: Error) => {
      toast({
        title: "Failed to schedule retry",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const skipMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("POST", `/api/sales-process/tasks/${id}/skip`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/sales-process/tasks"] });
    },
  });

  if (failed.length === 0) return null;

  return (
    <>
      <div
        className="flex items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-3"
        data-testid="banner-needs-attention"
      >
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-destructive" />
          <span className="text-sm font-medium">
            {failed.length} auto-send {failed.length === 1 ? "failure" : "failures"} need attention
          </span>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setOpen(true)}
          data-testid="button-open-failed-list"
        >
          Open list
        </Button>
      </div>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
          <SheetHeader>
            <SheetTitle>Failed auto-sends</SheetTitle>
            <SheetDescription>
              These tasks exhausted their retries. Investigate the reason, then retry or skip.
            </SheetDescription>
          </SheetHeader>
          <div className="mt-4 space-y-3">
            {failed.map((task) => (
              <div
                key={task.id}
                className="rounded-md border p-3 space-y-2"
                data-testid={`failed-task-${task.id}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <button
                      onClick={() => onOpenLead(task.lead.contactId)}
                      className="text-sm font-medium hover:underline truncate text-left"
                      data-testid={`failed-task-lead-${task.id}`}
                    >
                      {task.lead.name || "(no name)"}
                    </button>
                    <div className="text-xs text-muted-foreground">
                      {task.actionType} · {task.lead.source || "no source"} ·{" "}
                      {task.completedAt
                        ? `failed ${formatDistanceToNow(new Date(task.completedAt))} ago`
                        : "failed recently"}
                    </div>
                  </div>
                  <Badge variant="destructive" className="shrink-0">
                    {task.attemptCount} {task.attemptCount === 1 ? "attempt" : "attempts"}
                  </Badge>
                </div>
                {task.failureReason && (
                  <div className="text-xs text-muted-foreground bg-muted/40 rounded p-2">
                    {task.failureReason}
                  </div>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => retryMutation.mutate(task.id)}
                    disabled={retryMutation.isPending}
                    data-testid={`button-retry-${task.id}`}
                  >
                    <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                    Retry
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => skipMutation.mutate(task.id)}
                    disabled={skipMutation.isPending}
                    data-testid={`button-skip-${task.id}`}
                  >
                    Skip
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => onOpenLead(task.lead.contactId)}
                    data-testid={`button-open-lead-${task.id}`}
                  >
                    <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
                    Open lead
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
