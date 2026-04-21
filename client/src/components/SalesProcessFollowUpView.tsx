import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { ChevronDown, ChevronRight, Calendar, Settings as SettingsIcon, Phone, MessageSquare, Mail } from "lucide-react";
import { useLocation } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { SalesProcessTaskRow } from "@/components/SalesProcessTaskRow";
import { SalesProcessNeedsAttentionBanner } from "@/components/SalesProcessNeedsAttentionBanner";
import { EmailComposerModal } from "@/components/EmailComposerModal";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import type { SalesProcess, SalesProcessStep, SalesProcessTaskInstance } from "@shared/schema";

export interface TaskInstanceWithLead extends SalesProcessTaskInstance {
  lead: {
    id: string;
    contactId: string;
    status: string;
    source: string | null;
    createdAt: string | null;
    name: string;
    email: string | null;
    phone: string | null;
  };
}

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function startOfTomorrow(): Date {
  const d = startOfToday();
  d.setDate(d.getDate() + 1);
  return d;
}

function endOfDate(daysFromToday: number): Date {
  const d = startOfToday();
  d.setDate(d.getDate() + daysFromToday);
  d.setHours(23, 59, 59, 999);
  return d;
}

function actionIcon(action: string) {
  if (action === "call") return Phone;
  if (action === "text") return MessageSquare;
  return Mail;
}

interface GroupedByStep {
  step: SalesProcessStep | undefined;
  stepKey: string;
  tasks: TaskInstanceWithLead[];
}

function groupTasksByStep(
  tasks: TaskInstanceWithLead[],
  stepsById: Map<string, SalesProcessStep>,
): GroupedByStep[] {
  const groups = new Map<string, GroupedByStep>();
  for (const t of tasks) {
    const step = stepsById.get(t.stepId);
    const key = step
      ? `${String(step.dayOffset).padStart(4, "0")}-${step.actionType}-${step.id}`
      : `__unknown-${t.stepId}`;
    if (!groups.has(key)) {
      groups.set(key, { step, stepKey: key, tasks: [] });
    }
    groups.get(key)!.tasks.push(t);
  }
  // Order: by step's dayOffset, then actionType (call < text < email).
  const actionOrder = { call: 0, text: 1, email: 2 } as const;
  return Array.from(groups.values()).sort((a, b) => {
    if (!a.step && !b.step) return 0;
    if (!a.step) return 1;
    if (!b.step) return -1;
    if (a.step.dayOffset !== b.step.dayOffset) return a.step.dayOffset - b.step.dayOffset;
    return (actionOrder[a.step.actionType] ?? 99) - (actionOrder[b.step.actionType] ?? 99);
  });
}

function StepGroupHeader({ group }: { group: GroupedByStep }) {
  const step = group.step;
  if (!step) {
    return (
      <div className="flex items-center gap-2 px-1 py-2">
        <span className="text-sm font-medium">Other</span>
        <Badge variant="outline" className="text-xs">{group.tasks.length}</Badge>
      </div>
    );
  }
  const Icon = actionIcon(step.actionType);
  const label = `Day ${step.dayOffset} ${step.actionType.charAt(0).toUpperCase() + step.actionType.slice(1)}s`;
  return (
    <div className="flex items-center gap-2 px-1 py-2">
      <Icon className="h-4 w-4 text-muted-foreground" />
      <span className="text-sm font-medium">{label}</span>
      <Badge variant={step.mode === "auto" ? "outline" : "secondary"} className="text-xs">
        {step.mode === "auto" ? "Auto" : "Manual"}
      </Badge>
      <Badge variant="outline" className="text-xs ml-auto">{group.tasks.length}</Badge>
    </div>
  );
}

interface SalesProcessFollowUpViewProps {
  // Optional: lets the page hide the toggle / decide default itself.
  process: SalesProcess | undefined;
  steps: SalesProcessStep[];
  onOpenLead: (leadId: string) => void;
}

export function SalesProcessFollowUpView({
  process,
  steps,
  onOpenLead,
}: SalesProcessFollowUpViewProps) {
  const [, setLocation] = useLocation();
  const { data: currentUserData } = useCurrentUser();
  const contractorName = currentUserData?.user?.contractorName || "";
  const [emailModal, setEmailModal] = useState<{
    isOpen: boolean;
    task?: TaskInstanceWithLead;
    initialContent?: string;
  }>({ isOpen: false });
  const [upcomingOpen, setUpcomingOpen] = useState(false);

  // Pull pending+failed tasks in a 30-day-back / 7-day-ahead window.
  // 30 days back ensures very-overdue items still show in Past Due.
  const fromDate = useMemo(() => {
    const d = startOfToday();
    d.setDate(d.getDate() - 30);
    return d;
  }, []);
  const toDate = useMemo(() => endOfDate(7), []);

  const { data: tasks = [], isLoading } = useQuery<TaskInstanceWithLead[]>({
    queryKey: [
      "/api/sales-process/tasks",
      { withLead: 1, status: "pending,failed", from: fromDate.toISOString(), to: toDate.toISOString() },
    ],
    queryFn: async () => {
      const url = new URL("/api/sales-process/tasks", window.location.origin);
      url.searchParams.set("withLead", "1");
      url.searchParams.set("status", "pending,failed");
      url.searchParams.set("from", fromDate.toISOString());
      url.searchParams.set("to", toDate.toISOString());
      const res = await fetch(url.pathname + url.search, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch sales-process tasks");
      return res.json();
    },
  });

  const { data: completedTodayData } = useQuery<{ count: number }>({
    queryKey: ["/api/sales-process/tasks/completed-count", { since: startOfToday().toISOString() }],
    queryFn: async () => {
      const url = new URL("/api/sales-process/tasks/completed-count", window.location.origin);
      url.searchParams.set("since", startOfToday().toISOString());
      const res = await fetch(url.pathname + url.search, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch completed count");
      return res.json();
    },
  });

  const stepsById = useMemo(() => {
    const m = new Map<string, SalesProcessStep>();
    for (const s of steps) m.set(s.id, s);
    return m;
  }, [steps]);

  const todayStart = startOfToday();
  const tomorrowStart = startOfTomorrow();

  const failed = useMemo(() => tasks.filter((t) => t.status === "failed"), [tasks]);
  const pending = useMemo(() => tasks.filter((t) => t.status === "pending"), [tasks]);

  const pastDue = useMemo(
    () => pending.filter((t) => new Date(t.dueAt) < todayStart),
    [pending, todayStart],
  );
  const today = useMemo(
    () =>
      pending.filter((t) => {
        const d = new Date(t.dueAt);
        return d >= todayStart && d < tomorrowStart;
      }),
    [pending, todayStart, tomorrowStart],
  );
  const upcoming = useMemo(
    () => pending.filter((t) => new Date(t.dueAt) >= tomorrowStart),
    [pending, tomorrowStart],
  );

  const pastDueGroups = useMemo(() => groupTasksByStep(pastDue, stepsById), [pastDue, stepsById]);
  const todayGroups = useMemo(() => groupTasksByStep(today, stepsById), [today, stepsById]);
  const upcomingByDay = useMemo(() => {
    const byDay = new Map<string, TaskInstanceWithLead[]>();
    for (const t of upcoming) {
      const d = new Date(t.dueAt);
      const key = d.toISOString().slice(0, 10);
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key)!.push(t);
    }
    return Array.from(byDay.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([dateKey, items]) => ({
        dateKey,
        groups: groupTasksByStep(items, stepsById),
      }));
  }, [upcoming, stepsById]);

  const handleComposeEmail = (task: TaskInstanceWithLead, prefilledContent?: string) => {
    setEmailModal({ isOpen: true, task, initialContent: prefilledContent });
  };

  if (isLoading) {
    return (
      <div className="space-y-3">
        {[...Array(3)].map((_, i) => (
          <div key={i} className="space-y-2">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-16 w-full" />
          </div>
        ))}
      </div>
    );
  }

  const totalOpen = pastDue.length + today.length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <Badge
            variant="secondary"
            className="text-xs gap-1"
            data-testid="badge-sales-process-name"
          >
            <SettingsIcon className="h-3 w-3" />
            Process: {process?.name || "Sales process"}
          </Badge>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setLocation("/settings?tab=sales-process")}
            data-testid="button-edit-process"
          >
            Edit cadence
          </Button>
        </div>
      </div>

      <SalesProcessNeedsAttentionBanner failed={failed} onOpenLead={onOpenLead} />

      {totalOpen === 0 && pastDue.length === 0 && today.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center">
            <Calendar className="mx-auto h-10 w-10 text-muted-foreground mb-3" />
            <h3 className="text-base font-semibold mb-1">All caught up</h3>
            <p className="text-sm text-muted-foreground">
              {completedTodayData?.count ?? 0} completed today.
            </p>
          </CardContent>
        </Card>
      ) : null}

      {pastDue.length > 0 && (
        <section className="space-y-2" data-testid="section-past-due">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-destructive">
              Past Due
            </h2>
            <Badge variant="destructive" className="text-xs">{pastDue.length}</Badge>
          </div>
          {pastDueGroups.map((group) => (
            <div key={`pd-${group.stepKey}`} className="space-y-2">
              <StepGroupHeader group={group} />
              <div className="space-y-2">
                {group.tasks.map((t) => (
                  <SalesProcessTaskRow
                    key={t.id}
                    task={t}
                    step={group.step}
                    onOpenLead={onOpenLead}
                    onComposeEmail={handleComposeEmail}
                  />
                ))}
              </div>
            </div>
          ))}
        </section>
      )}

      {today.length > 0 && (
        <section className="space-y-2" data-testid="section-today">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold uppercase tracking-wide">Today</h2>
            <Badge variant="secondary" className="text-xs">{today.length}</Badge>
          </div>
          {todayGroups.map((group) => (
            <div key={`td-${group.stepKey}`} className="space-y-2">
              <StepGroupHeader group={group} />
              <div className="space-y-2">
                {group.tasks.map((t) => (
                  <SalesProcessTaskRow
                    key={t.id}
                    task={t}
                    step={group.step}
                    onOpenLead={onOpenLead}
                    onComposeEmail={handleComposeEmail}
                  />
                ))}
              </div>
            </div>
          ))}
        </section>
      )}

      {upcoming.length > 0 && (
        <section className="space-y-2" data-testid="section-upcoming">
          <button
            className="flex items-center gap-2 hover-elevate rounded-md px-2 py-1 -mx-2"
            onClick={() => setUpcomingOpen((v) => !v)}
            data-testid="toggle-upcoming"
          >
            {upcomingOpen ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
            <h2 className="text-sm font-semibold uppercase tracking-wide">Upcoming (next 7 days)</h2>
            <Badge variant="outline" className="text-xs">{upcoming.length}</Badge>
          </button>
          {upcomingOpen && (
            <div className="space-y-3 pl-6">
              {upcomingByDay.map(({ dateKey, groups }) => (
                <div key={dateKey} className="space-y-2">
                  <div className="text-xs font-medium text-muted-foreground">
                    {new Date(dateKey).toLocaleDateString(undefined, {
                      weekday: "long",
                      month: "short",
                      day: "numeric",
                    })}
                  </div>
                  {groups.map((group) => (
                    <div key={`up-${dateKey}-${group.stepKey}`} className="space-y-2">
                      <StepGroupHeader group={group} />
                      <div className="space-y-2">
                        {group.tasks.map((t) => (
                          <SalesProcessTaskRow
                            key={t.id}
                            task={t}
                            step={group.step}
                            onOpenLead={onOpenLead}
                            onComposeEmail={handleComposeEmail}
                          />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </section>
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
    </div>
  );
}
