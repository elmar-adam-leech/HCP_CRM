import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { ListChecks } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { SalesProcessTaskRow } from "@/components/SalesProcessTaskRow";
import { EmailComposerModal } from "@/components/EmailComposerModal";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useState } from "react";
import { queryClient } from "@/lib/queryClient";
import type { TaskInstanceWithLead } from "@/components/SalesProcessFollowUpView";
import type { SalesProcess, SalesProcessStep } from "@shared/schema";

interface LeadSalesProcessTasksProps {
  contactId: string;
}

/**
 * Inline list of pending sales-process to-dos shown on the Lead detail
 * (LeadDetailsModal). Filters by `contactId` rather than a single
 * `leadId` because a contact can have multiple lead submissions over
 * time (re-engagements, second jobs) and reps want to see every open
 * cadence touchpoint for this customer in one place — not just the
 * most recent submission's. The server still tenant-scopes by
 * contractorId.
 */
export function LeadSalesProcessTasks({ contactId }: LeadSalesProcessTasksProps) {
  const { data: currentUserData } = useCurrentUser();
  const contractorName = currentUserData?.user?.contractorName || "";
  const [emailModal, setEmailModal] = useState<{
    isOpen: boolean;
    task?: TaskInstanceWithLead;
    initialContent?: string;
  }>({ isOpen: false });

  // Pull the cadence so we can show step names and pre-render templates.
  // If the tenant has no active process, the tasks query simply returns
  // nothing and we render the empty state below.
  const { data: salesProcessData } = useQuery<{ process: SalesProcess; steps: SalesProcessStep[] }>({
    queryKey: ["/api/sales-process"],
  });
  const steps = salesProcessData?.steps ?? [];
  const stepsById = useMemo(() => {
    const m = new Map<string, SalesProcessStep>();
    for (const s of steps) m.set(s.id, s);
    return m;
  }, [steps]);

  const { data: tasks = [], isLoading } = useQuery<TaskInstanceWithLead[]>({
    queryKey: [
      "/api/sales-process/tasks",
      { withLead: 1, contactId, status: "pending,failed" },
    ],
    queryFn: async () => {
      const url = new URL("/api/sales-process/tasks", window.location.origin);
      url.searchParams.set("withLead", "1");
      url.searchParams.set("contactId", contactId);
      url.searchParams.set("status", "pending,failed");
      const res = await fetch(url.pathname + url.search, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch sales-process tasks");
      return res.json();
    },
  });

  // Sort by dueAt ascending so the most urgent appears first.
  const ordered = useMemo(
    () => [...tasks].sort((a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime()),
    [tasks],
  );

  const handleComposeEmail = (task: TaskInstanceWithLead, prefilledContent?: string) => {
    setEmailModal({ isOpen: true, task, initialContent: prefilledContent });
  };

  return (
    <section data-testid="lead-sales-process-tasks">
      <div className="flex items-center justify-between gap-2 mb-3">
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-2">
          <ListChecks className="h-4 w-4" />
          Sales Process To-Dos
        </h3>
        {ordered.length > 0 && (
          <Badge variant="outline" className="text-xs" data-testid="badge-lead-tasks-count">
            {ordered.length}
          </Badge>
        )}
      </div>

      {isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : ordered.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="text-no-sales-process-tasks">
          No pending to-dos for this lead.
        </p>
      ) : (
        <div className="space-y-2">
          {ordered.map((t) => (
            <SalesProcessTaskRow
              key={t.id}
              task={t}
              step={stepsById.get(t.stepId)}
              // We're already on the lead's detail; clicking the name is a
              // no-op rather than re-opening the same modal.
              onOpenLead={() => {}}
              onComposeEmail={handleComposeEmail}
            />
          ))}
        </div>
      )}

      {emailModal.task && (
        <EmailComposerModal
          isOpen={emailModal.isOpen}
          onClose={() => setEmailModal({ isOpen: false })}
          recipientName={emailModal.task.lead.name}
          recipientEmail={emailModal.task.lead.email || ""}
          recipientPhone={emailModal.task.lead.phone || ""}
          companyName={contractorName}
          contactId={emailModal.task.lead.contactId}
          leadId={emailModal.task.lead.id}
          initialContent={emailModal.initialContent}
          onSent={() => {
            queryClient.invalidateQueries({ queryKey: ["/api/sales-process/tasks"] });
          }}
        />
      )}
    </section>
  );
}
