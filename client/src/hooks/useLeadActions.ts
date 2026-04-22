import { useCallback } from "react";
import { apiRequest } from "@/lib/queryClient";
import { useContactMutations } from "@/hooks/useContactMutations";
import { useBulkActions } from "@/hooks/useBulkActions";
import { invalidateContacts } from "@/hooks/useInvalidations";
import { useToast } from "@/hooks/use-toast";
import type { Contact } from "@shared/schema";
import type { LeadActiveModal } from "@/types/leadTypes";
import type { CommunicationEntity } from "@/hooks/useCommunicationActions";

interface UseLeadActionsParams {
  leadById: Map<string, Contact>;
  activeModal: LeadActiveModal;
  setActiveModal: (modal: LeadActiveModal) => void;
  closeModal: () => void;
  handleSchedule: (lead: CommunicationEntity & {
    isScheduled?: boolean;
    status?: string;
    address?: string | null;
    street?: string | null;
    city?: string | null;
    state?: string | null;
    zip?: string | null;
    housecallProEstimateId?: string | null;
  }) => void;
  handleSendEmail: (entity: CommunicationEntity, entityType?: 'lead' | 'estimate' | 'customer') => void;
  leads: Contact[];
}

export function useLeadActions(params: UseLeadActionsParams) {
  const {
    leadById,
    activeModal,
    setActiveModal,
    closeModal,
    handleSchedule,
    handleSendEmail,
    leads,
  } = params;

  const { toast } = useToast();
  const { deleteContact, updateContactStatus, archiveLead, restoreLead, ageLead, unageLead, updateFollowUpDate } = useContactMutations();

  const handleScheduleById = useCallback((leadId: string) => {
    const lead = leadById.get(leadId);
    if (lead) handleSchedule(lead);
  }, [leadById, handleSchedule]);

  const handleSendEmailByEntity = useCallback((lead: Contact) => handleSendEmail(lead, "lead"), [handleSendEmail]);

  const handleEdit = useCallback((contactId: string) => {
    const contact = leadById.get(contactId);
    if (contact) setActiveModal({ type: "edit", contact });
  }, [leadById, setActiveModal]);

  const handleDelete = useCallback((contactId: string) => {
    const contact = leadById.get(contactId);
    if (!contact) return;
    setActiveModal({ type: "delete", contactId, contactName: contact.name });
  }, [leadById, setActiveModal]);

  const handleViewDetails = useCallback((contactId: string) => {
    const contact = leadById.get(contactId);
    if (contact) setActiveModal({ type: "details", contact });
  }, [leadById, setActiveModal]);

  const handleEditStatus = useCallback((contactId: string) => {
    const contact = leadById.get(contactId);
    if (contact) setActiveModal({ type: "editStatus", contact });
  }, [leadById, setActiveModal]);

  const handleSetFollowUp = useCallback((contact: Contact) => setActiveModal({ type: "followUp", contact }), [setActiveModal]);

  const handleFollowUpSubmit = useCallback((date: Date | undefined) => {
    if (activeModal?.type !== "followUp") return;
    updateFollowUpDate.mutate(
      { contactId: activeModal.contact.id, followUpDate: date || null },
      { onSuccess: () => closeModal() }
    );
  }, [activeModal, updateFollowUpDate, closeModal]);

  const handleStatusChange = useCallback((contactId: string, newStatus: string) => {
    updateContactStatus.mutate({ contactId, status: newStatus });
  }, [updateContactStatus]);

  const { handleBulkDelete, handleBulkStatusChange, handleBulkExport } = useBulkActions({
    entityType: "contact",
    deleteEndpoint: (id) => `/api/contacts/${id}`,
    statusEndpoint: (id) => `/api/contacts/${id}/status`,
    onInvalidate: invalidateContacts,
    exportFilename: `leads-export-${new Date().toISOString().split("T")[0]}.csv`,
    exportHeaders: ["Name", "Email", "Phone", "Address", "Source", "Status"],
    getExportRow: (entity) => {
      const contact = entity as Contact;
      return [
        contact.name,
        contact.emails && contact.emails.length > 0 ? contact.emails[0] : "",
        contact.phones && contact.phones.length > 0 ? contact.phones[0] : "",
        contact.address ?? undefined,
        contact.source ?? undefined,
        contact.status ?? undefined,
      ];
    },
    entities: leads,
  });

  const handleBulkAge = useCallback(async (ids: string[]) => {
    await apiRequest("PATCH", "/api/leads/bulk/age", { ids });
    invalidateContacts();
  }, []);

  const handleBulkUnage = useCallback(async (ids: string[]) => {
    await apiRequest("PATCH", "/api/leads/bulk/unage", { ids });
    invalidateContacts();
  }, []);

  const handleBulkArchive = useCallback(async (ids: string[]) => {
    const res = await apiRequest("PATCH", "/api/leads/bulk/archive", { ids });
    const result = await res.json();
    invalidateContacts();
    if (result.failed > 0 && result.succeeded > 0) {
      toast({ title: `Archived ${result.succeeded} of ${ids.length} item(s)`, description: `${result.failed} item(s) could not be archived.`, variant: "destructive" });
    } else if (result.failed > 0) {
      toast({ title: "Archive failed", description: `None of the ${ids.length} item(s) could be archived.`, variant: "destructive" });
    }
  }, [toast]);

  const handleBulkRestore = useCallback(async (ids: string[]) => {
    const res = await apiRequest("PATCH", "/api/leads/bulk/restore", { ids });
    const result = await res.json();
    invalidateContacts();
    if (result.failed > 0 && result.succeeded > 0) {
      toast({ title: `Restored ${result.succeeded} of ${ids.length} item(s)`, description: `${result.failed} item(s) could not be restored.`, variant: "destructive" });
    } else if (result.failed > 0) {
      toast({ title: "Restore failed", description: `None of the ${ids.length} item(s) could be restored.`, variant: "destructive" });
    }
  }, [toast]);

  return {
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
  };
}
