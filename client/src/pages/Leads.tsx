import { useState, useMemo, useCallback, useEffect } from "react";
import { useLocation } from "wouter";
import { LeadCard } from "@/components/LeadCard";
import { CardSkeleton } from "@/components/CardSkeleton";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/ui/page-header-v2";
import { PageLayout } from "@/components/ui/page-layout";
import { Plus, UserPlus, AlertCircle, Archive, ArchiveRestore, UserCheck, Clock, ArrowUp, ArrowDown, Filter } from "lucide-react";
import { LeadKanbanBoard } from "@/components/LeadKanbanBoard";
import { LeadSpreadsheetView } from "@/components/LeadSpreadsheetView";
import type { Contact } from "@shared/schema";
import { useTerminologyContext } from "@/contexts/TerminologyContext";
import { WorkflowEnrollmentProvider } from "@/contexts/WorkflowEnrollmentContext";
import { useUsers } from "@/hooks/useUsers";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { cn, formatStatusLabel } from "@/lib/utils";
import { useWebSocketInvalidation } from "@/hooks/useWebSocketInvalidation";
import { CONTACT_WS_INVALIDATIONS } from "@/hooks/useInvalidations";
import { useCommunicationActions } from "@/hooks/useCommunicationActions";
import { useGlobalShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { useIsMobile } from "@/hooks/use-mobile";
import { BulkActionToolbar } from "@/components/BulkActionToolbar";
import { StatusFilterBar } from "@/components/StatusFilterBar";
import { PaginationBar } from "@/components/ui/pagination-bar";
import { ViewToggle } from "@/components/ViewToggle";
import { useBulkSelection } from "@/contexts/BulkSelectionContext";
import { FilterPanelTrigger, FilterPanelChips } from "@/components/FilterPanel";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState } from "@/components/EmptyState";
import { usePagePreferences } from "@/hooks/use-page-preferences";
import { useAddModalFromUrl } from "@/hooks/use-add-modal-from-url";
import { useEntityModalState } from "@/hooks/useEntityModalState";
import { useFilterState } from "@/hooks/useFilterState";
import { useLeadsData } from "@/hooks/useLeadsData";
import { useLeadActions } from "@/hooks/useLeadActions";
import { LeadModals } from "@/components/LeadModals";
import type { LeadActiveModal } from "@/types/leadTypes";

const LEAD_STATUSES = ["new", "following up", "scheduled", "disqualified", "lost"] as const;

type LeadViewMode = "active" | "archived" | "aged";

export default function Leads({ externalSearch = "" }: { externalSearch?: string }) {
  const [leadViewMode, setLeadViewMode] = useState<LeadViewMode>("active");
  const showArchived = leadViewMode === "archived";
  const showAged = leadViewMode === "aged";

  const isMobile = useIsMobile();
  const { viewMode: savedViewMode, setViewMode, filterStatus, setFilterStatus, advancedFilters, setAdvancedFilters, sortBy, setSortBy, sortOrder, setSortOrder } =
    usePagePreferences({ pageKey: "leads", defaultSortBy: "lastActivity" });
  const viewMode: "cards" | "spreadsheet" | "kanban" =
    isMobile
      ? "cards"
      : (savedViewMode === "sales-process" ? "cards" : savedViewMode);

  const {
    emailModal,
    schedulingModal,
    handleSendEmail,
    handleSchedule,
    closeEmailModal,
    closeSchedulingModal,
  } = useCommunicationActions();

  const { isSelectionMode, selectedIds, toggleItem } = useBulkSelection();

  const [addContactModal, setAddContactModal] = useState(false);
  const { activeModal, setActiveModal, closeModal } = useEntityModalState<LeadActiveModal>();

  const { searchQuery, debouncedSearch, page, setPage, urlSearch } = useFilterState({
    externalSearch,
    resetDeps: [filterStatus, advancedFilters.assignedTo, advancedFilters.dateFrom, advancedFilters.dateTo, leadViewMode],
  });

  const sortField = (sortBy || "lastActivity") as "lastActivity" | "createdDate";
  const currentSortOrder = (sortOrder || "desc") as "asc" | "desc";

  const handleSortFieldChange = useCallback((value: string) => {
    setSortBy(value);
    setSortOrder("desc");
    setPage(1);
  }, [setPage, setSortBy, setSortOrder]);

  const handleSortDirectionToggle = useCallback(() => {
    setSortOrder(currentSortOrder === "desc" ? "asc" : "desc");
    setPage(1);
  }, [currentSortOrder, setSortOrder, setPage]);

  const handleCreatedDateSortChange = useCallback(() => {
    if (sortField !== "createdDate") {
      setSortBy("createdDate");
      setSortOrder("desc");
    } else {
      setSortOrder(sortOrder === "desc" ? "asc" : "desc");
    }
    setPage(1);
  }, [setPage, sortField, sortOrder, setSortBy, setSortOrder]);

  const terminology = useTerminologyContext();
  const { data: usersData } = useUsers();
  const { data: currentUserData } = useCurrentUser();
  const currentUserId = currentUserData?.user?.id;

  const leadStatusOptions = useMemo(
    () => LEAD_STATUSES.map((s) => ({ value: s, label: formatStatusLabel(s) })),
    []
  );
  const leadUserOptions = useMemo(
    () => usersData?.map((u) => ({ value: u.id, label: u.name })) ?? [],
    [usersData]
  );

  useGlobalShortcuts((type) => {
    if (type === "lead") setAddContactModal(true);
  });

  useWebSocketInvalidation(CONTACT_WS_INVALIDATIONS);

  useAddModalFromUrl(() => setAddContactModal(true));

  const {
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
  } = useLeadsData({
    viewMode,
    filterStatus,
    debouncedSearch,
    advancedFilters,
    showArchived,
    showAged,
    page,
    sortField,
    sortOrder: currentSortOrder,
    urlSearch,
    onOpenDetails: (contact) => setActiveModal({ type: "details", contact }),
  });

  const {
    deleteContact,
    updateContactStatus,
    archiveLead,
    restoreLead,
    ageLead,
    unageLead,
    updateFollowUpDate,
    handleScheduleById,
    handleSendEmailByEntity,
    handleEdit,
    handleDelete,
    handleViewDetails,
    handleEditStatus,
    handleSetFollowUp,
    handleFollowUpSubmit,
    handleStatusChange,
    handleBulkDelete,
    handleBulkStatusChange,
    handleBulkExport,
    handleBulkAge,
    handleBulkUnage,
    handleBulkArchive,
    handleBulkRestore,
  } = useLeadActions({
    leadById,
    activeModal,
    setActiveModal,
    closeModal,
    handleSchedule,
    handleSendEmail,
    leads,
  });

  const handleAutoOpenDetails = useCallback(async (contactId: string) => {
    try {
      const res = await apiRequest("GET", `/api/contacts/${contactId}`);
      const contact = await res.json();
      setActiveModal({ type: "details", contact });
    } catch {
      const cached = leadById.get(contactId);
      if (cached) {
        setActiveModal({ type: "details", contact: cached });
      }
    }
  }, [setActiveModal, leadById]);

  // Open the detail panel automatically when navigated here with `?id=…` —
  // used by the Recent Activity timeline so reps land directly on the matched lead.
  const [location] = useLocation();
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const id = params.get("id");
    if (!id) return;
    handleAutoOpenDetails(id);
    params.delete("id");
    const nextSearch = params.toString();
    const nextUrl = nextSearch ? `${location}?${nextSearch}` : location;
    window.history.replaceState({}, "", nextUrl);
    // Run only when the location pathname changes (or on first mount).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location]);

  const handleTextSentRefresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['/api/contacts/paginated'] });
    queryClient.invalidateQueries({ queryKey: ['/api/messages/unread-counts'] });
    queryClient.invalidateQueries({ queryKey: ['/api/messages/unread-summary'] });
  }, []);

  return (
    <PageLayout className={cn(isSelectionMode && "pb-20")}>
      <PageHeader
        title={showArchived ? `Archived ${terminology?.leadsLabel || "Leads"}` : showAged ? `Aged ${terminology?.leadsLabel || "Leads"}` : (terminology?.leadsLabel || "Leads")}
        description={showArchived ? "Archived leads are preserved but hidden from the main view" : showAged ? "Aged leads are older leads kept for monitoring — they remain fully interactive" : "Manage and track potential customers and sales opportunities"}
        actions={
          <div className="flex items-center gap-2 flex-wrap">
            {!showArchived && (
              <Button
                variant="outline"
                onClick={() => setLeadViewMode("archived")}
                data-testid="button-toggle-archived"
              >
                <Archive className="h-4 w-4 mr-2" />
                <span className="hidden sm:inline">Archived</span>
              </Button>
            )}
            {!showAged && (
              <Button
                variant="outline"
                onClick={() => setLeadViewMode("aged")}
                data-testid="button-toggle-aged"
              >
                <Clock className="h-4 w-4 mr-2" />
                <span className="hidden sm:inline">Aged</span>
              </Button>
            )}
            {(showArchived || showAged) && (
              <Button
                variant="default"
                onClick={() => setLeadViewMode("active")}
                data-testid="button-show-active"
              >
                <ArchiveRestore className="h-4 w-4 mr-2" />
                <span className="hidden sm:inline">Show Active</span>
              </Button>
            )}
            {leadViewMode === "active" && (
              <Button onClick={() => setAddContactModal(true)} data-testid="button-add-lead">
                <Plus className="h-4 w-4 mr-2" />
                <span className="hidden sm:inline">Add {terminology?.leadLabel || "Lead"}</span>
                <span className="sm:hidden">Add</span>
              </Button>
            )}
          </div>
        }
      />

      <div className="flex flex-col gap-4 min-w-0">
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          {!isMobile && <ViewToggle viewMode={viewMode} onViewModeChange={setViewMode} />}

          {viewMode === "cards" && (
            <div className="flex items-center gap-1">
              <Select value={sortField} onValueChange={handleSortFieldChange}>
                <SelectTrigger className="w-auto gap-1.5 h-8 text-xs" data-testid="select-sort-field">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="lastActivity">Last Activity</SelectItem>
                  <SelectItem value="createdDate">Created Date</SelectItem>
                </SelectContent>
              </Select>
              <Button
                size="icon"
                variant="outline"
                className="h-8 w-8"
                onClick={handleSortDirectionToggle}
                data-testid="button-sort-direction"
              >
                {currentSortOrder === "asc" ? (
                  <ArrowUp className="h-3.5 w-3.5" />
                ) : (
                  <ArrowDown className="h-3.5 w-3.5" />
                )}
              </Button>
            </div>
          )}

          {viewMode === "kanban" && currentUserId && (
            <Badge
              variant={advancedFilters.assignedTo === currentUserId ? "default" : "outline"}
              className="cursor-pointer hover-elevate"
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); const isActive = advancedFilters.assignedTo === currentUserId; setAdvancedFilters({ ...advancedFilters, assignedTo: isActive ? undefined : currentUserId }); } }}
              onClick={() => {
                const isActive = advancedFilters.assignedTo === currentUserId;
                setAdvancedFilters({ ...advancedFilters, assignedTo: isActive ? undefined : currentUserId });
              }}
              data-testid="button-assigned-to-me"
            >
              <UserCheck className="h-3 w-3 mr-1" />
              Assigned to Me
            </Badge>
          )}

          <div className="flex-1" />

          {(viewMode === "cards" || viewMode === "spreadsheet") && (
            <FilterPanelTrigger
              filters={advancedFilters}
              onFiltersChange={setAdvancedFilters}
              statusOptions={leadStatusOptions}
              userOptions={leadUserOptions}
              dateLabel="Activity Date"
            />
          )}
        </div>

        {(viewMode === "cards" || viewMode === "spreadsheet") && (
          <>
            <StatusFilterBar
              statuses={LEAD_STATUSES}
              activeStatus={filterStatus}
              counts={statusCounts}
              onStatusChange={setFilterStatus}
              extraFilters={currentUserId && (
                <Badge
                  variant={advancedFilters.assignedTo === currentUserId ? "default" : "outline"}
                  className="cursor-pointer hover-elevate"
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); const isActive = advancedFilters.assignedTo === currentUserId; setAdvancedFilters({ ...advancedFilters, assignedTo: isActive ? undefined : currentUserId }); } }}
                  onClick={() => {
                    const isActive = advancedFilters.assignedTo === currentUserId;
                    setAdvancedFilters({ ...advancedFilters, assignedTo: isActive ? undefined : currentUserId });
                  }}
                  data-testid="button-assigned-to-me"
                >
                  <UserCheck className="h-3 w-3 mr-1" />
                  Assigned to Me
                </Badge>
              )}
            />

            <FilterPanelChips
              filters={advancedFilters}
              onFiltersChange={setAdvancedFilters}
              statusOptions={leadStatusOptions}
              userOptions={leadUserOptions}
            />
          </>
        )}
      </div>

      {viewMode === "kanban" && leads.length > 0 && (
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <span>Showing {leads.length} of {totalLeads} {terminology?.leadsLabel?.toLowerCase() || "leads"}</span>
          {hasNextPage && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => fetchNextPage()}
              disabled={isFetchingNextPage}
            >
              {isFetchingNextPage ? "Loading..." : "Load More"}
            </Button>
          )}
        </div>
      )}

      <WorkflowEnrollmentProvider contactIds={leadContactIds}>
        {viewMode === "cards" && (
          <div
            className="grid gap-4 sm:grid-cols-1 md:grid-cols-2 lg:grid-cols-2 xl:grid-cols-3 min-w-0"
            data-testid="leads-grid"
          >
            {leadsLoading && Array.from({ length: 6 }, (_, i) => (
              <CardSkeleton key={`skeleton-${i}`} />
            ))}

            {!leadsLoading && leads.map((lead: Contact) => (
              <LeadCard
                key={lead.id}
                lead={lead}
                onSchedule={handleScheduleById}
                onSendEmail={handleSendEmailByEntity}
                onEdit={handleEdit}
                onDelete={handleDelete}
                onArchive={showArchived || showAged ? undefined : archiveLead.mutate}
                onRestore={showArchived ? restoreLead.mutate : undefined}
                onAge={showArchived || showAged ? undefined : ageLead.mutate}
                onUnage={showAged ? unageLead.mutate : undefined}
                onEditStatus={handleEditStatus}
                onViewDetails={handleViewDetails}
                onSetFollowUp={handleSetFollowUp}
                selectable
                isSelected={selectedIds.has(lead.id)}
                onToggleSelect={() => toggleItem(lead.id, "leads")}
                hasUnreadText={(unreadCounts[lead.id]?.text ?? 0) > 0}
                hasUnreadEmail={(unreadCounts[lead.id]?.email ?? 0) > 0}
                onTextSent={handleTextSentRefresh}
                onCallCompleted={() => handleAutoOpenDetails(lead.id)}
              />
            ))}
          </div>
        )}

        {viewMode === "spreadsheet" && (
          <LeadSpreadsheetView
            leads={leads}
            isLoading={leadsLoading}
            onLeadClick={handleViewDetails}
            onEdit={handleEdit}
            onDelete={handleDelete}
            onArchive={showArchived || showAged ? undefined : archiveLead.mutate}
            onRestore={showArchived ? restoreLead.mutate : undefined}
            onAge={showArchived || showAged ? undefined : ageLead.mutate}
            onUnage={showAged ? unageLead.mutate : undefined}
            onEditStatus={handleEditStatus}
            onSetFollowUp={handleSetFollowUp}
            onSchedule={handleScheduleById}
            sortDir={sortField === "createdDate" ? currentSortOrder : null}
            onSortChange={handleCreatedDateSortChange}
            onEmailSent={handleAutoOpenDetails}
            onTextSent={handleTextSentRefresh}
            onCallCompleted={handleAutoOpenDetails}
            unreadCounts={unreadCounts}
          />
        )}

        {viewMode === "kanban" && (
          <LeadKanbanBoard
            leads={leads}
            onStatusChange={handleStatusChange}
            onViewDetails={handleViewDetails}
            onEdit={handleEdit}
            onSchedule={handleScheduleById}
            onSendEmail={handleSendEmailByEntity}
            onEditStatus={handleEditStatus}
            onSetFollowUp={handleSetFollowUp}
            onDelete={handleDelete}
            onTextSent={handleTextSentRefresh}
            onCallCompleted={handleAutoOpenDetails}
            unreadCounts={unreadCounts}
          />
        )}
      </WorkflowEnrollmentProvider>

      {(viewMode === "cards" || viewMode === "spreadsheet") && !leadsLoading && totalPages > 0 && (
        <PaginationBar
          page={page}
          totalPages={totalPages}
          onPageChange={setPage}
          totalItems={totalLeads}
          pageSize={PAGE_SIZE}
        />
      )}

      {leadsError && !leadsLoading && leads.length === 0 && (
        <EmptyState
          icon={AlertCircle}
          title="Failed to load leads"
          description="There was a problem loading your leads."
          ctaLabel="Try Again"
          onCtaClick={() => refetchLeads()}
          ctaTestId="button-retry-leads"
        />
      )}

      {leads.length === 0 && !leadsLoading && !leadsError && (
        filterStatus !== "all" || searchQuery ? (
          <EmptyState
            icon={Filter}
            title="No leads match your filters"
            description="Try adjusting your search criteria or filters to find more leads."
            tips={[
              "Clear some filters to broaden your search",
              "Check your search term for typos",
              "Try searching by customer name, email, or phone number",
            ]}
          />
        ) : (
          <EmptyState
            icon={UserPlus}
            title="No leads yet"
            description="Start building your pipeline by adding your first lead."
            tips={[
              "Manually add leads from phone calls or website inquiries",
              "Import leads from a CSV file using the import button",
              "Connect Zapier to automatically create leads from form submissions",
            ]}
            ctaLabel="Add Your First Lead"
            onCtaClick={() => setAddContactModal(true)}
            ctaTestId="button-add-first-lead"
          />
        )
      )}

      <LeadModals
        activeModal={activeModal}
        closeModal={closeModal}
        emailModal={emailModal}
        closeEmailModal={closeEmailModal}
        schedulingModal={schedulingModal}
        closeSchedulingModal={closeSchedulingModal}
        addContactModal={addContactModal}
        setAddContactModal={setAddContactModal}
        leads={leads}
        handleViewDetails={handleViewDetails}
        handleFollowUpSubmit={handleFollowUpSubmit}
        deleteContact={deleteContact}
        updateContactStatus={updateContactStatus}
        updateFollowUpDate={updateFollowUpDate}
        onScheduleFromDetails={(contact) => handleSchedule(contact)}
        onSendEmailFromDetails={handleSendEmailByEntity}
        onEditFromDetails={(contact) => setActiveModal({ type: "edit", contact })}
        onEditStatusFromDetails={(contact) => setActiveModal({ type: "editStatus", contact })}
        onSetFollowUpFromDetails={handleSetFollowUp}
        onEmailSent={handleAutoOpenDetails}
        onTextSent={handleTextSentRefresh}
        onCallCompleted={handleAutoOpenDetails}
      />

      <BulkActionToolbar
        onDelete={handleBulkDelete}
        onStatusChange={handleBulkStatusChange}
        onExport={handleBulkExport}
        onArchive={showArchived || showAged ? undefined : handleBulkArchive}
        onRestore={showArchived ? handleBulkRestore : undefined}
        onAge={showArchived || showAged ? undefined : handleBulkAge}
        onUnage={showAged ? handleBulkUnage : undefined}
        statusOptions={leadStatusOptions}
      />
    </PageLayout>
  );
}
