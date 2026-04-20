import { useMutation, type InfiniteData } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { invalidateContacts } from "@/hooks/useInvalidations";
import type { Contact, PaginatedContacts } from "@shared/schema";

/**
 * Shared contact mutation hook — provides pre-wired mutations for all common
 * contact operations. Every mutation shares the same cache-invalidation strategy
 * via `invalidateContacts` from useInvalidations:
 *   - /api/contacts/paginated  — updates the paginated lead list
 *   - /api/contacts/status-counts — updates the status bar counters
 *   - /api/contacts            — updates any full-list consumers
 *   - /api/contacts/follow-ups — keeps follow-up widgets in sync
 *
 * Usage:
 *   const { deleteContact, updateContactStatus, archiveLead, restoreLead, updateFollowUpDate, updateContact } = useContactMutations();
 *   deleteContact.mutate(contactId);
 *   updateContactStatus.mutate({ contactId, status: 'contacted' });
 *   archiveLead.mutate(leadId);
 *   restoreLead.mutate(leadId);
 *   updateFollowUpDate.mutate({ contactId, followUpDate: new Date() });
 *   updateContact.mutate({ contactId, updates: { name: 'New Name' } });
 *
 * Per-call callbacks: All mutations accept an optional second argument with
 * per-call onSuccess/onError callbacks (standard TanStack Query pattern):
 *   deleteContact.mutate(id, { onSuccess: () => closeDialog() });
 */
export function useContactMutations() {
  const { toast } = useToast();

  const deleteContact = useMutation({
    mutationFn: async (contactId: string) => {
      return apiRequest("DELETE", `/api/contacts/${contactId}`);
    },
    onSuccess: () => {
      toast({ title: "Lead Deleted", description: "Lead has been successfully deleted." });
      invalidateContacts();
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to Delete Lead",
        description: error.message || "Something went wrong.",
        variant: "destructive",
      });
    },
  });

  const updateContactStatus = useMutation({
    mutationFn: async (data: { contactId: string; status: string }) => {
      return apiRequest("PATCH", `/api/contacts/${data.contactId}/status`, { status: data.status });
    },
    onMutate: async (data) => {
      await queryClient.cancelQueries({ queryKey: ["/api/contacts/paginated"] });

      const previousQueries = queryClient.getQueriesData<PaginatedContacts>({
        queryKey: ["/api/contacts/paginated"],
      });

      const allQueries = queryClient.getQueriesData({ queryKey: ["/api/contacts/paginated"] });
      for (const [key, value] of allQueries) {
        if (!value) continue;
        const typed = value as PaginatedContacts | InfiniteData<PaginatedContacts>;
        if ("pages" in typed) {
          queryClient.setQueryData<InfiniteData<PaginatedContacts>>(key, {
            ...typed,
            pages: typed.pages.map((page) => ({
              ...page,
              data: page.data.map((c) =>
                c.id === data.contactId ? { ...c, status: data.status as typeof c.status } : c
              ),
            })),
          });
        } else if (typed.data) {
          queryClient.setQueryData<PaginatedContacts>(key, {
            ...typed,
            data: typed.data.map((c) =>
              c.id === data.contactId ? { ...c, status: data.status as typeof c.status } : c
            ),
          });
        }
      }

      return { previousQueries };
    },
    onError: (error: Error, _data, context) => {
      context?.previousQueries.forEach(([queryKey, queryData]) => {
        queryClient.setQueryData(queryKey, queryData);
      });
      toast({
        title: "Failed to Update Status",
        description: error.message || "Something went wrong.",
        variant: "destructive",
      });
    },
    onSuccess: (_result, data) => {
      toast({ title: "Status Updated", description: "Lead status has been successfully updated." });
      invalidateContacts(data.contactId);
    },
  });

  const archiveLead = useMutation({
    mutationFn: async (leadId: string) => {
      return apiRequest("PATCH", `/api/leads/${leadId}/archive`);
    },
    onSuccess: () => {
      toast({ title: "Lead Archived", description: "Lead has been archived and is hidden from the main view." });
      invalidateContacts();
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to Archive Lead",
        description: error.message || "Something went wrong.",
        variant: "destructive",
      });
    },
  });

  const restoreLead = useMutation({
    mutationFn: async (leadId: string) => {
      return apiRequest("PATCH", `/api/leads/${leadId}/restore`);
    },
    onSuccess: () => {
      toast({ title: "Lead Restored", description: "Lead has been restored and is visible again." });
      invalidateContacts();
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to Restore Lead",
        description: error.message || "Something went wrong.",
        variant: "destructive",
      });
    },
  });

  const updateFollowUpDate = useMutation({
    mutationFn: async (data: { contactId: string; followUpDate: Date | null }) => {
      return apiRequest("PATCH", `/api/contacts/${data.contactId}/follow-up`, {
        followUpDate: data.followUpDate ? data.followUpDate.toISOString() : null,
      });
    },
    onSuccess: () => {
      toast({ title: "Follow-Up Date Set", description: "Follow-up date has been successfully updated." });
      invalidateContacts();
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to Update Follow-Up Date",
        description: error.message || "Something went wrong.",
        variant: "destructive",
      });
    },
  });

  const ageLead = useMutation({
    mutationFn: async (leadId: string) => {
      return apiRequest("PATCH", `/api/leads/${leadId}/age`);
    },
    onSuccess: () => {
      toast({ title: "Lead Aged", description: "Lead has been moved to the aged view." });
      invalidateContacts();
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to Age Lead",
        description: error.message || "Something went wrong.",
        variant: "destructive",
      });
    },
  });

  const unageLead = useMutation({
    mutationFn: async (leadId: string) => {
      return apiRequest("PATCH", `/api/leads/${leadId}/unage`);
    },
    onSuccess: () => {
      toast({ title: "Lead Restored", description: "Lead has been restored from aged status." });
      invalidateContacts();
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to Restore Lead",
        description: error.message || "Something went wrong.",
        variant: "destructive",
      });
    },
  });

  const updateContact = useMutation({
    mutationFn: async (data: { contactId: string; updates: Partial<Contact> }) => {
      return apiRequest("PATCH", `/api/contacts/${data.contactId}`, data.updates);
    },
    onSuccess: (_result, data) => {
      toast({ title: "Lead Updated", description: "Lead has been updated successfully." });
      invalidateContacts(data.contactId);
    },
    onError: (error: Error) => {
      toast({
        title: "Error Updating Lead",
        description: error.message || "Something went wrong.",
        variant: "destructive",
      });
    },
  });

  return { deleteContact, updateContactStatus, archiveLead, restoreLead, ageLead, unageLead, updateFollowUpDate, updateContact };
}
