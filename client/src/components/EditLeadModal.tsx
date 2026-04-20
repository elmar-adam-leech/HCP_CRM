import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { invalidateContacts } from "@/hooks/useInvalidations";
import type { Contact } from "@shared/schema";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { LeadForm, contactFormSchema, CONTACT_FORM_DEFAULTS, type ContactFormValues } from "@/components/LeadForm";

interface EditLeadModalProps {
  isOpen: boolean;
  contact: Contact | undefined;
  onClose: () => void;
  onSuccess: () => void;
}

export function EditLeadModal({ isOpen, contact, onClose, onSuccess }: EditLeadModalProps) {
  const { toast } = useToast();

  const form = useForm<ContactFormValues>({
    resolver: zodResolver(contactFormSchema),
    defaultValues: CONTACT_FORM_DEFAULTS,
  });

  useEffect(() => {
    if (contact && isOpen) {
      form.reset({
        name: contact.name || "",
        email: contact.emails && contact.emails.length > 0 ? contact.emails[0] : "",
        phone: contact.phones && contact.phones.length > 0 ? contact.phones[0] : "",
        address: contact.address || "",
        street: contact.street || contact.address || "",
        city: contact.city || "",
        state: contact.state || "",
        zip: contact.zip || "",
        source: contact.source || "",
        notes: contact.notes || "",
        followUpDate: contact.followUpDate ? new Date(contact.followUpDate) : undefined,
        pageUrl: contact.pageUrl || "",
        utmSource: contact.utmSource || "",
        utmMedium: contact.utmMedium || "",
        utmCampaign: contact.utmCampaign || "",
        utmTerm: contact.utmTerm || "",
        utmContent: contact.utmContent || "",
        tags: contact.tags || [],
      });
    }
  }, [contact, isOpen, form]);

  const updateContactMutation = useMutation({
    mutationFn: async (contactData: ContactFormValues) => {
      if (!contact) throw new Error("No contact to update");
      const { email, phone, ...rest } = contactData;
      const payload = {
        ...rest,
        emails: email ? [email] : [],
        phones: phone ? [phone] : [],
      };
      const response = await apiRequest("PUT", `/api/contacts/${contact.id}`, payload);
      return response;
    },
    onSuccess: () => {
      toast({ title: "Lead Updated", description: "Lead information has been successfully updated." });
      invalidateContacts();
      onSuccess();
      onClose();
    },
    onError: (error: Error) => {
      toast({ title: "Failed to Update Lead", description: error.message || "Something went wrong.", variant: "destructive" });
    },
  });

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto w-[calc(100vw-2rem)]">
        <DialogHeader>
          <DialogTitle>Edit Lead - {contact?.name}</DialogTitle>
          <DialogDescription>
            Update the lead's contact information and details.
          </DialogDescription>
        </DialogHeader>

        <LeadForm
          form={form}
          onSubmit={(values) => updateContactMutation.mutate(values)}
          onCancel={onClose}
          isPending={updateContactMutation.isPending}
          submitLabel="Save Changes"
        />
      </DialogContent>
    </Dialog>
  );
}
