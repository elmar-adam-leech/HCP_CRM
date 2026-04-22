import { EmailComposerModal } from "@/components/EmailComposerModal";
import { LocalSchedulingModal } from "@/components/LocalSchedulingModal";
import { FollowUpDateModal } from "@/components/FollowUpDateModal";
import { CreateLeadModal } from "@/components/CreateLeadModal";
import { EditLeadModal } from "@/components/EditLeadModal";
import { LeadDetailsModal } from "@/components/LeadDetailsModal";
import { DeleteConfirmDialog } from "@/components/DeleteConfirmDialog";
import { EditStatusModal } from "@/components/EditStatusModal";
import { invalidateContacts } from "@/hooks/useInvalidations";
import type { Contact } from "@shared/schema";
import type { LeadActiveModal } from "@/types/leadTypes";
import type { EmailModalState, SchedulingModalState } from "@/hooks/useCommunicationActions";

const LEAD_STATUSES = ["new", "contacted", "scheduled", "disqualified", "lost"] as const;

interface LeadModalsProps {
  activeModal: LeadActiveModal;
  closeModal: () => void;
  emailModal: EmailModalState;
  closeEmailModal: () => void;
  schedulingModal: SchedulingModalState;
  closeSchedulingModal: () => void;
  addContactModal: boolean;
  setAddContactModal: (open: boolean) => void;
  leads: Contact[];
  handleViewDetails: (contactId: string) => void;
  handleFollowUpSubmit: (date: Date | undefined) => void;
  deleteContact: { mutate: (id: string, opts?: { onSuccess?: () => void }) => void };
  updateContactStatus: { mutate: (params: { contactId: string; status: string }, opts?: { onSuccess?: () => void }) => void; isPending: boolean };
  updateFollowUpDate: { isPending: boolean };
  onScheduleFromDetails?: (contact: Contact) => void;
  onSendEmailFromDetails?: (lead: Contact) => void;
  onEditFromDetails?: (contact: Contact) => void;
  onEditStatusFromDetails?: (contact: Contact) => void;
  onSetFollowUpFromDetails?: (contact: Contact) => void;
  onEmailSent?: (contactId: string) => void;
  onTextSent?: (contactId: string) => void;
  onCallCompleted?: (contactId: string) => void;
}

export function LeadModals({
  activeModal,
  closeModal,
  emailModal,
  closeEmailModal,
  schedulingModal,
  closeSchedulingModal,
  addContactModal,
  setAddContactModal,
  leads,
  handleViewDetails,
  handleFollowUpSubmit,
  deleteContact,
  updateContactStatus,
  updateFollowUpDate,
  onScheduleFromDetails,
  onSendEmailFromDetails,
  onEditFromDetails,
  onEditStatusFromDetails,
  onSetFollowUpFromDetails,
  onEmailSent,
  onTextSent,
  onCallCompleted,
}: LeadModalsProps) {
  const detailsContact = activeModal?.type === "details" ? activeModal.contact : undefined;

  return (
    <>
      <EmailComposerModal
        isOpen={emailModal.isOpen}
        onClose={closeEmailModal}
        recipientName={emailModal.lead?.name || ""}
        recipientEmail={emailModal.lead?.emails?.[0] || ""}
        recipientPhone={emailModal.lead?.phones?.[0] || ""}
        recipientAddress={emailModal.lead?.address || ""}
        contactId={emailModal.lead?.id}
        leadId={emailModal.lead?.id}
        onSent={emailModal.lead?.id ? () => {
          const leadId = emailModal.lead!.id;
          onEmailSent?.(leadId);
          closeEmailModal();
        } : undefined}
      />

      <LocalSchedulingModal
        isOpen={schedulingModal.isOpen}
        onClose={closeSchedulingModal}
        lead={schedulingModal.lead ?? null}
        onScheduled={() => closeSchedulingModal()}
      />

      <CreateLeadModal
        isOpen={addContactModal}
        onClose={() => setAddContactModal(false)}
        onSuccess={() => {}}
        leads={leads}
        onViewDuplicate={handleViewDetails}
      />

      <EditLeadModal
        isOpen={activeModal?.type === "edit"}
        contact={activeModal?.type === "edit" ? activeModal.contact : undefined}
        onClose={closeModal}
        onSuccess={() => {}}
      />

      <LeadDetailsModal
        isOpen={activeModal?.type === "details"}
        contact={detailsContact}
        onClose={closeModal}
        onSendEmail={detailsContact ? () => onSendEmailFromDetails?.(detailsContact) : undefined}
        onSchedule={detailsContact ? () => onScheduleFromDetails?.(detailsContact) : undefined}
        onEdit={detailsContact ? () => onEditFromDetails?.(detailsContact) : undefined}
        onEditStatus={detailsContact ? () => onEditStatusFromDetails?.(detailsContact) : undefined}
        onSetFollowUp={detailsContact ? () => onSetFollowUpFromDetails?.(detailsContact) : undefined}
        onTextSent={detailsContact ? () => onTextSent?.(detailsContact.id) : undefined}
        onCallCompleted={detailsContact ? () => onCallCompleted?.(detailsContact.id) : undefined}
      />

      <EditStatusModal
        isOpen={activeModal?.type === "editStatus"}
        onOpenChange={(open) => { if (!open) closeModal(); }}
        contactName={activeModal?.type === "editStatus" ? activeModal.contact.name : undefined}
        currentStatus={activeModal?.type === "editStatus" ? activeModal.contact.status ?? undefined : undefined}
        statuses={LEAD_STATUSES}
        onStatusChange={(status) => {
          if (activeModal?.type === "editStatus") {
            updateContactStatus.mutate(
              { contactId: activeModal.contact.id, status },
              { onSuccess: () => { invalidateContacts(activeModal.contact.id); closeModal(); } }
            );
          }
        }}
        isPending={updateContactStatus.isPending}
      />

      <FollowUpDateModal
        isOpen={activeModal?.type === "followUp"}
        onClose={closeModal}
        onSave={handleFollowUpSubmit}
        entityName={activeModal?.type === "followUp" ? activeModal.contact.name : undefined}
        defaultDate={activeModal?.type === "followUp" && activeModal.contact.followUpDate ? new Date(activeModal.contact.followUpDate) : undefined}
        isSaving={updateFollowUpDate.isPending}
      />

      <DeleteConfirmDialog
        isOpen={activeModal?.type === "delete"}
        onOpenChange={(open) => { if (!open) closeModal(); }}
        title="Delete Lead"
        description={`Are you sure you want to delete "${activeModal?.type === "delete" ? activeModal.contactName : ""}"? This action cannot be undone.`}
        onConfirm={() => {
          if (activeModal?.type === "delete") {
            deleteContact.mutate(activeModal.contactId, {
              onSuccess: () => closeModal(),
            });
          }
        }}
        confirmTestId="button-confirm-delete-lead"
      />
    </>
  );
}
