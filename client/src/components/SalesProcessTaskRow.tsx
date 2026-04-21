import { memo } from "react";
import { Check, Phone, Mail, Bot, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CallButton } from "@/components/CallButton";
import { TextButton } from "@/components/TextButton";
import { EmailButton } from "@/components/EmailButton";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { formatDistanceToNow } from "date-fns";
import type { TaskInstanceWithLead } from "@/components/SalesProcessFollowUpView";
import type { SalesProcessStep } from "@shared/schema";

function renderTemplate(template: string, vars: Record<string, string>): string {
  return template
    .replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, key) => vars[key] ?? "")
    .replace(/\{(\w+)\}/g, (_m, key) => vars[key] ?? "");
}

interface SalesProcessTaskRowProps {
  task: TaskInstanceWithLead;
  step: SalesProcessStep | undefined;
  onOpenLead: (leadId: string) => void;
  onComposeEmail: (task: TaskInstanceWithLead, prefilledContent?: string) => void;
}

export const SalesProcessTaskRow = memo(function SalesProcessTaskRow({
  task,
  step,
  onOpenLead,
  onComposeEmail,
}: SalesProcessTaskRowProps) {
  const { toast } = useToast();

  const completeMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/sales-process/tasks/${task.id}/complete`);
      return res.json();
    },
    onMutate: async () => {
      // Optimistic remove from the pending list.
      await queryClient.cancelQueries({ queryKey: ["/api/sales-process/tasks"] });
      const previous = queryClient.getQueriesData<TaskInstanceWithLead[]>({
        queryKey: ["/api/sales-process/tasks"],
      });
      previous.forEach(([key, data]) => {
        if (Array.isArray(data)) {
          queryClient.setQueryData(
            key,
            data.filter((t) => t.id !== task.id),
          );
        }
      });
      return { previous };
    },
    onError: (err: Error, _vars, context) => {
      // Rollback.
      if (context?.previous) {
        for (const [key, data] of context.previous) {
          queryClient.setQueryData(key, data);
        }
      }
      toast({
        title: "Couldn't mark done",
        description: err.message,
        variant: "destructive",
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/sales-process/tasks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/sales-process/tasks/completed-count"] });
    },
  });

  const lead = task.lead;
  const ageLabel = lead.createdAt
    ? `${formatDistanceToNow(new Date(lead.createdAt))} ago`
    : "—";

  const isAuto = task.mode === "auto";
  const action = task.actionType;

  // Build template vars from lead summary so a manual SMS/email gets the
  // step's templated message pre-rendered.
  const [first, ...rest] = (lead.name || "").split(/\s+/);
  const vars: Record<string, string> = {
    first_name: first ?? "",
    last_name: rest.join(" "),
    full_name: lead.name ?? "",
    email: lead.email ?? "",
    phone: lead.phone ?? "",
    lead_source: lead.source ?? "",
  };
  const renderedTemplate = step?.messageTemplate
    ? renderTemplate(step.messageTemplate, vars)
    : "";

  return (
    <div
      className="flex flex-col sm:flex-row sm:items-center gap-3 rounded-md border p-3 hover-elevate"
      data-testid={`task-row-${task.id}`}
    >
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => onOpenLead(lead.contactId)}
            className="text-sm font-medium hover:underline truncate text-left"
            data-testid={`task-row-lead-${task.id}`}
          >
            {lead.name || "(no name)"}
          </button>
          {lead.source && (
            <Badge variant="secondary" className="text-xs">
              {lead.source}
            </Badge>
          )}
          {isAuto && (
            <Badge variant="outline" className="text-xs gap-1">
              <Bot className="h-3 w-3" />
              Auto
            </Badge>
          )}
          <span className="text-xs text-muted-foreground flex items-center gap-1">
            <Clock className="h-3 w-3" />
            {ageLabel}
          </span>
        </div>
        <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
          {lead.phone && (
            <span className="inline-flex items-center gap-1">
              <Phone className="h-3 w-3" />
              {lead.phone}
            </span>
          )}
          {lead.email && (
            <span className="inline-flex items-center gap-1 truncate">
              <Mail className="h-3 w-3" />
              {lead.email}
            </span>
          )}
        </div>
        {isAuto && renderedTemplate && (
          <div
            className="text-xs text-muted-foreground bg-muted/40 rounded p-2 whitespace-pre-wrap"
            data-testid={`task-row-auto-template-${task.id}`}
          >
            {renderedTemplate}
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 flex-wrap shrink-0">
        {/* For manual steps we render every channel that the lead has
            contact info for (so users can pick whatever feels right) and
            highlight the prescribed channel as the default-variant button.
            Auto steps render no action buttons — they're read-only. */}
        {!isAuto && lead.phone && (
          <CallButton
            recipientName={lead.name}
            recipientPhone={lead.phone}
            leadId={lead.id}
            variant={action === "call" ? "default" : "outline"}
            size="sm"
            onCallCompleted={() => {
              queryClient.invalidateQueries({ queryKey: ["/api/sales-process/tasks"] });
            }}
          />
        )}
        {!isAuto && lead.phone && (
          <TextButton
            recipientName={lead.name}
            recipientPhone={lead.phone}
            leadId={lead.id}
            contactId={lead.contactId}
            recipientEmail={lead.email ?? undefined}
            source={lead.source ?? undefined}
            status={lead.status}
            variant={action === "text" ? "default" : "outline"}
            size="sm"
            initialMessage={action === "text" ? renderedTemplate : undefined}
            onSent={() => {
              queryClient.invalidateQueries({ queryKey: ["/api/sales-process/tasks"] });
            }}
          />
        )}
        {!isAuto && lead.email && (
          <EmailButton
            recipientName={lead.name}
            recipientEmail={lead.email}
            leadId={lead.id}
            onSendEmail={() =>
              onComposeEmail(task, action === "email" ? renderedTemplate : undefined)
            }
            variant={action === "email" ? "default" : "outline"}
            size="sm"
            forceInAppCompose
          />
        )}
        {!isAuto && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => completeMutation.mutate()}
            disabled={completeMutation.isPending}
            data-testid={`button-mark-done-${task.id}`}
          >
            <Check className="h-3.5 w-3.5 mr-1.5" />
            Done
          </Button>
        )}
      </div>
    </div>
  );
});
