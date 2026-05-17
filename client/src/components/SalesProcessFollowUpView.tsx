import { useCallback, useMemo, useState } from "react";
import { useQuery, keepPreviousData, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { ChevronDown, ChevronRight, Calendar, Settings as SettingsIcon, Phone, MessageSquare, Mail, Check, SkipForward, X } from "lucide-react";
import { useLocation } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import {
  SalesProcessTaskRow,
  scheduleSalesProcessTasksRefetch,
  scheduleCompletedCountRefetch,
} from "@/components/SalesProcessTaskRow";
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

const BUCKET_PAGE_SIZE = 50;

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

/**
 * Bucket-header "select all in bucket" checkbox. Reflects three states:
 *   - empty   → none of this bucket's currently-rendered rows are selected
 *   - checked → every currently-rendered row in this bucket is selected
 *   - "indeterminate" (visually a checked-but-different look from Radix) →
 *     some but not all rows are selected
 * Toggling flips the entire visible bucket; rows hidden behind "Show more"
 * are deliberately NOT touched (the user can't see them, so a single click
 * silently sweeping in 150 unseen rows would be surprising).
 */
function BucketSelectAll({
  tasks,
  selectedIds,
  onChange,
  testId,
}: {
  tasks: { id: string }[];
  selectedIds: Set<string>;
  onChange: (ids: string[], on: boolean) => void;
  testId: string;
}) {
  if (tasks.length === 0) return null;
  const ids = tasks.map((t) => t.id);
  const selectedCount = ids.reduce((n, id) => (selectedIds.has(id) ? n + 1 : n), 0);
  const allSelected = selectedCount === ids.length;
  const someSelected = selectedCount > 0 && !allSelected;
  return (
    <Checkbox
      checked={allSelected ? true : someSelected ? "indeterminate" : false}
      onCheckedChange={(v) => onChange(ids, v === true)}
      aria-label="Select all in bucket"
      data-testid={testId}
    />
  );
}

interface SalesProcessFollowUpViewProps {
  cadences: SalesProcess[];
  steps: SalesProcessStep[];
  onOpenLead: (leadId: string) => void;
}

/**
 * Hook helper: paged fetch for one bucket of pending lead-anchored tasks
 * within `from`/`to`. We always request from offset 0; the user grows
 * `shown` via "Show more" rather than flipping pages, so each bucket
 * keeps a single accumulating list rendered in the DOM at one time.
 *
 * `paged=1` opts into the `{ items, total, hasMore }` envelope server-side.
 */
function useBucketQuery(opts: {
  bucket: string;
  from?: Date;
  to?: Date;
  shown: number;
  enabled?: boolean;
}) {
  const { bucket, from, to, shown, enabled = true } = opts;
  return useQuery<{ items: TaskInstanceWithLead[]; total: number; hasMore: boolean }>({
    queryKey: [
      "/api/sales-process/tasks",
      {
        withLead: 1,
        status: "pending",
        from: from?.toISOString() ?? null,
        to: to?.toISOString() ?? null,
        paged: 1,
        limit: shown,
        offset: 0,
        bucket,
      },
    ],
    queryFn: async () => {
      const url = new URL("/api/sales-process/tasks", window.location.origin);
      url.searchParams.set("withLead", "1");
      url.searchParams.set("status", "pending");
      url.searchParams.set("paged", "1");
      url.searchParams.set("limit", String(shown));
      url.searchParams.set("offset", "0");
      if (from) url.searchParams.set("from", from.toISOString());
      if (to) url.searchParams.set("to", to.toISOString());
      const res = await fetch(url.pathname + url.search, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch sales-process tasks");
      return res.json();
    },
    enabled,
    placeholderData: keepPreviousData,
  });
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
    guidance?: string;
  }>({ isOpen: false });
  const [upcomingOpen, setUpcomingOpen] = useState(false);
  const { toast } = useToast();

  // Bulk-selection state — a single Set across every bucket so reps can
  // sweep up "all my past-due AND today's call follow-ups" in one go. We
  // store IDs rather than tasks so optimistically-removed rows fall out
  // naturally when their query data updates.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const setRowSelected = useCallback((id: string, on: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  const setManySelected = useCallback((ids: string[], on: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }, []);
  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  // Bulk mutations — POST a single array of IDs to the new bulk endpoints.
  // We optimistically remove every selected row from every cached
  // "/api/sales-process/tasks" list before the request goes out, so a
  // 200-row sweep clears the UI in one paint and re-syncs once when the
  // bulk response arrives. We re-use the same debounced refetch pattern
  // as single-row mutations so a click on Skip/Done elsewhere on the
  // page doesn't trigger a refetch storm.
  type BulkResp = {
    results: Array<{ id: string; ok: boolean; error?: string }>;
    succeeded: number;
    failed: number;
  };
  type BulkCtx = { previous: ReadonlyArray<[readonly unknown[], unknown]>; ids: string[] };

  const bulkOptimisticRemove = useCallback(async (ids: string[]): Promise<BulkCtx> => {
    await queryClient.cancelQueries({ queryKey: ["/api/sales-process/tasks"] });
    const previous = queryClient.getQueriesData({ queryKey: ["/api/sales-process/tasks"] });
    const idSet = new Set(ids);
    for (const [key, data] of previous) {
      if (Array.isArray(data)) {
        queryClient.setQueryData(
          key,
          (data as TaskInstanceWithLead[]).filter((t) => !idSet.has(t.id)),
        );
      } else if (data && typeof data === 'object' && 'items' in (data as Record<string, unknown>)) {
        const env = data as { items: TaskInstanceWithLead[]; total: number; hasMore: boolean };
        if (Array.isArray(env.items)) {
          const removed = env.items.filter((t) => idSet.has(t.id)).length;
          queryClient.setQueryData(key, {
            ...env,
            items: env.items.filter((t) => !idSet.has(t.id)),
            total: Math.max(0, (env.total ?? 0) - removed),
          });
        }
      }
    }
    return { previous, ids };
  }, []);

  const rollbackBulk = useCallback((ctx: BulkCtx | undefined) => {
    if (!ctx) return;
    for (const [key, data] of ctx.previous) {
      queryClient.setQueryData(key, data);
    }
  }, []);

  // Reuse the SAME debounced refetch wave that single-row Skip / Done /
  // Reschedule mutations use (see task #746). A bulk action immediately
  // followed by a single-row click should still coalesce into one
  // background refetch ~1s after the last click instead of triggering
  // an immediate full-page refetch on top of the per-row debounce.
  const bulkResync = useCallback(() => {
    queryClient.invalidateQueries({
      queryKey: ["/api/sales-process/tasks"],
      refetchType: "none",
    });
    scheduleSalesProcessTasksRefetch();
    queryClient.invalidateQueries({
      queryKey: ["/api/sales-process/tasks/completed-count"],
      refetchType: "none",
    });
    scheduleCompletedCountRefetch();
  }, []);

  const bulkSkipMutation = useMutation<BulkResp, Error, string[], BulkCtx>({
    mutationFn: async (ids) => {
      const res = await apiRequest("POST", "/api/sales-process/tasks/bulk-skip", { ids });
      return res.json();
    },
    onMutate: bulkOptimisticRemove,
    onError: (err, _ids, ctx) => {
      rollbackBulk(ctx);
      toast({ title: "Couldn't skip tasks", description: err.message, variant: "destructive" });
    },
    onSuccess: (data) => {
      clearSelection();
      bulkResync();
      if (data.failed > 0) {
        toast({
          title: `Skipped ${data.succeeded} task${data.succeeded === 1 ? '' : 's'}`,
          description: `${data.failed} couldn't be skipped (already cleared or not found).`,
        });
      } else {
        toast({ title: `Skipped ${data.succeeded} task${data.succeeded === 1 ? '' : 's'}` });
      }
    },
  });

  const bulkCompleteMutation = useMutation<BulkResp, Error, string[], BulkCtx>({
    mutationFn: async (ids) => {
      const res = await apiRequest("POST", "/api/sales-process/tasks/bulk-complete", { ids });
      return res.json();
    },
    onMutate: bulkOptimisticRemove,
    onError: (err, _ids, ctx) => {
      rollbackBulk(ctx);
      toast({ title: "Couldn't mark tasks done", description: err.message, variant: "destructive" });
    },
    onSuccess: (data) => {
      clearSelection();
      bulkResync();
      if (data.failed > 0) {
        toast({
          title: `Marked ${data.succeeded} done`,
          description: `${data.failed} couldn't be completed (already cleared or not found).`,
        });
      } else {
        toast({ title: `Marked ${data.succeeded} done` });
      }
    },
  });

  const bulkPending = bulkSkipMutation.isPending || bulkCompleteMutation.isPending;
  const runBulkSkip = useCallback(() => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0 || bulkPending) return;
    bulkSkipMutation.mutate(ids);
  }, [selectedIds, bulkPending, bulkSkipMutation]);
  const runBulkComplete = useCallback(() => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0 || bulkPending) return;
    bulkCompleteMutation.mutate(ids);
  }, [selectedIds, bulkPending, bulkCompleteMutation]);

  // Bucket date windows. Past Due reaches 30 days back to surface very-old
  // overdue items; Today is the standard 0:00–24:00 window; Upcoming is
  // the next-7-days lookahead so users can see what's queued.
  const pastDueRange = useMemo(() => {
    const from = new Date(); from.setHours(0, 0, 0, 0); from.setDate(from.getDate() - 30);
    return { from, to: startOfToday() };
  }, []);
  const todayRange = useMemo(() => ({ from: startOfToday(), to: startOfTomorrow() }), []);
  // Tomorrow gets its own bucket so the user can see "what's queued for
  // tomorrow" independently of the wider lookahead. Upcoming covers
  // day-after-tomorrow through +7 days and stays grouped-by-day inside.
  const tomorrowRange = useMemo(() => {
    const from = startOfTomorrow();
    const to = new Date(from); to.setDate(to.getDate() + 1);
    return { from, to };
  }, []);
  const upcomingRange = useMemo(() => {
    const from = new Date(startOfTomorrow()); from.setDate(from.getDate() + 1);
    const to = new Date(); to.setHours(0, 0, 0, 0); to.setDate(to.getDate() + 8);
    return { from, to };
  }, []);
  // Window for the failed banner + estimate-anchored tasks: 30 back / 7 ahead.
  const wideFrom = useMemo(() => {
    const d = startOfToday(); d.setDate(d.getDate() - 30); return d;
  }, []);
  const wideTo = useMemo(() => endOfDate(7), []);

  // Per-bucket "shown" state — the user grows it via Show More. Every
  // bucket also holds onto its own `total` so the count badge stays
  // accurate even when only a slice has been fetched.
  const [pastDueShown, setPastDueShown] = useState(BUCKET_PAGE_SIZE);
  const [todayShown, setTodayShown] = useState(BUCKET_PAGE_SIZE);
  const [tomorrowShown, setTomorrowShown] = useState(BUCKET_PAGE_SIZE);
  const [upcomingShown, setUpcomingShown] = useState(BUCKET_PAGE_SIZE);

  const pastDueQ = useBucketQuery({ bucket: "pastDue", from: pastDueRange.from, to: pastDueRange.to, shown: pastDueShown });
  const todayQ = useBucketQuery({ bucket: "today", from: todayRange.from, to: todayRange.to, shown: todayShown });
  const tomorrowQ = useBucketQuery({ bucket: "tomorrow", from: tomorrowRange.from, to: tomorrowRange.to, shown: tomorrowShown });
  const upcomingQ = useBucketQuery({ bucket: "upcoming", from: upcomingRange.from, to: upcomingRange.to, shown: upcomingShown });

  // Failed tasks power the NeedsAttention banner. They're typically rare
  // (each represents a permanent send failure that needs human action),
  // so we cap the page at 200 — well above what any tenant should
  // realistically have outstanding at once.
  const { data: failedData } = useQuery<{ items: TaskInstanceWithLead[]; total: number; hasMore: boolean }>({
    queryKey: [
      "/api/sales-process/tasks",
      { withLead: 1, status: "failed", from: wideFrom.toISOString(), to: wideTo.toISOString(), paged: 1, limit: 200 },
    ],
    queryFn: async () => {
      const url = new URL("/api/sales-process/tasks", window.location.origin);
      url.searchParams.set("withLead", "1");
      url.searchParams.set("status", "failed");
      url.searchParams.set("paged", "1");
      url.searchParams.set("limit", "200");
      url.searchParams.set("from", wideFrom.toISOString());
      url.searchParams.set("to", wideTo.toISOString());
      const res = await fetch(url.pathname + url.search, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch failed tasks");
      return res.json();
    },
  });

  // Estimate-anchored tasks. Same wide window; capped at 50 with a
  // Show More on the bucket header. Estimate cadences are usually
  // shorter than lead cadences so the cap rarely binds.
  const [estimateShown, setEstimateShown] = useState(BUCKET_PAGE_SIZE);
  const { data: estimateData } = useQuery<{ items: TaskInstanceWithEstimate[]; total: number; hasMore: boolean }>({
    queryKey: [
      "/api/sales-process/tasks",
      { withEstimate: 1, status: "pending,failed", from: wideFrom.toISOString(), to: wideTo.toISOString(), paged: 1, limit: estimateShown },
    ],
    queryFn: async () => {
      const url = new URL("/api/sales-process/tasks", window.location.origin);
      url.searchParams.set("withEstimate", "1");
      url.searchParams.set("status", "pending,failed");
      url.searchParams.set("paged", "1");
      url.searchParams.set("limit", String(estimateShown));
      url.searchParams.set("offset", "0");
      url.searchParams.set("from", wideFrom.toISOString());
      url.searchParams.set("to", wideTo.toISOString());
      const res = await fetch(url.pathname + url.search, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch sales-process estimate tasks");
      return res.json();
    },
    placeholderData: keepPreviousData,
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

  const failed = failedData?.items ?? [];
  const pastDue = pastDueQ.data?.items ?? [];
  const today = todayQ.data?.items ?? [];
  const tomorrow = tomorrowQ.data?.items ?? [];
  const upcoming = upcomingQ.data?.items ?? [];
  const estimateTasks = estimateData?.items ?? [];
  const pastDueTotal = pastDueQ.data?.total ?? 0;
  const todayTotal = todayQ.data?.total ?? 0;
  const tomorrowTotal = tomorrowQ.data?.total ?? 0;
  const upcomingTotal = upcomingQ.data?.total ?? 0;
  const estimateTotal = estimateData?.total ?? 0;

  const pastDueGroups = useMemo(() => groupTasksByStep(pastDue, stepsById), [pastDue, stepsById]);
  const todayGroups = useMemo(() => groupTasksByStep(today, stepsById), [today, stepsById]);
  const tomorrowGroups = useMemo(() => groupTasksByStep(tomorrow, stepsById), [tomorrow, stepsById]);
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

  const handleComposeEmail = (
    task: TaskInstanceWithLead,
    prefilledContent?: string,
    guidance?: string | null,
  ) => {
    setEmailModal({ isOpen: true, task, initialContent: prefilledContent, guidance: guidance ?? undefined });
  };

  // For the empty-state hint we still want "what is your next thing?".
  // We only know the next item among rows we've already fetched; that's
  // the earliest row in the upcoming bucket.
  // NOTE: This hook MUST stay above the early return below — moving it
  // after the `if (isLoading) return <skeleton/>` guard changes the hook
  // count between renders and triggers React error #310 ("Rendered more
  // hooks than during the previous render"). See task #739.
  const nextUpcoming = useMemo(() => {
    if (upcoming.length === 0) return undefined;
    return upcoming.reduce((earliest, t) =>
      new Date(t.dueAt) < new Date(earliest.dueAt) ? t : earliest,
    );
  }, [upcoming]);

  const isLoading = pastDueQ.isLoading || todayQ.isLoading || tomorrowQ.isLoading || upcomingQ.isLoading;
  if (isLoading && pastDue.length === 0 && today.length === 0 && tomorrow.length === 0 && upcoming.length === 0) {
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

  const totalOpen = pastDueTotal + todayTotal + tomorrowTotal + upcomingTotal + estimateTotal;

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

      {totalOpen === 0 ? (
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

      {pastDueTotal > 0 && (
        <section className="space-y-2" data-testid="section-past-due">
          <div className="flex items-center gap-2">
            <BucketSelectAll
              tasks={pastDue}
              selectedIds={selectedIds}
              onChange={setManySelected}
              testId="checkbox-select-all-past-due"
            />
            <h2 className="text-sm font-semibold uppercase tracking-wide text-destructive">
              Past Due
            </h2>
            <Badge variant="destructive" className="text-xs" data-testid="badge-past-due-total">
              {pastDueTotal}
            </Badge>
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
                    selected={selectedIds.has(t.id)}
                    onSelectedChange={setRowSelected}
                  />
                ))}
              </div>
            </div>
          ))}
          {pastDueQ.data?.hasMore && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPastDueShown((n) => n + BUCKET_PAGE_SIZE)}
              disabled={pastDueQ.isFetching}
              data-testid="button-show-more-past-due"
            >
              Show more ({pastDueTotal - pastDue.length} remaining)
            </Button>
          )}
        </section>
      )}

      {todayTotal > 0 && (
        <section className="space-y-2" data-testid="section-today">
          <div className="flex items-center gap-2">
            <BucketSelectAll
              tasks={today}
              selectedIds={selectedIds}
              onChange={setManySelected}
              testId="checkbox-select-all-today"
            />
            <h2 className="text-sm font-semibold uppercase tracking-wide">Today</h2>
            <Badge variant="secondary" className="text-xs" data-testid="badge-today-total">
              {todayTotal}
            </Badge>
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
                    selected={selectedIds.has(t.id)}
                    onSelectedChange={setRowSelected}
                  />
                ))}
              </div>
            </div>
          ))}
          {todayQ.data?.hasMore && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setTodayShown((n) => n + BUCKET_PAGE_SIZE)}
              disabled={todayQ.isFetching}
              data-testid="button-show-more-today"
            >
              Show more ({todayTotal - today.length} remaining)
            </Button>
          )}
        </section>
      )}

      {tomorrowTotal > 0 && (
        <section className="space-y-2" data-testid="section-tomorrow">
          <div className="flex items-center gap-2">
            <BucketSelectAll
              tasks={tomorrow}
              selectedIds={selectedIds}
              onChange={setManySelected}
              testId="checkbox-select-all-tomorrow"
            />
            <h2 className="text-sm font-semibold uppercase tracking-wide">Tomorrow</h2>
            <Badge variant="secondary" className="text-xs" data-testid="badge-tomorrow-total">
              {tomorrowTotal}
            </Badge>
          </div>
          {tomorrowGroups.map((group) => (
            <div key={`tm-${group.stepKey}`} className="space-y-2">
              <StepGroupHeader group={group} />
              <div className="space-y-2">
                {group.tasks.map((t) => (
                  <SalesProcessTaskRow
                    key={t.id}
                    task={t}
                    step={group.step}
                    onOpenLead={onOpenLead}
                    onComposeEmail={handleComposeEmail}
                    selected={selectedIds.has(t.id)}
                    onSelectedChange={setRowSelected}
                  />
                ))}
              </div>
            </div>
          ))}
          {tomorrowQ.data?.hasMore && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setTomorrowShown((n) => n + BUCKET_PAGE_SIZE)}
              disabled={tomorrowQ.isFetching}
              data-testid="button-show-more-tomorrow"
            >
              Show more ({tomorrowTotal - tomorrow.length} remaining)
            </Button>
          )}
        </section>
      )}

      {upcomingTotal > 0 && (
        <section className="space-y-2" data-testid="section-upcoming">
          <div className="flex items-center gap-2">
            <BucketSelectAll
              tasks={upcoming}
              selectedIds={selectedIds}
              onChange={setManySelected}
              testId="checkbox-select-all-upcoming"
            />
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
              <h2 className="text-sm font-semibold uppercase tracking-wide">Upcoming (next 7 days, after tomorrow)</h2>
              <Badge variant="outline" className="text-xs" data-testid="badge-upcoming-total">
                {upcomingTotal}
              </Badge>
            </button>
          </div>
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
                            selected={selectedIds.has(t.id)}
                            onSelectedChange={setRowSelected}
                          />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              ))}
              {upcomingQ.data?.hasMore && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setUpcomingShown((n) => n + BUCKET_PAGE_SIZE)}
                  disabled={upcomingQ.isFetching}
                  data-testid="button-show-more-upcoming"
                >
                  Show more ({upcomingTotal - upcoming.length} remaining)
                </Button>
              )}
            </div>
          )}
        </section>
      )}

      {estimateTotal > 0 && (
        <section className="space-y-2" data-testid="section-estimate-tasks">
          <div className="flex items-center gap-2">
            <BucketSelectAll
              tasks={estimateTasks}
              selectedIds={selectedIds}
              onChange={setManySelected}
              testId="checkbox-select-all-estimate"
            />
            <h2 className="text-sm font-semibold uppercase tracking-wide">Estimate follow-ups</h2>
            <Badge variant="secondary" className="text-xs" data-testid="badge-estimate-total">
              {estimateTotal}
            </Badge>
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
                    <Checkbox
                      checked={selectedIds.has(t.id)}
                      onCheckedChange={(v) => setRowSelected(t.id, v === true)}
                      aria-label="Select estimate follow-up"
                      data-testid={`checkbox-estimate-task-${t.id}`}
                    />
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
            {estimateData?.hasMore && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setEstimateShown((n) => n + BUCKET_PAGE_SIZE)}
                data-testid="button-show-more-estimate"
              >
                Show more ({estimateTotal - estimateTasks.length} remaining)
              </Button>
            )}
          </div>
        </section>
      )}

      {selectedIds.size > 0 && (
        <div
          className="fixed inset-x-0 bottom-4 z-50 flex justify-center px-4 pointer-events-none"
          data-testid="bulk-action-bar"
        >
          <div className="pointer-events-auto flex items-center gap-2 rounded-md border bg-background shadow-lg p-2 flex-wrap">
            <Badge variant="secondary" className="text-xs" data-testid="badge-bulk-selected-count">
              {selectedIds.size} selected
            </Badge>
            <Button
              size="sm"
              variant="default"
              onClick={runBulkComplete}
              disabled={bulkPending}
              data-testid="button-bulk-complete"
            >
              <Check className="h-3.5 w-3.5 mr-1.5" />
              Mark done selected
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={runBulkSkip}
              disabled={bulkPending}
              data-testid="button-bulk-skip"
            >
              <SkipForward className="h-3.5 w-3.5 mr-1.5" />
              Skip selected
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={clearSelection}
              disabled={bulkPending}
              data-testid="button-bulk-clear"
            >
              <X className="h-3.5 w-3.5 mr-1.5" />
              Clear selection
            </Button>
          </div>
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
          guidance={emailModal.guidance}
          onSent={() => {
            queryClient.invalidateQueries({ queryKey: ["/api/sales-process/tasks"] });
          }}
        />
      )}
    </div>
  );
}
