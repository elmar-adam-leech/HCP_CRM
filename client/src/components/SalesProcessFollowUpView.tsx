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

export interface TaskInstanceWithEstimate extends SalesProcessTaskInstance {
  estimate: {
    id: string;
    contactId: string;
    status: string;
    title: string | null;
    estimateNumber: string | null;
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
  // All active cadences for the contractor — every active cadence
  // contributes tasks (and a name in the header). Empty array means there
  // are no active cadences (the page should normally hide the toggle in
  // that case, but we render a helpful empty-state regardless).
  cadences: SalesProcess[];
  // Steps from EVERY active cadence, flattened. Used to build a single
  // stepsById map so tasks group correctly under their owning step
  // regardless of which cadence they came from.
  steps: SalesProcessStep[];
  onOpenLead: (leadId: string) => void;
}

export function SalesProcessFollowUpView({
  cadences,
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

  // Estimate-anchored manual tasks (e.g. "follow up after Approved
  // estimate"). Fetched in parallel with the lead-anchored query so the
  // page renders both lists in one round-trip without re-running.
  const { data: estimateTasks = [] } = useQuery<TaskInstanceWithEstimate[]>({
    queryKey: [
      "/api/sales-process/tasks",
      { withEstimate: 1, status: "pending,failed", from: fromDate.toISOString(), to: toDate.toISOString() },
    ],
    queryFn: async () => {
      const url = new URL("/api/sales-process/tasks", window.location.origin);
      url.searchParams.set("withEstimate", "1");
      url.searchParams.set("status", "pending,failed");
      url.searchParams.set("from", fromDate.toISOString());
      url.searchParams.set("to", toDate.toISOString());
      const res = await fetch(url.pathname + url.search, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch sales-process estimate tasks");
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

  // Upcoming tasks let us tell the user "your next step is on {date}" so an
  // empty Today/Past Due view doesn't look broken when a cadence is just
  // waiting out its Day-N delay.
  const nextUpcoming = useMemo(() => {
    if (upcoming.length === 0) return undefined;
    return upcoming.reduce((earliest, t) =>
      new Date(t.dueAt) < new Date(earliest.dueAt) ? t : earliest,
    );
  }, [upcoming]);

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
            {cadences.length === 0
              ? "No active cadences"
              : cadences.length === 1
                ? `Process: ${cadences[0].name}`
                : `${cadences.length} active cadences`}
          </Badge>
          {cadences.length > 1 && (
            <span
              className="text-xs text-muted-foreground truncate max-w-[24rem]"
              data-testid="text-active-cadence-names"
            >
              {cadences.map(c => c.name).join(" · ")}
            </span>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setLocation("/settings?tab=sales-process")}
            data-testid="button-edit-process"
          >
            Edit cadences
          </Button>
        </div>
      </div>

      <SalesProcessNeedsAttentionBanner failed={failed} onOpenLead={onOpenLead} />

      {totalOpen === 0 && pastDue.length === 0 && today.length === 0 && estimateTasks.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center space-y-3">
            <Calendar className="mx-auto h-10 w-10 text-muted-foreground" />
            <h3 className="text-base font-semibold">Nothing due right now</h3>
            <div className="text-sm text-muted-foreground space-y-2 max-w-md mx-auto">
              {cadences.length === 0 ? (
                <p>
                  You don't have any active cadences yet. Turn one on in
                  Settings → Sales Process to start scheduling automatic
                  follow-ups for new leads and estimates.
                </p>
              ) : nextUpcoming ? (
                <p>
                  Your next step is due on{" "}
                  <span className="font-medium text-foreground">
                    {new Date(nextUpcoming.dueAt).toLocaleDateString(undefined, {
                      weekday: "long", month: "short", day: "numeric",
                    })}
                  </span>
                  . Manual steps stay quiet until their Day-N delay arrives —
                  for example a Day 1 Call won't show up until 24 hours after
                  the lead is created.
                </p>
              ) : (
                <>
                  <p>
                    No tasks are scheduled in the next 7 days. A few common
                    reasons:
                  </p>
                  <ul className="list-disc list-inside text-left space-y-1">
                    <li>No new leads or estimates have matched a cadence trigger yet.</li>
                    <li>
                      Existing leads were already past <em>Open</em> when the
                      cadence was activated, so they were skipped.
                    </li>
                    <li>
                      Manual steps are waiting out their Day-N delay (a Day 1
                      step appears 24 hours after the trigger).
                    </li>
                  </ul>
                </>
              )}
              <p>
                {completedTodayData?.count ?? 0} completed today.{" "}
                <button
                  type="button"
                  className="underline hover:text-foreground"
                  onClick={() => setLocation("/settings?tab=sales-process")}
                  data-testid="link-empty-state-settings"
                >
                  Manage cadences in Settings
                </button>
                .
              </p>
            </div>
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

      {estimateTasks.length > 0 && (
        <section className="space-y-2" data-testid="section-estimate-tasks">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold uppercase tracking-wide">Estimate follow-ups</h2>
            <Badge variant="secondary" className="text-xs">{estimateTasks.length}</Badge>
          </div>
          <div className="space-y-2">
            {estimateTasks.map((t) => {
              const step = stepsById.get(t.stepId);
              const Icon = actionIcon(t.actionType);
              const dueLabel = new Date(t.dueAt).toLocaleDateString(undefined, {
                month: "short", day: "numeric",
              });
              return (
                <Card key={t.id} data-testid={`card-estimate-task-${t.id}`}>
                  <CardContent className="p-3 flex items-center gap-3 flex-wrap">
                    <Icon className="h-4 w-4 text-muted-foreground" />
                    <div className="flex flex-col min-w-0">
                      <button
                        className="text-sm font-medium text-left hover:underline"
                        onClick={() => onOpenLead(t.estimate.contactId)}
                        data-testid={`button-open-contact-${t.id}`}
                      >
                        {t.estimate.name || "(no name)"}
                      </button>
                      <span className="text-xs text-muted-foreground">
                        {t.estimate.estimateNumber
                          ? `Estimate #${t.estimate.estimateNumber}`
                          : (t.estimate.title ?? "Estimate")} · {t.estimate.status}
                      </span>
                    </div>
                    <Badge variant="outline" className="text-xs ml-auto">
                      {step ? `Day ${step.dayOffset} ${step.actionType}` : t.actionType}
                    </Badge>
                    <Badge variant="secondary" className="text-xs">{dueLabel}</Badge>
                    <Button
                      size="sm"
                      variant="outline"
                      data-testid={`button-complete-estimate-task-${t.id}`}
                      onClick={async () => {
                        await fetch(`/api/sales-process/tasks/${t.id}/complete`, {
                          method: "POST",
                          credentials: "include",
                        });
                        queryClient.invalidateQueries({ queryKey: ["/api/sales-process/tasks"] });
                      }}
                    >
                      Mark complete
                    </Button>
                  </CardContent>
                </Card>
              );
            })}
          </div>
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
