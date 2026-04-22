import { useMemo, useEffect, useRef } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { safeToISO } from "@/lib/utils";
import { useUnreadCountsByContacts } from "@/hooks/useUnreadCounts";
import { useEntityDeepLink } from "@/hooks/useEntityDeepLink";
import { useToast } from "@/hooks/use-toast";
import type { Contact, PaginatedContacts } from "@shared/schema";
import type { LeadViewType } from "@/types/leadTypes";

const PAGE_SIZE = 9;

export interface LeadsDataParams {
  viewMode: LeadViewType;
  filterStatus: string;
  debouncedSearch: string;
  advancedFilters: { assignedTo?: string; dateFrom?: Date; dateTo?: Date };
  showArchived: boolean;
  showAged: boolean;
  page: number;
  sortField: "lastActivity" | "createdDate";
  sortOrder: "asc" | "desc";
  urlSearch: string;
  onOpenDetails: (contact: Contact) => void;
}

export interface LeadsStatusCounts {
  all: number | undefined;
  new: number | undefined;
  contacted: number | undefined;
  scheduled: number | undefined;
  disqualified: number | undefined;
  lost: number | undefined;
}

export function useLeadsData(params: LeadsDataParams) {
  const {
    viewMode,
    filterStatus,
    debouncedSearch,
    advancedFilters,
    showArchived,
    showAged,
    page,
    sortField,
    sortOrder,
    urlSearch,
    onOpenDetails,
  } = params;

  const { toast } = useToast();

  const {
    data: kanbanData,
    isLoading: kanbanLoading,
    error: kanbanError,
    refetch: refetchKanban,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    enabled: viewMode === "kanban",
    refetchOnMount: "always",
    queryKey: ["/api/contacts/paginated", {
      type: "lead",
      includeAll: true,
      status: "all",
      search: debouncedSearch,
      assignedTo: advancedFilters.assignedTo,
      dateFrom: safeToISO(advancedFilters.dateFrom),
      dateTo: safeToISO(advancedFilters.dateTo),
      archived: showArchived,
      aged: showAged,
    }],
    queryFn: async ({ pageParam }) => {
      const url = new URL("/api/contacts/paginated", window.location.origin);
      url.searchParams.set("type", "lead");
      if (pageParam) url.searchParams.set("cursor", pageParam as string);
      url.searchParams.set("includeAll", "true");
      if (debouncedSearch) url.searchParams.set("search", debouncedSearch);
      if (advancedFilters.assignedTo) url.searchParams.set("assignedTo", advancedFilters.assignedTo);
      const dfISO = safeToISO(advancedFilters.dateFrom);
      const dtISO = safeToISO(advancedFilters.dateTo);
      if (dfISO) url.searchParams.set("dateFrom", dfISO);
      if (dtISO) url.searchParams.set("dateTo", dtISO);
      url.searchParams.set("archived", showArchived ? "true" : "false");
      url.searchParams.set("aged", showAged ? "true" : "false");
      url.searchParams.set("limit", "100");
      return (await apiRequest("GET", url.toString())).json();
    },
    getNextPageParam: (lastPage: PaginatedContacts) => lastPage.pagination.nextCursor,
    initialPageParam: undefined as string | undefined,
  });

  const {
    data: cardData,
    isLoading: cardLoading,
    error: cardError,
    refetch: refetchCard,
  } = useQuery<PaginatedContacts>({
    enabled: viewMode !== "kanban",
    refetchOnMount: "always",
    queryKey: ["/api/contacts/paginated", {
      type: "lead",
      status: filterStatus,
      search: debouncedSearch,
      assignedTo: advancedFilters.assignedTo,
      dateFrom: safeToISO(advancedFilters.dateFrom),
      dateTo: safeToISO(advancedFilters.dateTo),
      archived: showArchived,
      aged: showAged,
      page,
      sortField,
      sortOrder,
    }],
    queryFn: async () => {
      const url = new URL("/api/contacts/paginated", window.location.origin);
      url.searchParams.set("type", "lead");
      url.searchParams.set("limit", String(PAGE_SIZE));
      url.searchParams.set("offset", String((page - 1) * PAGE_SIZE));
      if (filterStatus !== "all") url.searchParams.set("status", filterStatus);
      if (debouncedSearch) url.searchParams.set("search", debouncedSearch);
      if (advancedFilters.assignedTo) url.searchParams.set("assignedTo", advancedFilters.assignedTo);
      const dfISO = safeToISO(advancedFilters.dateFrom);
      const dtISO = safeToISO(advancedFilters.dateTo);
      if (dfISO) url.searchParams.set("dateFrom", dfISO);
      if (dtISO) url.searchParams.set("dateTo", dtISO);
      url.searchParams.set("archived", showArchived ? "true" : "false");
      url.searchParams.set("aged", showAged ? "true" : "false");
      url.searchParams.set("sortField", sortField);
      url.searchParams.set("sortOrder", sortOrder);
      return (await apiRequest("GET", url.toString())).json();
    },
  });

  const leadsLoading = viewMode === "kanban" ? kanbanLoading : cardLoading;
  const leadsError = viewMode === "kanban" ? kanbanError : cardError;
  const refetchLeads = viewMode === "kanban" ? refetchKanban : refetchCard;

  const leads = useMemo((): Contact[] => {
    if (viewMode === "kanban") {
      return (kanbanData?.pages.flatMap((p: PaginatedContacts) => p.data) ?? []) as Contact[];
    }
    return (cardData?.data ?? []) as Contact[];
  }, [viewMode, kanbanData, cardData]);

  const leadContactIds = useMemo(() => leads.map((l) => l.id), [leads]);
  const unreadCounts = useUnreadCountsByContacts(leadContactIds);

  const totalLeads = viewMode === "kanban"
    ? (kanbanData?.pages[0]?.pagination.total ?? 0)
    : (cardData?.pagination?.total ?? 0);

  const totalPages = Math.ceil(totalLeads / PAGE_SIZE);

  const prevLeadsError = useRef(false);
  useEffect(() => {
    if (leadsError && !leadsLoading && leads.length > 0 && !prevLeadsError.current) {
      toast({
        title: "Refresh failed",
        description: "Could not refresh leads. Showing previously loaded data.",
        variant: "destructive",
      });
    }
    prevLeadsError.current = !!leadsError;
  }, [leadsError, leadsLoading, leads.length, toast]);

  useEntityDeepLink({
    entities: leads,
    isLoading: leadsLoading,
    urlSearch,
    fetchFn: (id) => apiRequest("GET", `/api/contacts/${id}`).then((r) => r.json()),
    onOpen: onOpenDetails,
    notFoundMsg: "lead",
  });

  const { data: statusCountsData, isLoading: statusCountsLoading } = useQuery<{
    all: number;
    new: number;
    contacted: number;
    scheduled: number;
    disqualified: number;
    lost: number;
  }>({
    queryKey: ["/api/contacts/status-counts", {
      type: "lead",
      search: debouncedSearch,
      assignedTo: advancedFilters.assignedTo,
      dateFrom: safeToISO(advancedFilters.dateFrom),
      dateTo: safeToISO(advancedFilters.dateTo),
      archived: showArchived,
      aged: showAged,
    }],
    queryFn: async () => {
      const params = new URLSearchParams({ type: "lead" });
      if (debouncedSearch) params.append("search", debouncedSearch);
      if (advancedFilters.assignedTo) params.append("assignedTo", advancedFilters.assignedTo);
      const dfISO = safeToISO(advancedFilters.dateFrom);
      const dtISO = safeToISO(advancedFilters.dateTo);
      if (dfISO) params.append("dateFrom", dfISO);
      if (dtISO) params.append("dateTo", dtISO);
      params.append("archived", showArchived ? "true" : "false");
      params.append("aged", showAged ? "true" : "false");
      return (await apiRequest("GET", `/api/contacts/status-counts?${params}`)).json();
    },
  });

  const statusCounts: LeadsStatusCounts = statusCountsData || {
    all: statusCountsLoading ? undefined : 0,
    new: statusCountsLoading ? undefined : 0,
    contacted: statusCountsLoading ? undefined : 0,
    scheduled: statusCountsLoading ? undefined : 0,
    disqualified: statusCountsLoading ? undefined : 0,
    lost: statusCountsLoading ? undefined : 0,
  };

  const leadById = useMemo(() => {
    const map = new Map<string, Contact>();
    for (const lead of leads) map.set(lead.id, lead);
    return map;
  }, [leads]);

  return {
    leads,
    leadsLoading,
    leadsError,
    refetchLeads,
    totalLeads,
    totalPages,
    statusCounts,
    leadById,
    leadContactIds,
    unreadCounts,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    PAGE_SIZE,
  };
}
