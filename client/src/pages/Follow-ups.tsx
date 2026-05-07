/**
 * Follow-ups page.
 *
 * Data strategy: Fetches from /api/follow-ups/unified which returns a merged,
 * server-sorted FollowUpItem[] combining leads (by followUpDate) and estimates
 * (by validUntil or scheduledStart). Filtering by status (overdue/today/thisweek)
 * is done client-side since it's a simple array filter over already-fetched data.
 */
import { useQuery, useQueries, useMutation, keepPreviousData } from "@tanstack/react-query";
import { useContactMutations } from "@/hooks/useContactMutations";
import { useEstimateMutations } from "@/hooks/useEstimateMutations";
import { Calendar, Filter, LayoutGrid, Table, ListChecks } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { EditLeadModal } from "@/components/EditLeadModal";
import { EditEstimateModal } from "@/components/EditEstimateModal";
import { LeadDetailsModal } from "@/components/LeadDetailsModal";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EmailComposerModal } from "@/components/EmailComposerModal";
import { HousecallProSchedulingModal } from "@/components/HousecallProSchedulingModal";
import { FollowUpDateModal } from "@/components/FollowUpDateModal";
import { FollowUpCard, FollowUpItem, buildFollowUpVars } from "@/components/FollowUpCard";
import { renderTemplate } from "@/components/StepCoachingPopover";
import { FollowUpSpreadsheetView } from "@/components/FollowUpSpreadsheetView";
import { SalesProcessFollowUpView } from "@/components/SalesProcessFollowUpView";
import type { SalesProcess, SalesProcessStep } from "@shared/schema";
import { useState, useCallback, useEffect, useMemo } from "react";
import { useLocation, useSearch } from "wouter";
import type { Contact, EstimateSummary } from "@shared/schema";
import { PageHeader } from "@/components/ui/page-header-v2";
import { PageLayout } from "@/components/ui/page-layout";
import { dialPhone } from "@/lib/dialPhone";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { usePagePreferences, type ViewMode } from "@/hooks/use-page-preferences";

/**
 * Compact Prev/Next pager rendered under the cards and spreadsheet views.
 * Shows the current window (e.g. "1–50 of 1,432") plus disabled/enabled
 * Prev and Next buttons. Hidden entirely when the result fits on a single
 * page so empty/small tenants don't see pager chrome.
 */
function FollowUpsPager({
  page, totalPages, totalCount, hasMore, isLoading, pageSize, onPageChange,
}: {
  page: number;
  totalPages: number;
  totalCount: number;
  hasMore: boolean;
  isLoading: boolean;
  pageSize: number;
  onPageChange: (next: number) => void;
}) {
  if (totalCount <= pageSize) return null;
  const start = totalCount === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, totalCount);
  return (
    <div
      className="flex items-center justify-between gap-2 mt-4 flex-wrap"
      data-testid="followups-pager"
    >
      <div className="text-xs text-muted-foreground" data-testid="text-pager-range">
        Showing {start}–{end} of {totalCount}
      </div>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={page <= 1 || isLoading}
          onClick={() => onPageChange(Math.max(1, page - 1))}
          data-testid="button-pager-prev"
        >
          Previous
        </Button>
        <span className="text-xs text-muted-foreground" data-testid="text-pager-page">
          Page {page} of {totalPages}
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={!hasMore || isLoading}
          onClick={() => onPageChange(page + 1)}
          data-testid="button-pager-next"
        >
          Next
        </Button>
      </div>
    </div>
  );
}

export default function FollowUps() {
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const { data: currentUserData } = useCurrentUser();
  const contractorName = currentUserData?.user?.contractorName || '';

  // We re-derive the page default once the sales-process query resolves so
  // tenants with an active process land on the new step-based view by
  // default. Users who have explicitly picked another view in the past
  // keep their saved choice (preferences.viewMode wins over the default).
  const { viewMode, setViewMode } = usePagePreferences({
    pageKey: "follow-ups",
    defaultViewMode: "cards",
  });

  // Filter starts from URL (or "all") so deep links like
  // /follow-ups?filter=overdue land on the right tab.
  const initialUrlFilter = (() => {
    if (typeof window === "undefined") return "all";
    const p = new URLSearchParams(window.location.search).get("filter");
    return p && ["all","overdue","today","thisweek","upcoming"].includes(p) ? p : "all";
  })();
  const [filterView, setFilterView] = useState<string>(initialUrlFilter);
  const [emailModal, setEmailModal] = useState<{
    isOpen: boolean;
    item?: FollowUpItem;
  }>({ isOpen: false });
  
  const [schedulingModal, setSchedulingModal] = useState<{
    isOpen: boolean;
    item?: FollowUpItem;
  }>({ isOpen: false });

  const [editLeadModal, setEditLeadModal] = useState<{
    isOpen: boolean;
    lead?: Contact;
  }>({ isOpen: false });

  const [editEstimateModal, setEditEstimateModal] = useState<{
    isOpen: boolean;
    estimate?: EstimateSummary;
  }>({ isOpen: false });

  const [followUpModal, setFollowUpModal] = useState<{
    isOpen: boolean;
    item?: FollowUpItem;
  }>({ isOpen: false });

  const [leadDetailsModal, setLeadDetailsModal] = useState<{
    isOpen: boolean;
    contact?: Contact;
  }>({ isOpen: false });

  // Fetch every cadence the contractor has configured. The Sales Process
  // view shows tasks across ALL active cadences (lead_created, lead/estimate
  // status-change), not just the canonical lead_created one — otherwise a
  // tenant with only an "Estimate Approved" cadence would never see the
  // toggle.
  const { data: cadences = [] } = useQuery<SalesProcess[]>({
    queryKey: ["/api/sales-process/cadences"],
  });
  const activeCadences = cadences.filter(c => c.active);
  // Pull each active cadence's steps in parallel so we can build a single
  // stepsById map covering every cadence — task rows from any cadence then
  // group correctly under their owning step.
  const cadenceStepQueries = useQueries({
    queries: activeCadences.map(c => ({
      queryKey: ["/api/sales-process/cadences", c.id],
    })),
  });
  const allSteps = cadenceStepQueries.flatMap(q => {
    const data = q.data as { steps: SalesProcessStep[] } | undefined;
    return data?.steps ?? [];
  });
  // Toggle visibility keys off "any active cadence" rather than waiting for
  // the per-cadence step queries to resolve — otherwise a slow network can
  // briefly hide the Sales Process toggle on first paint even though the
  // contractor clearly has cadences turned on.
  const hasActiveSalesProcess = activeCadences.length > 0;

  // Lightweight pending-task count powering the toggle badge. Same query
  // key the SalesProcessFollowUpView uses, so React Query dedupes — no
  // extra request.
  const pendingTaskWindowFrom = useState(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - 30);
    return d.toISOString();
  })[0];
  const pendingTaskWindowTo = useState(() => {
    const d = new Date();
    d.setHours(23, 59, 59, 999);
    d.setDate(d.getDate() + 7);
    return d.toISOString();
  })[0];
  // Badge counts only `pending` tasks — `failed` rows are already surfaced in
  // the NeedsAttention banner inside the Sales Process view, so including
  // them here would double-count and overstate "open work to do". We use
  // `paged=1&limit=1` so the server returns just the count instead of
  // shipping every task across the wire merely to populate a badge.
  const fetchPendingCount = async (kind: "withLead" | "withEstimate") => {
    const url = new URL("/api/sales-process/tasks", window.location.origin);
    url.searchParams.set(kind, "1");
    url.searchParams.set("status", "pending");
    url.searchParams.set("from", pendingTaskWindowFrom);
    url.searchParams.set("to", pendingTaskWindowTo);
    url.searchParams.set("paged", "1");
    url.searchParams.set("limit", "1");
    const res = await fetch(url.pathname + url.search, { credentials: "include" });
    if (!res.ok) throw new Error("Failed to fetch sales-process tasks");
    return res.json() as Promise<{ total: number }>;
  };
  const { data: leadCountData } = useQuery<{ total: number }>({
    queryKey: [
      "/api/sales-process/tasks",
      { withLead: 1, status: "pending", from: pendingTaskWindowFrom, to: pendingTaskWindowTo, paged: 1, limit: 1 },
    ],
    queryFn: () => fetchPendingCount("withLead"),
    enabled: hasActiveSalesProcess,
  });
  const { data: estimateCountData } = useQuery<{ total: number }>({
    queryKey: [
      "/api/sales-process/tasks",
      { withEstimate: 1, status: "pending", from: pendingTaskWindowFrom, to: pendingTaskWindowTo, paged: 1, limit: 1 },
    ],
    queryFn: () => fetchPendingCount("withEstimate"),
    enabled: hasActiveSalesProcess,
  });
  const pendingTaskCount = (leadCountData?.total ?? 0) + (estimateCountData?.total ?? 0);

  // One-shot: when the sales-process metadata loads and the contractor has
  // an active process, switch to the new view *unless* the user has
  // explicitly saved a different viewMode (in which case the persisted
  // value wins). We detect "no explicit choice" by reading the same
  // localStorage key usePagePreferences uses.
  const [hasAutoSwitchedToSalesProcess, setHasAutoSwitchedToSalesProcess] = useState(false);
  if (
    hasActiveSalesProcess &&
    !hasAutoSwitchedToSalesProcess &&
    typeof window !== "undefined"
  ) {
    try {
      const raw = window.localStorage.getItem("page-preferences-follow-ups");
      const parsed = raw ? JSON.parse(raw) : null;
      if (!parsed?.viewMode) {
        setViewMode("sales-process");
      }
      setHasAutoSwitchedToSalesProcess(true);
    } catch {
      setHasAutoSwitchedToSalesProcess(true);
    }
  }

  // -------- URL-synced filter / view / page state --------
  // We sync the filter dropdown, the view toggle, and the current page
  // number to the URL search string so the page survives reloads, deep
  // links, and back/forward navigation. wouter's `useSearch` gives us a
  // raw query string we re-parse cheaply on each render.
  const urlSearch = useSearch();
  // Reflect popstate / back-forward navigation back into local state so
  // the cards/spreadsheet show the URL's intended page, filter, and view
  // after the user hits Back. wouter's `useSearch` re-runs on every URL
  // change (including history.back), so this effect keeps state in sync
  // without a full reload.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(urlSearch);
    const f = params.get("filter");
    if (f && f !== filterView) setFilterView(f);
    const p = parseInt(params.get("page") || "1", 10);
    const nextPage = Number.isFinite(p) && p > 0 ? p : 1;
    if (nextPage !== page) setPage(nextPage);
    const v = params.get("view");
    const allowed = ["cards","spreadsheet","sales-process"] as const;
    if (v && v !== viewMode && (allowed as readonly string[]).includes(v)) {
      setViewMode(v as ViewMode);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlSearch]);

  const setQueryParams = useCallback((updates: Record<string, string | null>) => {
    const next = new URLSearchParams(window.location.search);
    for (const [k, v] of Object.entries(updates)) {
      if (v == null || v === "") next.delete(k);
      else next.set(k, v);
    }
    const qs = next.toString();
    const target = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
    window.history.replaceState({}, "", target);
  }, []);

  // ~50 rows per page on first paint keeps the DOM bounded even for the
  // biggest tenants. Cards/spreadsheet views show a Prev/Next pager.
  const PAGE_SIZE = 50;
  const [page, setPage] = useState<number>(() => {
    if (typeof window === "undefined") return 1;
    const p = parseInt(new URLSearchParams(window.location.search).get("page") || "1", 10);
    return Number.isFinite(p) && p > 0 ? p : 1;
  });

  // Date range derived from the active filter — sent to the server so we
  // only fetch the bucket the user is looking at instead of pulling all
  // follow-ups and slicing client-side.
  const dateRange = useMemo(() => {
    const now = new Date();
    const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0);
    const tomorrow = new Date(todayStart); tomorrow.setDate(tomorrow.getDate() + 1);
    const daysUntilSatEnd = 6 - now.getDay();
    const endOfWeekExclusive = new Date(todayStart);
    endOfWeekExclusive.setDate(endOfWeekExclusive.getDate() + daysUntilSatEnd + 1);

    switch (filterView) {
      case "overdue": return { to: todayStart };
      case "today": return { from: todayStart, to: tomorrow };
      case "thisweek": return { from: tomorrow, to: endOfWeekExclusive };
      case "upcoming": return { from: endOfWeekExclusive };
      case "all":
      default: return {};
    }
  }, [filterView]);

  const offset = (page - 1) * PAGE_SIZE;
  const { data: pagedData, isLoading } = useQuery<{
    items: FollowUpItem[]; total: number; hasMore: boolean;
  }>({
    queryKey: [
      "/api/follow-ups/unified",
      {
        from: dateRange.from?.toISOString() ?? null,
        to: dateRange.to?.toISOString() ?? null,
        limit: PAGE_SIZE,
        offset,
      },
    ],
    queryFn: async () => {
      const url = new URL("/api/follow-ups/unified", window.location.origin);
      url.searchParams.set("limit", String(PAGE_SIZE));
      url.searchParams.set("offset", String(offset));
      if (dateRange.from) url.searchParams.set("from", dateRange.from.toISOString());
      if (dateRange.to) url.searchParams.set("to", dateRange.to.toISOString());
      const res = await fetch(url.pathname + url.search, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch follow-ups");
      return res.json();
    },
    placeholderData: keepPreviousData,
  });
  const followUpItems = pagedData?.items ?? [];
  const totalCount = pagedData?.total ?? 0;
  const hasMore = pagedData?.hasMore ?? false;
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  // If the current page index sits past the end of the data set (common
  // when a shared deep link points beyond the now-truncated total, or
  // when items get archived), snap back to the last valid page instead
  // of showing an empty state.
  useEffect(() => {
    if (totalCount > 0 && page > totalPages) {
      setPage(totalPages);
      setQueryParams({ page: totalPages === 1 ? null : String(totalPages) });
    }
  }, [page, totalPages, totalCount, setQueryParams]);

  // Filter or view changes always reset paging back to page 1.
  const handleFilterChange = useCallback((next: string) => {
    setFilterView(next);
    setPage(1);
    setQueryParams({ filter: next === "all" ? null : next, page: null });
  }, [setQueryParams]);
  const handleViewChange = useCallback((next: string) => {
    setViewMode(next as ViewMode);
    setPage(1);
    setQueryParams({ view: next, page: null });
  }, [setQueryParams, setViewMode]);
  const handlePageChange = useCallback((next: number) => {
    setPage(next);
    setQueryParams({ page: next === 1 ? null : String(next) });
  }, [setQueryParams]);

  const resolveContactId = (item: FollowUpItem): string | undefined => {
    if (item.type === 'lead') return item.id;
    return item.contactId ?? undefined;
  };

  const handleContact = (item: FollowUpItem, method: 'phone' | 'email') => {
    if (method === 'phone') {
      const contactId = resolveContactId(item);
      if (!contactId) {
        toast({
          title: "No contact linked",
          description: `This ${item.type} doesn't have a linked contact. Please associate a contact to enable calling.`,
          variant: "destructive",
        });
        return;
      }
      if (item.phone) {
        dialPhone({ contactId, phone: item.phone, name: item.name });
      } else {
        toast({
          title: "No phone number",
          description: `${item.name} doesn't have a phone number on file.`,
          variant: "destructive",
        });
      }
    } else if (method === 'email') {
      if (item.email) {
        setEmailModal({ isOpen: true, item });
      } else {
        toast({
          title: "No email address",
          description: `${item.name} doesn't have an email address on file.`,
          variant: "destructive",
        });
      }
    }
  };

  const handleSchedule = (item: FollowUpItem) => {
    setSchedulingModal({ 
      isOpen: true, 
      item: item
    });
  };

  // Update estimate follow-up date mutation
  const updateEstimateFollowUpMutation = useMutation({
    mutationFn: async ({ estimateId, followUpDate }: { estimateId: string; followUpDate: Date | null }) => {
      return apiRequest('PATCH', `/api/estimates/${estimateId}/follow-up`, {
        followUpDate: followUpDate ? followUpDate.toISOString() : null
      });
    },
    onSuccess: () => {
      toast({
        title: "Follow-up date updated",
        description: "The follow-up date has been successfully updated.",
      });
      queryClient.invalidateQueries({ queryKey: ['/api/estimates/paginated'] });
      queryClient.invalidateQueries({ queryKey: ['/api/estimates'] });
      queryClient.invalidateQueries({ queryKey: ['/api/estimates/follow-ups'] });
      queryClient.invalidateQueries({ queryKey: ['/api/follow-ups/unified'] });
    },
    onError: (error: Error) => {
      toast({
        title: "Error updating follow-up date",
        description: error.message || "Failed to update follow-up date. Please try again.",
        variant: "destructive",
      });
    },
  });

  // Update job follow-up date mutation
  const updateJobFollowUpMutation = useMutation({
    mutationFn: async ({ jobId, followUpDate }: { jobId: string; followUpDate: Date | null }) => {
      return apiRequest('PATCH', `/api/jobs/${jobId}/follow-up`, {
        followUpDate: followUpDate ? followUpDate.toISOString() : null
      });
    },
    onSuccess: () => {
      toast({
        title: "Follow-up date updated",
        description: "The follow-up date has been successfully updated.",
      });
      queryClient.invalidateQueries({ queryKey: ['/api/jobs'] });
      queryClient.invalidateQueries({ queryKey: ['/api/follow-ups/unified'] });
    },
    onError: (error: Error) => {
      toast({
        title: "Error updating follow-up date",
        description: error.message || "Failed to update follow-up date. Please try again.",
        variant: "destructive",
      });
    },
  });

  const { updateFollowUpDate: updateLeadFollowUpMutation } = useContactMutations();

  const { updateEstimate: updateEstimateMutation } = useEstimateMutations({
    onEditSuccess: () => setEditEstimateModal({ isOpen: false }),
  });

  const handleEdit = useCallback(async (item: FollowUpItem) => {
    if (item.type === 'lead') {
      try {
        const res = await apiRequest("GET", `/api/contacts/${item.id}`);
        const lead: Contact = await res.json();
        setEditLeadModal({ isOpen: true, lead });
      } catch {
        toast({ title: "Failed to load lead data", variant: "destructive" });
      }
    } else if (item.type === 'estimate') {
      try {
        const res = await apiRequest("GET", `/api/estimates/${item.id}`);
        const estimate = await res.json();
        setEditEstimateModal({ isOpen: true, estimate });
      } catch {
        toast({ title: "Failed to load estimate data", variant: "destructive" });
      }
    } else {
      setLocation('/jobs');
    }
  }, [toast, setLocation]);

  const handleSetFollowUp = (item: FollowUpItem) => {
    setFollowUpModal({ isOpen: true, item });
  };

  const handleOpenDetail = useCallback(async (item: FollowUpItem) => {
    if (item.type === 'lead') {
      try {
        const res = await apiRequest("GET", `/api/contacts/${item.id}`);
        const contact: Contact = await res.json();
        setLeadDetailsModal({ isOpen: true, contact });
      } catch {
        toast({ title: "Failed to load lead details", variant: "destructive" });
      }
    } else if (item.type === 'estimate') {
      setLocation(`/estimates?open=${item.id}`);
    } else {
      setLocation('/jobs');
    }
  }, [toast, setLocation]);

  const handleFollowUpSubmit = (date: Date | undefined) => {
    if (!followUpModal.item) return;
    
    if (followUpModal.item.type === 'lead') {
      updateLeadFollowUpMutation.mutate({
        contactId: followUpModal.item.id,
        followUpDate: date || null
      }, {
        onSuccess: () => {
          setFollowUpModal({ isOpen: false });
        }
      });
    } else if (followUpModal.item.type === 'estimate') {
      updateEstimateFollowUpMutation.mutate({
        estimateId: followUpModal.item.id,
        followUpDate: date || null,
      }, {
        onSuccess: () => {
          setFollowUpModal({ isOpen: false });
        }
      });
    } else {
      updateJobFollowUpMutation.mutate({
        jobId: followUpModal.item.id,
        followUpDate: date || null,
      }, {
        onSuccess: () => {
          setFollowUpModal({ isOpen: false });
        }
      });
    }
  };

  const removeEstimateFollowUpMutation = useMutation({
    mutationFn: async ({ estimateId }: { estimateId: string }) => {
      return apiRequest('PATCH', `/api/estimates/${estimateId}/follow-up`, {
        followUpDate: null
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/estimates/paginated'] });
      queryClient.invalidateQueries({ queryKey: ['/api/estimates'] });
      queryClient.invalidateQueries({ queryKey: ['/api/estimates/follow-ups'] });
      queryClient.invalidateQueries({ queryKey: ['/api/follow-ups/unified'] });
    },
    onError: (error: Error) => {
      toast({
        title: "Error removing follow-up",
        description: error.message || "Failed to remove follow-up. Please try again.",
        variant: "destructive",
      });
    },
  });

  const removeJobFollowUpMutation = useMutation({
    mutationFn: async ({ jobId }: { jobId: string }) => {
      return apiRequest('PATCH', `/api/jobs/${jobId}/follow-up`, {
        followUpDate: null
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/jobs'] });
      queryClient.invalidateQueries({ queryKey: ['/api/follow-ups/unified'] });
    },
    onError: (error: Error) => {
      toast({
        title: "Error removing follow-up",
        description: error.message || "Failed to remove follow-up. Please try again.",
        variant: "destructive",
      });
    },
  });

  const removeLeadFollowUpMutation = useMutation({
    mutationFn: async ({ contactId }: { contactId: string }) => {
      return apiRequest("PATCH", `/api/contacts/${contactId}/follow-up`, {
        followUpDate: null,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/contacts'] });
      queryClient.invalidateQueries({ queryKey: ['/api/follow-ups/unified'] });
    },
    onError: (error: Error) => {
      toast({
        title: "Error removing follow-up",
        description: error.message || "Failed to remove follow-up. Please try again.",
        variant: "destructive",
      });
    },
  });

  const handleRemoveFollowUp = useCallback((item: FollowUpItem) => {
    const name = item.name;
    const onSuccess = () => {
      toast({
        title: "Follow-up removed",
        description: `Follow-up for ${name} has been removed.`,
      });
    };

    if (item.type === 'lead') {
      removeLeadFollowUpMutation.mutate({ contactId: item.id }, { onSuccess });
    } else if (item.type === 'estimate') {
      removeEstimateFollowUpMutation.mutate({ estimateId: item.id }, { onSuccess });
    } else {
      removeJobFollowUpMutation.mutate({ jobId: item.id }, { onSuccess });
    }
  }, [toast, removeLeadFollowUpMutation, removeEstimateFollowUpMutation, removeJobFollowUpMutation]);

  // If the user previously selected the sales-process view but the
  // contractor disabled the process, fall back to cards.
  const activeViewMode =
    viewMode === "kanban"
      ? "cards"
      : viewMode === "sales-process" && !hasActiveSalesProcess
        ? "cards"
        : viewMode;

  const handleOpenLeadFromSalesProcess = useCallback(
    async (leadId: string) => {
      try {
        const res = await apiRequest("GET", `/api/contacts/${leadId}`);
        const contact: Contact = await res.json();
        setLeadDetailsModal({ isOpen: true, contact });
      } catch {
        toast({ title: "Failed to load lead", variant: "destructive" });
      }
    },
    [toast],
  );

  return (
    <PageLayout>
      <PageHeader
        title="Follow-ups"
        description="Leads, estimates, and jobs that need follow-up, sorted by date"
        actions={
          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2">
            <div className="flex items-center border rounded-md self-start sm:self-auto">
              <Button
                variant={activeViewMode === "cards" ? "default" : "ghost"}
                size="sm"
                onClick={() => handleViewChange("cards")}
                data-testid="view-cards"
              >
                <LayoutGrid className="h-4 w-4" />
              </Button>
              <Button
                variant={activeViewMode === "spreadsheet" ? "default" : "ghost"}
                size="sm"
                onClick={() => handleViewChange("spreadsheet")}
                data-testid="view-spreadsheet"
              >
                <Table className="h-4 w-4" />
              </Button>
              {hasActiveSalesProcess && (
                <Button
                  variant={activeViewMode === "sales-process" ? "default" : "ghost"}
                  size="sm"
                  onClick={() => handleViewChange("sales-process")}
                  data-testid="view-sales-process"
                  title="Sales Process"
                  className="gap-1.5"
                >
                  <ListChecks className="h-4 w-4" />
                  <span className="hidden sm:inline">Sales Process</span>
                  {pendingTaskCount > 0 && (
                    <Badge
                      variant={activeViewMode === "sales-process" ? "secondary" : "default"}
                      className="text-xs px-1.5 min-w-[1.25rem] h-5"
                      data-testid="badge-sales-process-count"
                    >
                      {pendingTaskCount}
                    </Badge>
                  )}
                </Button>
              )}
            </div>
            <Select value={filterView} onValueChange={handleFilterChange} data-testid="select-filter-view">
              <SelectTrigger className="w-full sm:w-[180px]">
                <div className="flex items-center gap-2">
                  <Filter className="h-4 w-4" />
                  <SelectValue placeholder="Filter view" />
                </div>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Follow-ups</SelectItem>
                <SelectItem value="overdue">Past Due</SelectItem>
                <SelectItem value="today">Today</SelectItem>
                <SelectItem value="thisweek">This Week</SelectItem>
                <SelectItem value="upcoming">Upcoming</SelectItem>
              </SelectContent>
            </Select>
            <Badge variant="outline" data-testid="badge-total-followups">
              {totalCount} follow-ups
            </Badge>
          </div>
        }
      />

      {activeViewMode === "sales-process" ? (
        <SalesProcessFollowUpView
          cadences={activeCadences}
          steps={allSteps}
          onOpenLead={handleOpenLeadFromSalesProcess}
        />
      ) : activeViewMode === "spreadsheet" ? (
        <>
          <FollowUpSpreadsheetView
            items={followUpItems}
            isLoading={isLoading}
            onSetFollowUp={handleSetFollowUp}
            onContact={handleContact}
            onEdit={handleEdit}
            onOpenDetail={handleOpenDetail}
            onRemoveFollowUp={handleRemoveFollowUp}
          />
          <FollowUpsPager
            page={page}
            totalPages={totalPages}
            totalCount={totalCount}
            hasMore={hasMore}
            isLoading={isLoading}
            pageSize={PAGE_SIZE}
            onPageChange={handlePageChange}
          />
        </>
      ) : isLoading && followUpItems.length === 0 ? (
        <div className="grid gap-4">
          {[...Array(3)].map((_, i) => (
            <Card key={i} className="animate-pulse">
              <CardHeader>
                <div className="h-4 bg-muted rounded w-1/3"></div>
              </CardHeader>
              <CardContent>
                <div className="h-4 bg-muted rounded w-1/2 mb-2"></div>
                <div className="h-4 bg-muted rounded w-2/3"></div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : followUpItems.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center">
            <Calendar className="mx-auto h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-semibold mb-2">No follow-ups scheduled</h3>
            <p className="text-muted-foreground">
              You're all caught up! No leads, estimates, or jobs need follow-up right now.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid gap-4">
            {followUpItems.map((item) => (
              <FollowUpCard
                key={`${item.type}-${item.id}`}
                item={item}
                onSetFollowUp={handleSetFollowUp}
                onContact={handleContact}
                onSchedule={handleSchedule}
                onEdit={handleEdit}
                onRemoveFollowUp={handleRemoveFollowUp}
              />
            ))}
          </div>
          <FollowUpsPager
            page={page}
            totalPages={totalPages}
            totalCount={totalCount}
            hasMore={hasMore}
            isLoading={isLoading}
            pageSize={PAGE_SIZE}
            onPageChange={handlePageChange}
          />
        </>
      )}

      {/* Email Composer Modal */}
      {emailModal.item && (() => {
        const item = emailModal.item;
        const vars = buildFollowUpVars(item);
        const guidance = item.stepGuidance ?? undefined;
        const initialContent =
          item.stepActionType === 'email' && item.stepMessageTemplate
            ? renderTemplate(item.stepMessageTemplate, vars)
            : undefined;
        return (
          <EmailComposerModal
            isOpen={emailModal.isOpen}
            onClose={() => setEmailModal({ isOpen: false })}
            recipientName={item.name}
            recipientEmail={item.email || ''}
            recipientPhone={item.phone || ''}
            companyName={contractorName}
            contactId={item.type === 'lead' ? item.id : (item.contactId ?? undefined)}
            estimateId={item.type === 'estimate' ? item.id : undefined}
            guidance={guidance}
            initialContent={initialContent}
          />
        );
      })()}

      {/* Housecall Pro Scheduling Modal */}
      {schedulingModal.item && (
        <HousecallProSchedulingModal
          isOpen={schedulingModal.isOpen}
          onClose={() => setSchedulingModal({ isOpen: false })}
          lead={schedulingModal.item ? {
            id: schedulingModal.item.id,
            name: schedulingModal.item.name,
            email: schedulingModal.item.email || null,
            phone: schedulingModal.item.phone || null,
            address: schedulingModal.item.address || null,
            value: schedulingModal.item.value ? schedulingModal.item.value.toString() : null,
            isScheduled: false,
            housecallProEstimateId: schedulingModal.item.type === 'estimate' ? schedulingModal.item.id : null,
          } : null}
          onScheduled={(_scheduledLead) => {
            setSchedulingModal({ isOpen: false });
            // The leads/estimates list will be automatically refreshed by the modal's success handler
          }}
        />
      )}

      {/* Edit Lead Modal */}
      <EditLeadModal
        contact={editLeadModal.lead}
        isOpen={editLeadModal.isOpen}
        onClose={() => setEditLeadModal({ isOpen: false })}
        onSuccess={() => {}}
      />

      {/* Lead Details Modal (spreadsheet view name click) */}
      <LeadDetailsModal
        contact={leadDetailsModal.contact}
        isOpen={leadDetailsModal.isOpen}
        onClose={() => setLeadDetailsModal({ isOpen: false })}
      />

      {/* Edit Estimate Modal */}
      <EditEstimateModal
        isOpen={editEstimateModal.isOpen}
        estimate={editEstimateModal.estimate}
        onClose={() => setEditEstimateModal({ isOpen: false })}
        onSave={(values) => {
          if (editEstimateModal.estimate) {
            updateEstimateMutation.mutate({ estimateId: editEstimateModal.estimate.id, data: values });
          }
        }}
        isSaving={updateEstimateMutation.isPending}
      />

      {/* Set Follow-Up Date Modal */}
      <FollowUpDateModal
        isOpen={followUpModal.isOpen}
        onClose={() => setFollowUpModal({ isOpen: false })}
        onSave={handleFollowUpSubmit}
        entityName={followUpModal.item?.name}
        defaultDate={followUpModal.item?.followUpDate ? new Date(followUpModal.item.followUpDate) : undefined}
        isSaving={updateLeadFollowUpMutation.isPending || updateEstimateFollowUpMutation.isPending || updateJobFollowUpMutation.isPending}
        size="compact"
      />

    </PageLayout>
  );
}
