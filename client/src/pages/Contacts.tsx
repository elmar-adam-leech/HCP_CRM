import { useState, useCallback, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { PageHeader } from "@/components/ui/page-header-v2";
import { PageLayout } from "@/components/ui/page-layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DeleteConfirmDialog } from "@/components/DeleteConfirmDialog";
import { PaginationBar } from "@/components/ui/pagination-bar";
import { Search, GitMerge, X, Clock } from "lucide-react";
import type { Contact } from "@shared/schema";
import { useWebSocketInvalidation } from "@/hooks/useWebSocketInvalidation";
import { useCurrentUser, isStrictAdmin } from "@/hooks/useCurrentUser";
import { ContactMergeDialog } from "@/components/contacts/ContactMergeDialog";
import { ContactExportDialog } from "@/components/contacts/ContactExportDialog";
import { ContactPurgeDialog } from "@/components/contacts/ContactPurgeDialog";
import { ContactDetailSheet } from "@/components/contacts/ContactDetailSheet";
import { ContactGrid } from "@/components/contacts/ContactGrid";

type ContactWithCounts = Contact & {
  leadCount: number;
  estimateCount: number;
  jobCount: number;
  allLeadsArchived?: boolean;
  anyLeadAged?: boolean;
};

type ContactsResponse = {
  data: ContactWithCounts[];
  pagination: { total: number; hasMore: boolean; nextCursor: string | null };
};

const PAGE_SIZE = 9;

export default function Contacts() {
  const [searchQuery, setSearchQuery] = useState("");
  const [page, setPage] = useState(1);
  const [detailContact, setDetailContact] = useState<ContactWithCounts | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{ isOpen: boolean; contactId?: string; contactName?: string }>({ isOpen: false });
  const [mergeMode, setMergeMode] = useState(false);
  const [selectedForMerge, setSelectedForMerge] = useState<ContactWithCounts[]>([]);
  const [mergeDialogOpen, setMergeDialogOpen] = useState(false);
  const [mergePrimaryId, setMergePrimaryId] = useState<string | null>(null);
  const [retentionView, setRetentionView] = useState(false);
  const [eraseDialogOpen, setEraseDialogOpen] = useState(false);
  const [eraseReason, setEraseReason] = useState("");
  const [eraseContact, setEraseContact] = useState<ContactWithCounts | null>(null);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [exportJson, setExportJson] = useState("");
  const [exportContactId, setExportContactId] = useState("");
  const [exportLoading, setExportLoading] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: currentUser } = useCurrentUser();
  const isAdmin = isStrictAdmin(currentUser?.user?.role);

  useEffect(() => {
    setPage(1);
  }, [searchQuery, retentionView]);

  useWebSocketInvalidation([
    { types: ["contact_created", "contact_updated", "contact_deleted"], queryKeys: ["/api/contacts/with-counts"] },
  ]);

  const offset = (page - 1) * PAGE_SIZE;

  const { data, isLoading, isError } = useQuery<ContactsResponse>({
    queryKey: ["/api/contacts/with-counts", { search: searchQuery, offset, limit: PAGE_SIZE }],
    queryFn: async () => {
      const url = new URL("/api/contacts/with-counts", window.location.origin);
      if (searchQuery) url.searchParams.set("search", searchQuery);
      url.searchParams.set("offset", String(offset));
      url.searchParams.set("limit", String(PAGE_SIZE));
      return (await apiRequest("GET", url.toString())).json() as Promise<ContactsResponse>;
    },
    enabled: !retentionView,
  });

  const { data: retentionData, isLoading: retentionLoading } = useQuery<ContactsResponse>({
    queryKey: ["/api/contacts/paginated", { retentionFlagged: true, offset, limit: PAGE_SIZE }],
    queryFn: async () => {
      const url = new URL("/api/contacts/paginated", window.location.origin);
      url.searchParams.set("retentionFlagged", "true");
      url.searchParams.set("includeAll", "true");
      url.searchParams.set("offset", String(offset));
      url.searchParams.set("limit", String(PAGE_SIZE));
      return (await apiRequest("GET", url.toString())).json() as Promise<ContactsResponse>;
    },
    enabled: retentionView,
  });

  const activeData = retentionView ? retentionData : data;
  const activeLoading = retentionView ? retentionLoading : isLoading;

  const contacts = activeData?.data ?? [];
  const total = activeData?.pagination.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  useEffect(() => {
    if (page > totalPages && totalPages >= 1) {
      setPage(totalPages);
    }
  }, [page, totalPages]);

  const deleteMutation = useMutation({
    mutationFn: async (contactId: string) => {
      return apiRequest("DELETE", `/api/contacts/${contactId}`);
    },
    onSuccess: () => {
      toast({ title: "Contact Deleted", description: "The contact and all associated records have been permanently deleted." });
      queryClient.invalidateQueries({ queryKey: ["/api/contacts/with-counts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/contacts/paginated"] });
      queryClient.invalidateQueries({ queryKey: ["/api/contacts/status-counts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
      setDeleteConfirm({ isOpen: false });
      setDetailContact(null);
    },
    onError: (error: Error) => {
      toast({ title: "Failed to Delete", description: error.message || "Something went wrong.", variant: "destructive" });
    },
  });

  const mergeMutation = useMutation({
    mutationFn: async ({ primaryId, secondaryId }: { primaryId: string; secondaryId: string }) =>
      (await apiRequest("POST", "/api/contacts/merge", { primaryId, secondaryId })).json(),
    onSuccess: () => {
      toast({ title: "Contacts Merged", description: "Records have been combined under one contact." });
      queryClient.invalidateQueries({ queryKey: ["/api/contacts/with-counts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/contacts/paginated"] });
      queryClient.invalidateQueries({ queryKey: ["/api/contacts/status-counts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
      setMergeMode(false);
      setSelectedForMerge([]);
      setMergeDialogOpen(false);
      setMergePrimaryId(null);
    },
    onError: (err: Error) => {
      toast({ title: "Merge Failed", description: err.message, variant: "destructive" });
    },
  });

  const eraseMutation = useMutation({
    mutationFn: async ({ contactId, reason }: { contactId: string; reason: string }) =>
      (await apiRequest("POST", `/api/contacts/${contactId}/erase`, { reason })).json(),
    onSuccess: () => {
      toast({ title: "Contact Erased", description: "Personal data has been anonymized per your request." });
      queryClient.invalidateQueries({ queryKey: ["/api/contacts/with-counts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/contacts/paginated"] });
      setEraseDialogOpen(false);
      setEraseContact(null);
      setEraseReason("");
      setDetailContact(null);
    },
    onError: (err: Error) => {
      toast({ title: "Erasure Failed", description: err.message, variant: "destructive" });
    },
  });

  const handleDelete = useCallback((contact: ContactWithCounts) => {
    setDeleteConfirm({ isOpen: true, contactId: contact.id, contactName: contact.name });
  }, []);

  const handleCardClick = useCallback((contact: ContactWithCounts) => {
    if (!mergeMode) {
      setDetailContact(contact);
      return;
    }
    setSelectedForMerge((prev) => {
      const alreadySelected = prev.find((c) => c.id === contact.id);
      if (alreadySelected) {
        return prev.filter((c) => c.id !== contact.id);
      }
      if (prev.length >= 2) {
        return [prev[1], contact];
      }
      return [...prev, contact];
    });
  }, [mergeMode]);

  const handleEnterMergeMode = useCallback(() => {
    setMergeMode(true);
    setSelectedForMerge([]);
    setDetailContact(null);
  }, []);

  const handleExitMergeMode = useCallback(() => {
    setMergeMode(false);
    setSelectedForMerge([]);
  }, []);

  const handleOpenMergeDialog = useCallback(() => {
    if (selectedForMerge.length !== 2) return;
    const [a, b] = selectedForMerge;
    const aTotal = a.leadCount + a.estimateCount + a.jobCount;
    const bTotal = b.leadCount + b.estimateCount + b.jobCount;
    setMergePrimaryId(aTotal >= bTotal ? a.id : b.id);
    setMergeDialogOpen(true);
  }, [selectedForMerge]);

  const handleConfirmMerge = useCallback(() => {
    if (!mergePrimaryId || selectedForMerge.length !== 2) return;
    const secondaryId = selectedForMerge.find((c) => c.id !== mergePrimaryId)!.id;
    mergeMutation.mutate({ primaryId: mergePrimaryId, secondaryId });
  }, [mergePrimaryId, selectedForMerge, mergeMutation]);

  const isSelectedForMerge = useCallback((id: string) => {
    return selectedForMerge.some((c) => c.id === id);
  }, [selectedForMerge]);

  const handleExportData = useCallback(async (contactId: string) => {
    setExportContactId(contactId);
    setExportLoading(true);
    setExportDialogOpen(true);
    setExportJson("");
    try {
      const res = await apiRequest("GET", `/api/contacts/${contactId}/export`);
      if (!res.ok) throw new Error("Export failed");
      const data = await res.json();
      setExportJson(JSON.stringify(data, null, 2));
    } catch {
      toast({ title: "Export Failed", description: "Could not export contact data.", variant: "destructive" });
      setExportDialogOpen(false);
    } finally {
      setExportLoading(false);
    }
  }, [toast]);

  const handleCopyExport = useCallback(() => {
    navigator.clipboard.writeText(exportJson).then(() => {
      toast({ title: "Copied", description: "Export data copied to clipboard." });
    });
  }, [exportJson, toast]);

  const handleDownloadExport = useCallback(() => {
    const blob = new Blob([exportJson], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `contact-${exportContactId}-export.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast({ title: "Downloaded", description: "Export file downloaded." });
  }, [exportJson, exportContactId, toast]);

  const handleOpenEraseDialog = useCallback((contact: ContactWithCounts) => {
    setEraseContact(contact);
    setEraseReason("");
    setEraseDialogOpen(true);
  }, []);

  const handleEraseConfirm = useCallback(() => {
    if (eraseContact) {
      eraseMutation.mutate({ contactId: eraseContact.id, reason: eraseReason.trim() });
    }
  }, [eraseContact, eraseReason, eraseMutation]);

  const handleEraseDialogClose = useCallback((open: boolean) => {
    if (!open) {
      setEraseDialogOpen(false);
      setEraseContact(null);
      setEraseReason("");
    }
  }, []);

  return (
    <PageLayout>
      <PageHeader
        title="Contacts"
        description="All contacts across leads, estimates, and jobs"
      />

      <div className="flex items-center gap-2 mb-4 flex-wrap">
        {!retentionView && (
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search contacts..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
              data-testid="input-search-contacts"
            />
          </div>
        )}

        {mergeMode ? (
          <>
            <span className="text-sm text-muted-foreground shrink-0">
              Select 2 contacts to merge
            </span>
            {selectedForMerge.length === 2 && (
              <Button
                onClick={handleOpenMergeDialog}
                data-testid="button-merge-contacts"
              >
                <GitMerge className="h-4 w-4 mr-2" />
                Merge 2 Contacts
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={handleExitMergeMode}
              data-testid="button-cancel-merge-mode"
            >
              <X className="h-4 w-4 mr-1" />
              Cancel
            </Button>
          </>
        ) : (
          <>
            {isAdmin && (
              <Button
                variant={retentionView ? "default" : "outline"}
                size="sm"
                onClick={() => setRetentionView(!retentionView)}
                data-testid="button-toggle-retention-view"
              >
                <Clock className="h-4 w-4 mr-2" />
                {retentionView ? "All Contacts" : "Retention Review"}
              </Button>
            )}
            {!retentionView && (
              <Button
                variant="outline"
                onClick={handleEnterMergeMode}
                data-testid="button-enter-merge-mode"
              >
                <GitMerge className="h-4 w-4 mr-2" />
                Merge
              </Button>
            )}
            {!activeLoading && (
              <span className="text-sm text-muted-foreground shrink-0">
                {total} contact{total !== 1 ? "s" : ""}
                {retentionView && " flagged for review"}
              </span>
            )}
          </>
        )}
      </div>

      <ContactGrid
        contacts={contacts}
        isLoading={activeLoading}
        isError={isError}
        pageSize={PAGE_SIZE}
        mergeMode={mergeMode}
        retentionView={retentionView}
        isAdmin={isAdmin}
        searchQuery={searchQuery}
        isSelectedForMerge={isSelectedForMerge}
        onCardClick={handleCardClick}
        onPurge={handleOpenEraseDialog}
      />

      {!activeLoading && total > 0 && (
        <PaginationBar
          page={page}
          totalPages={totalPages}
          onPageChange={setPage}
          totalItems={total}
          pageSize={PAGE_SIZE}
          className="mt-6"
        />
      )}

      <ContactDetailSheet
        contact={detailContact}
        isAdmin={isAdmin}
        onClose={() => setDetailContact(null)}
        onDelete={handleDelete}
        onExportData={handleExportData}
        onEraseData={handleOpenEraseDialog}
      />

      <ContactPurgeDialog
        open={eraseDialogOpen}
        onOpenChange={handleEraseDialogClose}
        contact={eraseContact}
        reason={eraseReason}
        onReasonChange={setEraseReason}
        onConfirm={handleEraseConfirm}
        isPending={eraseMutation.isPending}
      />

      <ContactExportDialog
        open={exportDialogOpen}
        onOpenChange={setExportDialogOpen}
        exportJson={exportJson}
        exportContactId={exportContactId}
        exportLoading={exportLoading}
        onCopy={handleCopyExport}
        onDownload={handleDownloadExport}
      />

      <DeleteConfirmDialog
        isOpen={deleteConfirm.isOpen}
        onOpenChange={(open) => { if (!open) setDeleteConfirm({ isOpen: false }); }}
        onConfirm={() => deleteConfirm.contactId && deleteMutation.mutate(deleteConfirm.contactId)}
        title="Delete Contact"
        description={`Are you sure you want to permanently delete ${deleteConfirm.contactName}? This will also delete all associated leads, estimates, jobs, and messages.`}
      />

      <ContactMergeDialog
        open={mergeDialogOpen}
        onOpenChange={setMergeDialogOpen}
        selectedForMerge={selectedForMerge}
        mergePrimaryId={mergePrimaryId}
        onPrimaryChange={setMergePrimaryId}
        onConfirm={handleConfirmMerge}
        isPending={mergeMutation.isPending}
      />
    </PageLayout>
  );
}
