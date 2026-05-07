import { memo, useState } from "react";
import { Check, Phone, Mail, Bot, Clock, SkipForward, CalendarClock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { CallButton } from "@/components/CallButton";
import { TextButton } from "@/components/TextButton";
import { EmailButton } from "@/components/EmailButton";
import { StepCoachingPopover, hasCoaching, renderTemplate as renderCoaching } from "@/components/StepCoachingPopover";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { formatDistanceToNow, format } from "date-fns";
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
  onComposeEmail: (task: TaskInstanceWithLead, prefilledContent?: string, guidance?: string | null) => void;
}

export const SalesProcessTaskRow = memo(function SalesProcessTaskRow({
  task,
  step,
  onOpenLead,
  onComposeEmail,
}: SalesProcessTaskRowProps) {
  const { toast } = useToast();

  // Optimistic-remove helper shared by Complete and Skip — both immediately
  // drop the task from every cached "/api/sales-process/tasks" list and
  // capture the previous snapshots so we can roll back on error.
  type RemoveContext = { previous: ReadonlyArray<[readonly unknown[], TaskInstanceWithLead[] | undefined]> };
  const optimisticRemove = async (): Promise<RemoveContext> => {
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
  };

  const skipMutation = useMutation<unknown, Error, void, RemoveContext>({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/sales-process/tasks/${task.id}/skip`);
      return res.json();
    },
    onMutate: optimisticRemove,
    onError: (err, _vars, context) => {
      if (context?.previous) {
        for (const [key, data] of context.previous) {
          queryClient.setQueryData(key, data);
        }
      }
      toast({
        title: "Couldn't skip task",
        description: err.message,
        variant: "destructive",
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/sales-process/tasks"] });
    },
  });

  const [reschedOpen, setReschedOpen] = useState(false);
  const [pickedDate, setPickedDate] = useState<Date | undefined>();
  // Inline talk-track panel — toggled on the moment the rep clicks Call so
  // they have the script visible while the dialer is launching. Hidden until
  // a call is initiated and only available when the step has a callScript.
  const [showCallTrack, setShowCallTrack] = useState(false);

  const rescheduleMutation = useMutation<unknown, Error, Date, RemoveContext>({
    mutationFn: async (nextDueAt: Date) => {
      const res = await apiRequest("POST", `/api/sales-process/tasks/${task.id}/reschedule`, {
        dueAt: nextDueAt.toISOString(),
      });
      return res.json();
    },
    // Optimistically drop from any date-bucketed list (Today / Tomorrow /
    // This week) — the new dueAt may move the task into a different bucket
    // entirely, so removing now and refetching is simpler than trying to
    // resort in place.
    onMutate: optimisticRemove,
    onError: (err, _vars, context) => {
      if (context?.previous) {
        for (const [key, data] of context.previous) {
          queryClient.setQueryData(key, data);
        }
      }
      toast({
        title: "Couldn't reschedule task",
        description: err.message,
        variant: "destructive",
      });
    },
    onSuccess: (_data, nextDueAt) => {
      queryClient.invalidateQueries({ queryKey: ["/api/sales-process/tasks"] });
      setReschedOpen(false);
      setPickedDate(undefined);
      toast({
        title: "Task rescheduled",
        description: `Now due ${format(nextDueAt, "PPP p")}`,
      });
    },
  });

  // Quick presets — "later today" snaps to ~3 hours out (capped at 23:59
  // local) so reps can defer a task within the same workday without picking
  // a time. "Tomorrow" and "In 2 days" snap to 9am local — a sensible start
  // of business default.
  const quickToday = (): Date => {
    const d = new Date(Date.now() + 3 * 60 * 60 * 1000);
    const eod = new Date();
    eod.setHours(23, 59, 0, 0);
    return d > eod ? eod : d;
  };
  const quickTomorrow = (): Date => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    return d;
  };
  const quickInDays = (days: number): Date => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    d.setHours(9, 0, 0, 0);
    return d;
  };

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
  const renderedCallTrack = step?.callScript
    ? renderCoaching(step.callScript, vars)
    : "";
  const showCoachingPopover = step ? hasCoaching({
    actionType: step.actionType as "call" | "text" | "email",
    guidance: step.guidance,
    callScript: step.callScript,
    messageTemplate: step.messageTemplate,
  }) : false;

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
        {!isAuto && action === "call" && showCallTrack && renderedCallTrack && (
          <div
            className="text-sm rounded-md border bg-muted/40 p-2 whitespace-pre-wrap"
            data-testid={`task-row-call-track-${task.id}`}
          >
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-1">
              Call talk track
            </div>
            {renderedCallTrack}
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 flex-wrap shrink-0">
        {showCoachingPopover && step && (
          <StepCoachingPopover
            actionType={step.actionType as "call" | "text" | "email"}
            guidance={step.guidance}
            callScript={step.callScript}
            messageTemplate={step.messageTemplate}
            vars={vars}
            testId={`task-row-script-${task.id}`}
          />
        )}
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
            onClickBeforeCall={() => {
              if (action === "call" && renderedCallTrack) setShowCallTrack(true);
            }}
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
            guidance={step?.guidance ?? undefined}
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
              onComposeEmail(task, action === "email" ? renderedTemplate : undefined, step?.guidance)
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
            disabled={completeMutation.isPending || skipMutation.isPending || rescheduleMutation.isPending}
            data-testid={`button-mark-done-${task.id}`}
          >
            <Check className="h-3.5 w-3.5 mr-1.5" />
            Done
          </Button>
        )}
        {!isAuto && (
          <Popover
            open={reschedOpen}
            onOpenChange={(o) => {
              setReschedOpen(o);
              if (!o) setPickedDate(undefined);
            }}
          >
            <PopoverTrigger asChild>
              <Button
                size="sm"
                variant="ghost"
                disabled={completeMutation.isPending || skipMutation.isPending || rescheduleMutation.isPending}
                data-testid={`button-reschedule-${task.id}`}
              >
                <CalendarClock className="h-3.5 w-3.5 mr-1.5" />
                Reschedule
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-auto p-3 space-y-2">
              <div className="text-xs font-medium text-muted-foreground">
                Push this to-do to:
              </div>
              <div className="flex flex-col gap-1">
                <Button
                  size="sm"
                  variant="outline"
                  className="justify-start"
                  onClick={() => rescheduleMutation.mutate(quickToday())}
                  disabled={rescheduleMutation.isPending}
                  data-testid={`button-reschedule-today-${task.id}`}
                >
                  Later today
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="justify-start"
                  onClick={() => rescheduleMutation.mutate(quickTomorrow())}
                  disabled={rescheduleMutation.isPending}
                  data-testid={`button-reschedule-tomorrow-${task.id}`}
                >
                  Tomorrow (9am)
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="justify-start"
                  onClick={() => rescheduleMutation.mutate(quickInDays(2))}
                  disabled={rescheduleMutation.isPending}
                  data-testid={`button-reschedule-2days-${task.id}`}
                >
                  In 2 days
                </Button>
              </div>
              <div className="border-t pt-2 space-y-2">
                <div className="text-xs font-medium text-muted-foreground">
                  Or pick a date:
                </div>
                <Calendar
                  mode="single"
                  selected={pickedDate}
                  onSelect={setPickedDate}
                  disabled={(d) => {
                    const today = new Date();
                    today.setHours(0, 0, 0, 0);
                    return d < today;
                  }}
                  initialFocus
                  data-testid={`calendar-reschedule-${task.id}`}
                />
                <Button
                  size="sm"
                  className="w-full"
                  disabled={!pickedDate || rescheduleMutation.isPending}
                  onClick={() => {
                    if (!pickedDate) return;
                    const d = new Date(pickedDate);
                    d.setHours(9, 0, 0, 0);
                    // If the rep picks "today" and it's already past 9am
                    // local, snap forward (1 hour from now, capped at
                    // 23:59) so the server's future-date guard doesn't
                    // reject the request.
                    const now = new Date();
                    if (d.getTime() < now.getTime()) {
                      const eod = new Date(d);
                      eod.setHours(23, 59, 0, 0);
                      const oneHourOut = new Date(now.getTime() + 60 * 60 * 1000);
                      d.setTime(Math.min(oneHourOut.getTime(), eod.getTime()));
                    }
                    rescheduleMutation.mutate(d);
                  }}
                  data-testid={`button-reschedule-confirm-${task.id}`}
                >
                  {rescheduleMutation.isPending ? "Rescheduling..." : "Reschedule"}
                </Button>
              </div>
            </PopoverContent>
          </Popover>
        )}
        {!isAuto && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => skipMutation.mutate()}
            disabled={completeMutation.isPending || skipMutation.isPending || rescheduleMutation.isPending}
            data-testid={`button-skip-${task.id}`}
          >
            <SkipForward className="h-3.5 w-3.5 mr-1.5" />
            Skip
          </Button>
        )}
      </div>
    </div>
  );
});
