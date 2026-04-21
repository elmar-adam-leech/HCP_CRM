/**
 * Follow-ups page.
 *
 * Data strategy: Fetches from /api/follow-ups/unified which returns a merged,
 * server-sorted FollowUpItem[] combining leads (by followUpDate) and estimates
 * (by validUntil or scheduledStart). Filtering by status (overdue/today/thisweek)
 * is done client-side since it's a simple array filter over already-fetched data.
 */
import { useQuery, useMutation } from "@tanstack/react-query";
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
import { FollowUpCard, FollowUpItem, getFollowUpStatus } from "@/components/FollowUpCard";
import { FollowUpSpreadsheetView } from "@/components/FollowUpSpreadsheetView";
import { SalesProcessFollowUpView } from "@/components/SalesProcessFollowUpView";
import type { SalesProcess, SalesProcessStep } from "@shared/schema";
import { useState, useCallback } from "react";
import { useLocation } from "wouter";
import type { Contact, EstimateSummary } from "@shared/schema";
import { PageHeader } from "@/components/ui/page-header-v2";
import { PageLayout } from "@/components/ui/page-layout";
import { dialPhone } from "@/lib/dialPhone";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { usePagePreferences } from "@/hooks/use-page-preferences";

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

  const [filterView, setFilterView] = useState<string>("all");
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

  // Fetch the sales-process metadata to (a) decide whether to show the
  // Sales Process view toggle and (b) pass step rows down so the new view
  // can group tasks by step.
  const { data: salesProcessData } = useQuery<{ process: SalesProcess; steps: SalesProcessStep[] }>({
    queryKey: ["/api/sales-process"],
  });
  const salesProcess = salesProcessData?.process;
  const salesProcessSteps = salesProcessData?.steps ?? [];
  const hasActiveSalesProcess = !!salesProcess?.active && salesProcessSteps.length > 0;

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

  const { data: allFollowUps = [], isLoading } = useQuery<FollowUpItem[]>({
    queryKey: ["/api/follow-ups/unified"],
    queryFn: async () => {
      const res = await fetch("/api/follow-ups/unified");
      if (!res.ok) throw new Error("Failed to fetch follow-ups");
      return res.json();
    },
  });

  const followUpItems = allFollowUps.filter(item => {
    const status = getFollowUpStatus(item.followUpDate);
    switch (filterView) {
      case "overdue": return status.label === "Overdue";
      case "today": return status.label === "Today";
      case "thisweek": return status.label === "This Week";
      case "upcoming": return status.label === "Upcoming";
      case "all":
      default: return true;
    }
  });

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
                onClick={() => setViewMode("cards")}
                data-testid="view-cards"
              >
                <LayoutGrid className="h-4 w-4" />
              </Button>
              <Button
                variant={activeViewMode === "spreadsheet" ? "default" : "ghost"}
                size="sm"
                onClick={() => setViewMode("spreadsheet")}
                data-testid="view-spreadsheet"
              >
                <Table className="h-4 w-4" />
              </Button>
              {hasActiveSalesProcess && (
                <Button
                  variant={activeViewMode === "sales-process" ? "default" : "ghost"}
                  size="sm"
                  onClick={() => setViewMode("sales-process")}
                  data-testid="view-sales-process"
                  title="Sales Process"
                >
                  <ListChecks className="h-4 w-4" />
                </Button>
              )}
            </div>
            <Select value={filterView} onValueChange={setFilterView} data-testid="select-filter-view">
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
              {followUpItems.length} follow-ups
            </Badge>
          </div>
        }
      />

      {activeViewMode === "sales-process" ? (
        <SalesProcessFollowUpView
          process={salesProcess}
          steps={salesProcessSteps}
          onOpenLead={handleOpenLeadFromSalesProcess}
        />
      ) : activeViewMode === "spreadsheet" ? (
        <FollowUpSpreadsheetView
          items={followUpItems}
          isLoading={isLoading}
          onSetFollowUp={handleSetFollowUp}
          onContact={handleContact}
          onEdit={handleEdit}
          onOpenDetail={handleOpenDetail}
          onRemoveFollowUp={handleRemoveFollowUp}
        />
      ) : isLoading ? (
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
      )}

      {/* Email Composer Modal */}
      {emailModal.item && (
        <EmailComposerModal
          isOpen={emailModal.isOpen}
          onClose={() => setEmailModal({ isOpen: false })}
          recipientName={emailModal.item.name}
          recipientEmail={emailModal.item.email || ''}
          recipientPhone={emailModal.item.phone || ''}
          companyName={contractorName}
          contactId={emailModal.item.type === 'lead' ? emailModal.item.id : (emailModal.item.contactId ?? undefined)}
          estimateId={emailModal.item.type === 'estimate' ? emailModal.item.id : undefined}
        />
      )}

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
