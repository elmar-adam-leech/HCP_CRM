import { useMemo, useCallback, useEffect, useRef } from "react";
import { WorkflowEnrollmentProvider } from "@/contexts/WorkflowEnrollmentContext";
import { EstimateCard } from "@/components/EstimateCard";
import { CardSkeleton } from "@/components/CardSkeleton";
import { EmailComposerModal } from "@/components/EmailComposerModal";
import { Button } from "@/components/ui/button";
import { DeleteConfirmDialog } from "@/components/DeleteConfirmDialog";
import { PageHeader } from "@/components/ui/page-header-v2";
import { PageLayout } from "@/components/ui/page-layout";
import { Plus, FileText, Download, Filter, AlertCircle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { formatStatusLabel, cn, formatEntityTitle, safeToISO } from "@/lib/utils";
import { useBulkActions } from "@/hooks/useBulkActions";
import type { PaginatedEstimates, EstimateSummary, Contact } from "@shared/schema";
import { useTerminologyContext } from "@/contexts/TerminologyContext";
import { useCommunicationActions } from "@/hooks/useCommunicationActions";
import { useGlobalShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { useHousecallProIntegration } from "@/hooks/useHousecallProIntegration";
import { useHcpImport } from "@/hooks/useHcpImport";
import { useWebSocketInvalidation } from "@/hooks/useWebSocketInvalidation";
import { invalidateEstimates, ESTIMATE_WS_INVALIDATIONS } from "@/hooks/useInvalidations";
import { useUnreadCountsByContacts } from "@/hooks/useUnreadCounts";
import { BulkActionToolbar } from "@/components/BulkActionToolbar";
import { StatusFilterBar } from "@/components/StatusFilterBar";
import { PaginationBar } from "@/components/ui/pagination-bar";
import { FilterPanel } from "@/components/FilterPanel";
import { useBulkSelection } from "@/contexts/BulkSelectionContext";
import { usePagePreferences } from "@/hooks/use-page-preferences";
import { useAddModalFromUrl } from "@/hooks/use-add-modal-from-url";
import { EmptyState } from "@/components/EmptyState";
import { CreateEstimateModal } from "@/components/CreateEstimateModal";
import { EditEstimateModal, type EditEstimateFormValues } from "@/components/EditEstimateModal";
import { FollowUpDateModal } from "@/components/FollowUpDateModal";
import { EstimateDetailsModal, type EstimateListItem } from "@/components/EstimateDetailsModal";
import type { EstimateCardItem } from "@/components/EstimateCard";
import { HCPImportModal } from "@/components/HCPImportModal";
import { useEstimateMutations } from "@/hooks/useEstimateMutations";
import { useEntityModalState } from "@/hooks/useEntityModalState";
import { useFilterState } from "@/hooks/useFilterState";
import { useEntityDeepLink } from "@/hooks/useEntityDeepLink";


const ESTIMATE_FILTER_STATUSES = ["scheduled", "in_progress", "sent", "approved", "rejected"] as const;
const PAGE_SIZE = 9;

const ESTIMATE_BULK_STATUSES = [
  { value: "scheduled", label: "Scheduled" },
  { value: "in_progress", label: "In Progress" },
  { value: "sent", label: "Sent" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
];

type ActiveEstimateModal =
  | { type: "add" }
  | { type: "edit"; estimate: EstimateSummary }
  | { type: "details"; estimate: EstimateListItem }
  | { type: "followUp"; estimate: EstimateCardItem }
  | { type: "delete"; estimateId: string; estimateTitle: string }
  | null;

export default function Estimates({ externalSearch = "" }: { externalSearch?: string }) {
  const { filterStatus, setFilterStatus, advancedFilters, setAdvancedFilters } =
    usePagePreferences({ pageKey: "estimates" });

  const { searchQuery, debouncedSearch, page, setPage, urlSearch } = useFilterState({
    externalSearch,
    resetDeps: [filterStatus, advancedFilters.dateFrom, advancedFilters.dateTo],
  });

  const { isSelectionMode, selectedIds, toggleItem } = useBulkSelection();

  const {
    emailModal,
    handleSendEmail,
    closeEmailModal,
  } = useCommunicationActions();

  const { toast } = useToast();
  const { activeModal, setActiveModal, closeModal } = useEntityModalState<ActiveEstimateModal>();

  const DATE_PRESETS = [
    { label: "30d", days: 30 },
    { label: "60d", days: 60 },
    { label: "90d", days: 90 },
    { label: "180d", days: 180 },
  ];

  const { updateEstimate, updateFollowUpDate, deleteEstimate } = useEstimateMutations({
    onEditSuccess: () => closeModal(),
    onFollowUpSuccess: () => closeModal(),
    onDeleteSuccess: () => closeModal(),
  });

  const terminology = useTerminologyContext();

  const estimateStatusOptions = useMemo(
    () => ESTIMATE_FILTER_STATUSES.map((s) => ({ value: s, label: formatStatusLabel(s) })),
    []
  );

  const { data: detailsContact } = useQuery<Contact>({
    queryKey: ["/api/contacts", activeModal?.type === "details" ? activeModal.estimate.contactId : undefined],
    enabled: activeModal?.type === "details" && !!activeModal.estimate.contactId,
  });

  const {
    data: estimatesData,
    isLoading: estimatesLoading,
    isError: estimatesError,
    refetch: refetchEstimates,
  } = useQuery<PaginatedEstimates>({
    queryKey: [
      "/api/estimates/paginated",
      {
        status: filterStatus,
        search: debouncedSearch,
        dateFrom: safeToISO(advancedFilters.dateFrom),
        dateTo: safeToISO(advancedFilters.dateTo),
        page,
      },
    ],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.append("limit", String(PAGE_SIZE));
      params.append("offset", String((page - 1) * PAGE_SIZE));
      if (filterStatus !== "all") params.append("status", filterStatus);
      if (debouncedSearch) params.append("search", debouncedSearch);
      const dfISO = safeToISO(advancedFilters.dateFrom);
      const dtISO = safeToISO(advancedFilters.dateTo);
      if (dfISO) params.append("dateFrom", dfISO);
      if (dtISO) params.append("dateTo", dtISO);
      return (await apiRequest("GET", `/api/estimates/paginated?${params}`)).json() as Promise<PaginatedEstimates>;
    },
  });

  const estimates = estimatesData?.data ?? [];
  const totalEstimates = estimatesData?.pagination.total ?? 0;
  const totalPages = Math.ceil(totalEstimates / PAGE_SIZE);

  // Status counts come bundled with the paginated response — no separate round trip needed.
  // Falls back to zeros during initial load.
  const statusCounts = estimatesData?.statusCounts ?? {
    all: 0, sent: 0, scheduled: 0, in_progress: 0, approved: 0, rejected: 0,
  };

  const prevEstimatesError = useRef(false);
  useEffect(() => {
    if (estimatesError && !estimatesLoading && estimates.length > 0 && !prevEstimatesError.current) {
      toast({
        title: "Refresh failed",
        description: "Could not refresh estimates. Showing previously loaded data.",
        variant: "destructive",
      });
    }
    prevEstimatesError.current = !!estimatesError;
  }, [estimatesError, estimatesLoading, estimates.length, toast]);

  const { isHousecallProConfigured, syncStartDate } = useHousecallProIntegration();

  useGlobalShortcuts((type) => {
    if (type === "estimate") setActiveModal({ type: "add" });
  });

  useAddModalFromUrl(() => setActiveModal({ type: "add" }));

  const { importDateOpen, setImportDateOpen, selectedImportDate, setSelectedImportDate, handleConfirmImport } =
    useHcpImport({
      entityType: "estimates",
      syncStartDate,
      queryKeysToInvalidate: ["/api/estimates/paginated", "/api/estimates/status-counts"],
    });

  useWebSocketInvalidation(ESTIMATE_WS_INVALIDATIONS);

  const estimateContactIds = useMemo(() => {
    const ids = (estimates || []).map((e) => e.contactId).filter(Boolean);
    return Array.from(new Set(ids));
  }, [estimates]);
  const unreadCounts = useUnreadCountsByContacts(estimateContactIds);

  const allEstimates: EstimateListItem[] = useMemo(() =>
    (estimates || []).map((e) => ({
      id: e.id,
      title: e.title,
      contactId: e.contactId,
      contactName: e.contactName,
      contactEmails: e.contactEmails ?? null,
      contactPhones: e.contactPhones ?? null,
      contactTags: e.contactTags ?? null,
      contactHasJobs: e.contactHasJobs ?? false,
      status: e.status,
      value: parseFloat(e.amount),
      createdDate: new Date(e.createdAt).toLocaleDateString(),
      expiryDate: e.validUntil ? new Date(e.validUntil).toLocaleDateString() : "No expiry",
      description: e.description || "",
      externalSource: e.externalSource ?? undefined,
      externalId: e.externalId ?? undefined,
      housecallProEstimateId: e.housecallProEstimateId ?? undefined,
      hcpOptions: e.hcpOptions ?? undefined,
    })),
    [estimates]
  );

  useEntityDeepLink({
    entities: allEstimates,
    isLoading: estimatesLoading,
    urlSearch,
    fetchFn: async (id) => {
      const e: EstimateSummary = await apiRequest("GET", `/api/estimates/${id}`).then((r) => r.json());
      return {
        id: e.id,
        title: e.title,
        contactId: e.contactId,
        contactName: e.contactName,
        contactEmails: e.contactEmails ?? null,
        contactPhones: e.contactPhones ?? null,
        contactTags: e.contactTags ?? null,
        contactHasJobs: e.contactHasJobs ?? false,
        status: e.status,
        value: parseFloat(e.amount),
        createdDate: new Date(e.createdAt).toLocaleDateString(),
        expiryDate: e.validUntil ? new Date(e.validUntil).toLocaleDateString() : "No expiry",
        description: e.description || "",
        externalSource: e.externalSource ?? undefined,
        externalId: e.externalId ?? undefined,
        housecallProEstimateId: e.housecallProEstimateId ?? undefined,
        hcpOptions: e.hcpOptions ?? undefined,
      } as EstimateListItem;
    },
    onOpen: (estimate) => setActiveModal({ type: "details", estimate }),
    notFoundMsg: "estimate",
  });

  const handleAddEstimate = useCallback(() => setActiveModal({ type: "add" }), []);

  const handleImportFromHousecallPro = useCallback(() => setImportDateOpen(true), []);

  const handleViewDetails = useCallback((estimateId: string) => {
    const estimate = (allEstimates || []).find((e) => e.id === estimateId);
    if (estimate) setActiveModal({ type: "details", estimate });
  }, [allEstimates]);

  const handleSendEmailByEntity = useCallback((estimate: EstimateCardItem) => {
    handleSendEmail(
      { id: estimate.id, contactId: estimate.contactId, name: estimate.contactName, emails: estimate.contactEmails ?? null, phones: estimate.contactPhones ?? null },
      "estimate"
    );
  }, [handleSendEmail]);

  const handleEditEstimate = useCallback((estimateId: string) => {
    const estimate = (estimates || []).find((e) => e.id === estimateId);
    if (estimate) setActiveModal({ type: "edit", estimate });
  }, [estimates]);

  const handleSetFollowUp = (estimate: EstimateCardItem) => {
    setActiveModal({ type: "followUp", estimate });
  };

  const handleDelete = useCallback((estimateId: string) => {
    const estimate = (estimates || []).find((e) => e.id === estimateId);
    if (!estimate) return;
    setActiveModal({ type: "delete", estimateId, estimateTitle: formatEntityTitle('estimate', estimate.title) });
  }, [estimates]);

  const handleEditSave = (values: EditEstimateFormValues) => {
    if (activeModal?.type !== "edit") return;
    const isExternal = activeModal.estimate.externalSource === 'housecall-pro';
    updateEstimate.mutate({ estimateId: activeModal.estimate.id, data: values, isExternal });
  };

  const handleFollowUpSave = (date: Date | null | undefined) => {
    if (activeModal?.type !== "followUp") return;
    updateFollowUpDate.mutate({
      estimateId: activeModal.estimate.id,
      followUpDate: date ?? null,
    });
  };

  const { handleBulkDelete, handleBulkStatusChange, handleBulkExport } = useBulkActions({
    entityType: "estimate",
    deleteEndpoint: (id) => `/api/estimates/${id}`,
    statusEndpoint: (id) => `/api/estimates/${id}/status`,
    onInvalidate: invalidateEstimates,
    exportFilename: `estimates-export-${new Date().toISOString().split("T")[0]}.csv`,
    exportHeaders: ["Title", "Customer", "Status", "Value", "Created Date", "Expiry Date"],
    getExportRow: (est) => {
      const e = est as EstimateListItem;
      return [e.title, e.contactName ?? undefined, e.status, e.value ?? undefined, e.createdDate ?? undefined, e.expiryDate ?? undefined];
    },
    entities: allEstimates,
  });

  return (
    <PageLayout className={cn(isSelectionMode && "pb-20")}>
      <PageHeader
        title={terminology?.estimatesLabel || "Estimates"}
        description="Create and manage estimates for potential jobs"
        actions={
          <div className="flex items-center gap-2">
            {isHousecallProConfigured && (
              <Button variant="outline" onClick={handleImportFromHousecallPro} data-testid="button-import-hcp-estimates">
                <Download className="h-4 w-4 sm:mr-2" />
                <span className="hidden sm:inline">Import from Housecall Pro</span>
              </Button>
            )}
            <Button onClick={handleAddEstimate} data-testid="button-add-estimate">
              <Plus className="h-4 w-4 mr-2" />
              Add {terminology?.estimateLabel || "Estimate"}
            </Button>
          </div>
        }
      />

      <div className="flex flex-col gap-4">
        <StatusFilterBar
          statuses={ESTIMATE_FILTER_STATUSES}
          activeStatus={filterStatus}
          counts={statusCounts}
          onStatusChange={setFilterStatus}
        />

        <FilterPanel
          filters={advancedFilters}
          onFiltersChange={setAdvancedFilters}
          statusOptions={estimateStatusOptions}
          dateLabel="Created Date"
          datePresets={DATE_PRESETS}
        />
      </div>

      <WorkflowEnrollmentProvider contactIds={estimateContactIds}>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {allEstimates.map((estimate) => (
            <EstimateCard
              key={estimate.id}
              estimate={estimate}
              onViewDetails={handleViewDetails}
              onSetFollowUp={handleSetFollowUp}
              onEdit={handleEditEstimate}
              onSendEmail={handleSendEmailByEntity}
              onDelete={handleDelete}
              selectable={true}
              isSelected={selectedIds.has(estimate.id)}
              onToggleSelect={() => toggleItem(estimate.id, "estimates")}
              hasUnreadText={(unreadCounts[estimate.contactId]?.text ?? 0) > 0}
              hasUnreadEmail={(unreadCounts[estimate.contactId]?.email ?? 0) > 0}
            />
          ))}
        </div>
      </WorkflowEnrollmentProvider>

      {estimatesLoading && allEstimates.length === 0 && (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, index) => (
            <CardSkeleton key={index} lines={4} showMultilineBlock showBadges />
          ))}
        </div>
      )}

      {estimatesError && !estimatesLoading && allEstimates.length === 0 && (
        <EmptyState
          icon={AlertCircle}
          title="Failed to load estimates"
          description="There was a problem loading your estimates."
          ctaLabel="Try Again"
          onCtaClick={() => refetchEstimates()}
          ctaTestId="button-retry-estimates"
        />
      )}

      {!estimatesLoading && totalPages > 0 && (
        <PaginationBar
          page={page}
          totalPages={totalPages}
          onPageChange={setPage}
          totalItems={totalEstimates}
          pageSize={PAGE_SIZE}
        />
      )}

      {allEstimates.length === 0 && !estimatesLoading && !estimatesError &&
        (searchQuery || filterStatus !== "all" ? (
          <EmptyState
            icon={Filter}
            title="No estimates match your filters"
            description="Try adjusting your search criteria or filters to find more estimates."
            tips={[
              "Clear some filters to broaden your search",
              "Check your date range settings",
              "Try searching by customer name or estimate title",
            ]}
          />
        ) : (
          <EmptyState
            icon={FileText}
            title="No estimates yet"
            description="Create your first estimate to send pricing proposals to customers."
            tips={[
              "Estimates help you provide formal quotes to potential customers",
              "Track estimate status from sent to approved or rejected",
              "Convert approved estimates directly into jobs automatically",
            ]}
            ctaLabel="Create Your First Estimate"
            onCtaClick={handleAddEstimate}
            ctaTestId="button-add-first-estimate"
          />
        ))}

      <EditEstimateModal
        isOpen={activeModal?.type === "edit"}
        estimate={activeModal?.type === "edit" ? activeModal.estimate : undefined}
        onClose={closeModal}
        onSave={handleEditSave}
        isSaving={updateEstimate.isPending}
      />

      <CreateEstimateModal
        isOpen={activeModal?.type === "add"}
        onClose={closeModal}
      />

      <EstimateDetailsModal
        isOpen={activeModal?.type === "details"}
        onClose={closeModal}
        estimate={activeModal?.type === "details" ? activeModal.estimate : undefined}
        detailsContact={detailsContact}
        onSendEmail={() => {
          if (activeModal?.type !== "details") return;
          const est = activeModal.estimate;
          handleSendEmail(
            {
              id: est.id,
              contactId: est.contactId,
              name: detailsContact?.name || est.contactName,
              emails: detailsContact?.emails ?? est.contactEmails ?? null,
              phones: detailsContact?.phones ?? est.contactPhones ?? null,
            },
            "estimate"
          );
        }}
        hasUnreadText={
          activeModal?.type === "details"
            ? (unreadCounts[activeModal.estimate.contactId]?.text ?? 0) > 0
            : false
        }
        hasUnreadEmail={
          activeModal?.type === "details"
            ? (unreadCounts[activeModal.estimate.contactId]?.email ?? 0) > 0
            : false
        }
      />

      <EmailComposerModal
        isOpen={emailModal.isOpen}
        onClose={closeEmailModal}
        recipientName={emailModal.estimate?.name || ""}
        recipientEmail={emailModal.estimate?.emails?.[0] || emailModal.estimate?.email || ""}
        recipientPhone={emailModal.estimate?.phones?.[0] || emailModal.estimate?.phone || ""}
        contactId={emailModal.estimate?.contactId}
        estimateId={emailModal.estimate?.id}
      />

      <HCPImportModal
        isOpen={importDateOpen}
        onClose={() => setImportDateOpen(false)}
        onConfirm={handleConfirmImport}
        selectedDate={selectedImportDate}
        onDateChange={setSelectedImportDate}
        entityLabel="estimates"
      />

      <FollowUpDateModal
        isOpen={activeModal?.type === "followUp"}
        onClose={closeModal}
        onSave={handleFollowUpSave}
        entityName={activeModal?.type === "followUp" ? formatEntityTitle('estimate', activeModal.estimate.title) : undefined}
        isSaving={updateFollowUpDate.isPending}
      />

      <BulkActionToolbar
        onDelete={handleBulkDelete}
        onStatusChange={handleBulkStatusChange}
        onExport={handleBulkExport}
        statusOptions={ESTIMATE_BULK_STATUSES}
      />

      <DeleteConfirmDialog
        isOpen={activeModal?.type === "delete"}
        onOpenChange={(open) => { if (!open) closeModal(); }}
        title="Delete Estimate"
        description={`Are you sure you want to delete "${activeModal?.type === "delete" ? activeModal.estimateTitle : "this estimate"}"? This action cannot be undone.`}
        onConfirm={() => {
          if (activeModal?.type === "delete") {
            deleteEstimate.mutate(activeModal.estimateId);
          }
        }}
        confirmTestId="button-confirm-delete-estimate"
      />
    </PageLayout>
  );
}