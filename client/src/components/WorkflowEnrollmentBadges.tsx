import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Plus, X, Zap } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useBulkEnrollments } from "@/contexts/WorkflowEnrollmentContext";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

type WorkflowEnrollment = {
  executionId: string;
  workflowId: string;
  workflowName: string;
  status: string;
  currentStep: number | null;
  startedAt: string | null;
};

type WorkflowSummary = {
  id: string;
  name: string;
  approvalStatus: string;
  isActive?: boolean;
};

type WorkflowEnrollmentBadgesProps = {
  contactId: string | undefined | null;
  variant?: "compact" | "full";
};

export function WorkflowEnrollmentBadges({ contactId, variant = "compact" }: WorkflowEnrollmentBadgesProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [confirmCancel, setConfirmCancel] = useState<WorkflowEnrollment | null>(null);

  const bulkData = useBulkEnrollments();
  const hasBulkData = bulkData !== null;

  const { data: individualEnrollments = [] } = useQuery<WorkflowEnrollment[]>({
    queryKey: ['/api/contacts', contactId, 'workflow-enrollments'],
    queryFn: async () => {
      const r = await fetch(`/api/contacts/${contactId}/workflow-enrollments`, {
        credentials: "include",
      });
      if (r.status === 429) {
        const body = await r.json().catch(() => ({}));
        const { RateLimitError } = await import("@/lib/queryClient");
        throw new RateLimitError(body.retryAfter ?? 60, "Rate limited");
      }
      if (!r.ok) return [];
      return r.json();
    },
    enabled: !!contactId && !hasBulkData,
    staleTime: 30_000,
  });

  const enrollments: WorkflowEnrollment[] = hasBulkData
    ? (contactId ? bulkData[contactId] ?? [] : [])
    : individualEnrollments;

  const cancelMutation = useMutation({
    mutationFn: (executionId: string) =>
      apiRequest('POST', `/api/workflow-executions/${executionId}/cancel`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/contacts', contactId, 'workflow-enrollments'] });
      queryClient.invalidateQueries({ queryKey: ['/api/contacts/bulk/workflow-enrollments'] });
      toast({ title: "Workflow stopped", description: "The contact has been removed from the workflow." });
      setConfirmCancel(null);
    },
    onError: () => {
      toast({ title: "Failed to stop workflow", variant: "destructive" });
      setConfirmCancel(null);
    },
  });

  if (!contactId) return null;

  if (variant === "compact") {
    if (enrollments.length === 0) return null;
    return (
      <>
        <div className="flex flex-wrap gap-1">
          {enrollments.map((enrollment) => (
            <Badge
              key={enrollment.executionId}
              variant="secondary"
              className="text-xs flex items-center gap-1 cursor-pointer"
              data-testid={`badge-workflow-enrollment-${enrollment.executionId}`}
              onClick={(e) => {
                e.stopPropagation();
                setConfirmCancel(enrollment);
              }}
            >
              <Zap className="h-3 w-3" />
              <span className="truncate max-w-[120px]">{enrollment.workflowName}</span>
              <X className="h-3 w-3 opacity-60" />
            </Badge>
          ))}
        </div>
        <CancelDialog
          enrollment={confirmCancel}
          isPending={cancelMutation.isPending}
          onConfirm={(id) => cancelMutation.mutate(id)}
          onCancel={() => setConfirmCancel(null)}
        />
      </>
    );
  }

  return (
    <>
      <div className="space-y-2">
        {enrollments.length === 0 ? (
          <p className="text-sm text-muted-foreground">No active workflow enrollments</p>
        ) : (
          enrollments.map((enrollment) => (
            <div
              key={enrollment.executionId}
              className="flex items-center justify-between gap-2 p-2 rounded-md border"
              data-testid={`enrollment-row-${enrollment.executionId}`}
            >
              <div className="flex items-center gap-2 min-w-0">
                <Zap className="h-4 w-4 text-muted-foreground shrink-0" />
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{enrollment.workflowName}</p>
                  <p className="text-xs text-muted-foreground capitalize">{enrollment.status}</p>
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setConfirmCancel(enrollment)}
                data-testid={`button-stop-enrollment-${enrollment.executionId}`}
              >
                Stop
              </Button>
            </div>
          ))
        )}
        <AddToWorkflowPicker
          contactId={contactId}
          enrolledWorkflowIds={enrollments.map((e) => e.workflowId)}
        />
      </div>
      <CancelDialog
        enrollment={confirmCancel}
        isPending={cancelMutation.isPending}
        onConfirm={(id) => cancelMutation.mutate(id)}
        onCancel={() => setConfirmCancel(null)}
      />
    </>
  );
}

function AddToWorkflowPicker({
  contactId,
  enrolledWorkflowIds,
}: {
  contactId: string;
  enrolledWorkflowIds: string[];
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const { data: workflows = [], isLoading } = useQuery<WorkflowSummary[]>({
    queryKey: ['/api/workflows', { approvalStatus: 'approved' }],
    queryFn: async () => {
      const r = await fetch(`/api/workflows?approvalStatus=approved`, {
        credentials: 'include',
      });
      if (!r.ok) return [];
      return r.json();
    },
    enabled: open,
    staleTime: 30_000,
  });

  const enrollMutation = useMutation({
    mutationFn: async (workflowId: string) => {
      const r = await apiRequest('POST', `/api/workflows/${workflowId}/execute`, {
        triggerData: { id: contactId, entityType: 'contact' },
      });
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/contacts', contactId, 'workflow-enrollments'] });
      queryClient.invalidateQueries({ queryKey: ['/api/contacts/bulk/workflow-enrollments'] });
      toast({ title: "Added to workflow", description: "The contact has been enrolled." });
      setOpen(false);
      setSearch("");
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : "Please try again.";
      toast({ title: "Failed to add to workflow", description: message, variant: "destructive" });
    },
  });

  const enrolledSet = useMemo(() => new Set(enrolledWorkflowIds), [enrolledWorkflowIds]);
  const eligible = useMemo(() => {
    const term = search.trim().toLowerCase();
    return workflows
      .filter((w) => w.approvalStatus === 'approved' && !enrolledSet.has(w.id))
      .filter((w) => (term ? w.name.toLowerCase().includes(term) : true));
  }, [workflows, enrolledSet, search]);

  return (
    <Popover open={open} onOpenChange={(next) => { setOpen(next); if (!next) setSearch(""); }}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          data-testid="button-add-to-workflow"
        >
          <Plus className="h-4 w-4 mr-1" />
          Add to workflow
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-2" align="start">
        <div className="space-y-2">
          <Input
            placeholder="Search workflows..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            data-testid="input-workflow-picker-search"
            autoFocus
          />
          <ScrollArea className="h-56">
            {isLoading ? (
              <p className="text-xs text-muted-foreground p-2">Loading...</p>
            ) : eligible.length === 0 ? (
              <p className="text-xs text-muted-foreground p-2" data-testid="text-no-eligible-workflows">
                {workflows.length === 0
                  ? "No approved workflows available."
                  : "No workflows match your search or all approved workflows are already active for this contact."}
              </p>
            ) : (
              <div className="space-y-1">
                {eligible.map((w) => (
                  <button
                    key={w.id}
                    type="button"
                    disabled={enrollMutation.isPending}
                    onClick={() => enrollMutation.mutate(w.id)}
                    className="w-full text-left text-sm rounded-md px-2 py-1.5 hover-elevate active-elevate-2 disabled:opacity-50"
                    data-testid={`button-enroll-workflow-${w.id}`}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <Zap className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      <span className="truncate">{w.name}</span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </ScrollArea>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function CancelDialog({
  enrollment,
  isPending,
  onConfirm,
  onCancel,
}: {
  enrollment: WorkflowEnrollment | null;
  isPending: boolean;
  onConfirm: (executionId: string) => void;
  onCancel: () => void;
}) {
  return (
    <AlertDialog open={!!enrollment} onOpenChange={(open) => { if (!open) onCancel(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Stop workflow?</AlertDialogTitle>
          <AlertDialogDescription>
            This will remove the contact from the "{enrollment?.workflowName}" workflow. Any remaining steps will not be executed.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={isPending}
            onClick={() => enrollment && onConfirm(enrollment.executionId)}
          >
            {isPending ? "Stopping..." : "Stop Workflow"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
