import { useMemo, useCallback, useEffect, useRef } from "react";
import { JobCard } from "@/components/JobCard";
import { CardSkeleton } from "@/components/CardSkeleton";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header-v2";
import { PageLayout } from "@/components/ui/page-layout";
import { Plus, Search, Briefcase, CalendarIcon } from "lucide-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { formatStatusLabel, formatEntityTitle } from "@/lib/utils";
import { useBulkActions } from "@/hooks/useBulkActions";
import { useBulkSelection } from "@/contexts/BulkSelectionContext";
import type { PaginatedJobs, Job, Contact } from "@shared/schema";
import { useTerminologyContext } from "@/contexts/TerminologyContext";
import { useUsers } from "@/hooks/useUsers";
import { useGlobalShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { useHousecallProIntegration } from "@/hooks/useHousecallProIntegration";
import { useHcpImport } from "@/hooks/useHcpImport";
import { useWebSocketInvalidation } from "@/hooks/useWebSocketInvalidation";
import { usePagePreferences } from "@/hooks/use-page-preferences";
import { useUnreadCountsByContacts } from "@/hooks/useUnreadCounts";
import { JOB_WS_INVALIDATIONS } from "@/hooks/useInvalidations";
import { useAddModalFromUrl } from "@/hooks/use-add-modal-from-url";
import { BulkActionToolbar } from "@/components/BulkActionToolbar";
import { FilterPanel } from "@/components/FilterPanel";
import { EmptyState } from "@/components/EmptyState";
import { JobDetailsModal, type JobListItem } from "@/components/JobDetailsModal";
import { HCPImportModal } from "@/components/HCPImportModal";
import { CreateJobModal } from "@/components/CreateJobModal";
import { DeleteConfirmDialog } from "@/components/DeleteConfirmDialog";
import { StatusFilterBar } from "@/components/StatusFilterBar";
import { PaginationBar } from "@/components/ui/pagination-bar";
import { invalidateJobs } from "@/hooks/useInvalidations";
import { useEntityModalState } from "@/hooks/useEntityModalState";
import { useFilterState } from "@/hooks/useFilterState";
import { useEntityDeepLink } from "@/hooks/useEntityDeepLink";

const JOB_STATUSES = ["scheduled", "in_progress", "completed", "cancelled"] as const;
const PAGE_SIZE = 9;

type ActiveJobModal =
  | { type: "add" }
  | { type: "details"; job: JobListItem }
  | { type: "delete"; job: JobListItem }
  | null;

export default function Jobs({ externalSearch = "" }: { externalSearch?: string }) {
  const { isHousecallProConfigured, syncStartDate } = useHousecallProIntegration();

  const {
    filterStatus,
    setFilterStatus,
    advancedFilters,
    setAdvancedFilters,
  } = usePagePreferences({ pageKey: "jobs" });

  const { debouncedSearch, page, setPage, urlSearch } = useFilterState({
    externalSearch,
    resetDeps: [filterStatus, advancedFilters.dateFrom, advancedFilters.dateTo],
  });

  const { activeModal, setActiveModal, closeModal } = useEntityModalState<ActiveJobModal>();

  const { toast } = useToast();

  const { importDateOpen, setImportDateOpen, selectedImportDate, setSelectedImportDate, handleConfirmImport } =
    useHcpImport({
      entityType: "jobs",
      syncStartDate,
      queryKeysToInvalidate: ["/api/jobs/paginated"],
    });

  useWebSocketInvalidation(JOB_WS_INVALIDATIONS);

  useAddModalFromUrl(() => setActiveModal({ type: "add" }));

  const terminology = useTerminologyContext();
  const { data: usersData } = useUsers();

  const {
    data: jobsData,
    isLoading: jobsLoading,
    isError: jobsError,
    refetch: refetchJobs,
  } = useQuery<PaginatedJobs>({
    queryKey: [
      "/api/jobs/paginated",
      {
        status: filterStatus,
        search: debouncedSearch,
        dateFrom: advancedFilters.dateFrom?.toISOString(),
        dateTo: advancedFilters.dateTo?.toISOString(),
        page,
      },
    ],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.append("limit", String(PAGE_SIZE));
      params.append("offset", String((page - 1) * PAGE_SIZE));
      if (filterStatus !== "all") params.append("status", filterStatus);
      if (debouncedSearch) params.append("search", debouncedSearch);
      if (advancedFilters.dateFrom) params.append("dateFrom", advancedFilters.dateFrom.toISOString());
      if (advancedFilters.dateTo) params.append("dateTo", advancedFilters.dateTo.toISOString());
      const res = await apiRequest("GET", `/api/jobs/paginated?${params}`);
      return res.json() as Promise<PaginatedJobs>;
    },
  });

  // Status counts come bundled with the paginated response — no separate round trip needed.
  // Falls back to zeros during initial load.
  const statusCounts: Record<string, number> = jobsData?.statusCounts ?? {
    all: 0, scheduled: 0, in_progress: 0, completed: 0, cancelled: 0,
  };

  const updateJobStatusMutation = useMutation({
    mutationFn: (data: { jobId: string; status: string }) =>
      apiRequest("PATCH", `/api/jobs/${data.jobId}/status`, { status: data.status }),
    onSuccess: () => {
      toast({ title: "Status Updated", description: "Job status has been successfully updated." });
      invalidateJobs();
    },
    onError: (error: Error) => {
      toast({ title: "Update Failed", description: error.message || "Failed to update job status", variant: "destructive" });
    },
  });

  const deleteJobMutation = useMutation({
    mutationFn: (jobId: string) => apiRequest("DELETE", `/api/jobs/${jobId}`),
    onSuccess: () => {
      toast({ title: "Job Deleted", description: "Job has been successfully deleted." });
      invalidateJobs();
      closeModal();
    },
    onError: (error: Error) => {
      toast({ title: "Failed to Delete Job", description: error.message || "Something went wrong.", variant: "destructive" });
    },
  });

  useGlobalShortcuts((type) => {
    if (type === "job") setActiveModal({ type: "add" });
  });

  const jobContactIds = useMemo(() => {
    const ids = (jobsData?.data ?? []).map((j) => j.contactId).filter(Boolean);
    return Array.from(new Set(ids));
  }, [jobsData]);
  const unreadCounts = useUnreadCountsByContacts(jobContactIds);

  const allJobs: JobListItem[] = useMemo(() =>
    (jobsData?.data ?? []).map((job) => ({
      id: job.id,
      title: formatEntityTitle('job', job.title),
      contactId: job.contactId,
      contactName: job.contactName,
      contactEmail: job.contactEmail ?? null,
      contactPhone: job.contactPhone ?? null,
      status: job.status,
      value: typeof job.value === "string" ? parseFloat(job.value) : job.value,
      scheduledDate: job.scheduledDate ? new Date(job.scheduledDate).toLocaleDateString() : "No date",
      type: job.type,
      priority: job.priority,
      estimatedHours: job.estimatedHours ?? null,
      externalSource: job.externalSource ?? undefined,
      externalId: job.externalId ?? undefined,
      estimateId: job.estimateId ?? undefined,
    })), [jobsData]);

  const totalJobs = jobsData?.pagination.total ?? 0;
  const totalPages = Math.ceil(totalJobs / PAGE_SIZE);

  const prevJobsError = useRef(false);
  useEffect(() => {
    if (jobsError && !jobsLoading && allJobs.length > 0 && !prevJobsError.current) {
      toast({
        title: "Refresh failed",
        description: "Could not refresh jobs. Showing previously loaded data.",
        variant: "destructive",
      });
    }
    prevJobsError.current = !!jobsError;
  }, [jobsError, jobsLoading, allJobs.length, toast]);

  useEntityDeepLink({
    entities: allJobs,
    isLoading: jobsLoading,
    urlSearch,
    fetchFn: async (id) => {
      const job: Job = await apiRequest("GET", `/api/jobs/${id}`).then((r) => r.json());
      let contact: Contact | null = null;
      if (job.contactId) {
        contact = await apiRequest("GET", `/api/contacts/${job.contactId}`).then((r) => r.json());
      }
      return {
        id: job.id,
        title: formatEntityTitle("job", job.title),
        contactId: job.contactId,
        contactName: contact?.name ?? "",
        contactEmail: contact?.emails?.[0] ?? null,
        contactPhone: contact?.phones?.[0] ?? null,
        status: job.status,
        value: typeof job.value === "string" ? parseFloat(job.value) : (job.value ?? 0),
        scheduledDate: job.scheduledDate ? new Date(job.scheduledDate).toLocaleDateString() : "No date",
        type: job.type,
        priority: job.priority,
        estimatedHours: job.estimatedHours ?? null,
        externalSource: job.externalSource ?? undefined,
        estimateId: job.estimateId ?? undefined,
      } as JobListItem;
    },
    onOpen: (job) => setActiveModal({ type: "details", job }),
    notFoundMsg: "job",
  });

  const handleStatusChange = useCallback((jobId: string, newStatus: string) => {
    updateJobStatusMutation.mutate({ jobId, status: newStatus });
  }, [updateJobStatusMutation]);

  const handleViewDetails = useCallback((jobId: string) => {
    const job = allJobs.find((j) => j.id === jobId);
    if (job) setActiveModal({ type: "details", job });
  }, [allJobs]);

  const handleDeleteJob = useCallback((jobId: string, _jobTitle?: string) => {
    const job = allJobs.find((j) => j.id === jobId);
    if (job) setActiveModal({ type: "delete", job });
  }, [allJobs]);

  const handleImportFromHousecallPro = () => {
    setActiveModal(null);
    setImportDateOpen(true);
  };

  const { selectedIds, toggleItem } = useBulkSelection();

  const { handleBulkDelete, handleBulkStatusChange, handleBulkExport } = useBulkActions({
    entityType: "job",
    deleteEndpoint: (id) => `/api/jobs/${id}`,
    statusEndpoint: (id) => `/api/jobs/${id}/status`,
    onInvalidate: invalidateJobs,
    exportFilename: `jobs-export-${new Date().toISOString().split("T")[0]}.csv`,
    exportHeaders: ["Title", "Customer", "Status", "Value", "Scheduled Date", "Type", "Priority", "Estimated Hours"],
    getExportRow: (job) => {
      const j = job as JobListItem;
      return [j.title, j.contactName, j.status, j.value, j.scheduledDate, j.type, j.priority, j.estimatedHours ?? ""];
    },
    entities: allJobs,
  });

  const jobLabel = terminology?.jobLabel || "Job";
  const jobsLabel = terminology?.jobsLabel || "Jobs";
  const isFiltered = !!(debouncedSearch || filterStatus !== "all");

  return (
    <PageLayout>
      <PageHeader
        title={jobsLabel}
        description="Track and manage all your service jobs and installations"
        actions={
          <div className="flex items-center gap-2">
            {isHousecallProConfigured && (
              <Button variant="outline" onClick={handleImportFromHousecallPro} data-testid="button-import-hcp">
                <CalendarIcon className="h-4 w-4 sm:mr-2" />
                <span className="hidden sm:inline">Import from Housecall Pro</span>
              </Button>
            )}
            <Button onClick={() => setActiveModal({ type: "add" })} data-testid="button-add-job">
              <Plus className="h-4 w-4 mr-2" />
              Add {jobLabel}
            </Button>
          </div>
        }
      />

      <div className="flex flex-col gap-4">
        <StatusFilterBar
          statuses={JOB_STATUSES}
          activeStatus={filterStatus}
          counts={statusCounts}
          onStatusChange={setFilterStatus}
        />

        <FilterPanel
          filters={advancedFilters}
          onFiltersChange={setAdvancedFilters}
          statusOptions={JOB_STATUSES.map((s) => ({ value: s, label: formatStatusLabel(s) }))}
          userOptions={usersData?.map((u) => ({ value: u.id, label: u.name })) ?? []}
          dateLabel="Scheduled Date"
        />
      </div>


      <div className="grid gap-4 sm:grid-cols-1 md:grid-cols-2 lg:grid-cols-2 xl:grid-cols-3">
        {jobsLoading
          ? Array.from({ length: 6 }).map((_, i) => <CardSkeleton key={`skeleton-${i}`} />)
          : allJobs.map((job) => (
              <JobCard
                key={job.id}
                job={job}
                onStatusChange={handleStatusChange}
                onViewDetails={handleViewDetails}
                onDelete={handleDeleteJob}
                selectable
                isSelected={selectedIds.has(job.id)}
                onToggleSelect={() => toggleItem(job.id, "jobs")}
                hasUnreadText={(unreadCounts[job.contactId]?.text ?? 0) > 0}
                hasUnreadEmail={(unreadCounts[job.contactId]?.email ?? 0) > 0}
              />
            ))}
      </div>

      {jobsError && !jobsLoading && allJobs.length === 0 && (
        <EmptyState
          icon={Search}
          title="Failed to load jobs"
          description="There was a problem loading your jobs."
          ctaLabel="Try Again"
          onCtaClick={() => refetchJobs()}
          ctaTestId="button-retry-jobs"
        />
      )}

      {!jobsLoading && totalPages > 0 && (
        <PaginationBar
          page={page}
          totalPages={totalPages}
          onPageChange={setPage}
          totalItems={totalJobs}
          pageSize={PAGE_SIZE}
        />
      )}

      {allJobs.length === 0 && !jobsLoading && !jobsError && (
        isFiltered ? (
          <EmptyState
            icon={Search}
            title="No jobs match your filters"
            description="Try adjusting your search criteria or filters to find more jobs."
            tips={[
              "Clear some filters to broaden your search",
              "Check your status and date range settings",
              "Try searching by job title or customer name",
            ]}
          />
        ) : (
          <EmptyState
            icon={Briefcase}
            title="No jobs yet"
            description="Create your first job to start tracking work and revenue."
            tips={[
              "Convert approved estimates into jobs automatically",
              "Create jobs manually for walk-in customers",
              "Jobs synced from Housecall Pro will appear here automatically",
            ]}
            ctaLabel="Create Your First Job"
            onCtaClick={() => setActiveModal({ type: "add" })}
            ctaTestId="button-add-first-job"
          />
        )
      )}

      <JobDetailsModal
        isOpen={activeModal?.type === "details"}
        job={activeModal?.type === "details" ? activeModal.job : undefined}
        onClose={closeModal}
      />

      <CreateJobModal
        isOpen={activeModal?.type === "add"}
        onClose={closeModal}
      />

      <HCPImportModal
        isOpen={importDateOpen}
        onClose={() => setImportDateOpen(false)}
        onConfirm={handleConfirmImport}
        selectedDate={selectedImportDate}
        onDateChange={setSelectedImportDate}
        entityLabel="jobs"
      />

      <BulkActionToolbar
        onDelete={handleBulkDelete}
        onStatusChange={handleBulkStatusChange}
        onExport={handleBulkExport}
        statusOptions={JOB_STATUSES.map((s) => ({ value: s, label: formatStatusLabel(s) }))}
      />

      <DeleteConfirmDialog
        isOpen={activeModal?.type === "delete"}
        onOpenChange={(open) => { if (!open) closeModal(); }}
        title="Delete Job"
        description={`Are you sure you want to delete "${activeModal?.type === "delete" ? activeModal.job.title : "this job"}"? This action cannot be undone.`}
        onConfirm={() => {
          if (activeModal?.type === "delete") {
            deleteJobMutation.mutate(activeModal.job.id);
          }
        }}
        confirmTestId="button-confirm-delete-job"
      />
    </PageLayout>
  );
}
