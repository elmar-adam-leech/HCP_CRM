import { useState, useMemo, useEffect } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useWebSocketInvalidation } from "@/hooks/useWebSocketInvalidation";
import { useLocation } from "wouter";
import { Check, X, Eye, Edit, AlertCircle, Search, Trash2, ChevronLeft, ChevronRight } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { PageLayout } from "@/components/ui/page-layout";
import { useCurrentUser, isAdminUser } from "@/hooks/useCurrentUser";
import { DeleteConfirmDialog } from "@/components/DeleteConfirmDialog";
import { EmptyState } from "@/components/EmptyState";
import type { Workflow, WorkflowApprovalStatus } from "@/types/workflow";

export default function WorkflowsList() {
  const [, navigate] = useLocation();
  const { toast } = useToast();

  useWebSocketInvalidation([
    { types: ['workflow_updated', 'workflow_created', 'workflow_deleted'], queryKeys: ['/api/workflows'] },
  ]);
  const [statusFilter, setStatusFilter] = useState<"all" | "pending_approval">("all");
  const [rejectDialogOpen, setRejectDialogOpen] = useState(false);
  const [rejectingWorkflowId, setRejectingWorkflowId] = useState<string | null>(null);
  const [rejectionReason, setRejectionReason] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [workflowToDelete, setWorkflowToDelete] = useState<string | null>(null);
  const itemsPerPage = 15;

  const { data: currentUser } = useCurrentUser();
  const isAdmin = isAdminUser(currentUser?.user?.role);

  const { data: workflows = [], isLoading } = useQuery<Workflow[]>({
    queryKey: ['/api/workflows', { approvalStatus: statusFilter === 'all' ? undefined : statusFilter }],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (statusFilter !== 'all') {
        params.append('approvalStatus', statusFilter);
      }
      const url = `/api/workflows${params.toString() ? `?${params.toString()}` : ''}`;
      return (await apiRequest('GET', url)).json();
    },
  });

  const approveMutation = useMutation({
    mutationFn: async (workflowId: string) => {
      return await apiRequest('POST', `/api/workflows/${workflowId}/approve`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/workflows'], exact: false });
      toast({ title: "Workflow Approved", description: "The workflow has been approved and can now be activated." });
    },
    onError: (error: Error) => {
      toast({ title: "Approval Failed", description: error.message || "Failed to approve workflow", variant: "destructive" });
    },
  });

  const rejectMutation = useMutation({
    mutationFn: async ({ workflowId, reason }: { workflowId: string; reason: string }) => {
      return await apiRequest('POST', `/api/workflows/${workflowId}/reject`, { rejectionReason: reason });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/workflows'], exact: false });
      setRejectDialogOpen(false);
      setRejectionReason("");
      setRejectingWorkflowId(null);
      toast({ title: "Workflow Rejected", description: "The workflow has been rejected." });
    },
    onError: (error: Error) => {
      toast({ title: "Rejection Failed", description: error.message || "Failed to reject workflow", variant: "destructive" });
    },
  });

  const [togglingIds, setTogglingIds] = useState<Set<string>>(new Set());

  const toggleActiveMutation = useMutation({
    mutationFn: async ({ workflowId, isActive }: { workflowId: string; isActive: boolean }) => {
      setTogglingIds(prev => new Set(prev).add(workflowId));
      return (await apiRequest('PATCH', `/api/workflows/${workflowId}`, { isActive })).json();
    },
    onSuccess: (_data, { workflowId }) => {
      setTogglingIds(prev => { const s = new Set(prev); s.delete(workflowId); return s; });
      queryClient.invalidateQueries({ queryKey: ['/api/workflows'], exact: false });
    },
    onError: (_err, { workflowId }) => {
      setTogglingIds(prev => { const s = new Set(prev); s.delete(workflowId); return s; });
      toast({ title: "Error", description: "Failed to update workflow status", variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (workflowId: string) => {
      await apiRequest('DELETE', `/api/workflows/${workflowId}`);
    },
    onSuccess: () => {
      toast({ title: "Workflow deleted", description: "The workflow has been deleted successfully." });
      queryClient.invalidateQueries({ queryKey: ['/api/workflows'], exact: false });
      setWorkflowToDelete(null);
    },
    onError: (error: Error) => {
      toast({ title: "Error deleting workflow", description: error.message, variant: "destructive" });
      setWorkflowToDelete(null);
    },
  });

  const handleApprove = (workflowId: string) => approveMutation.mutate(workflowId);

  const handleRejectClick = (workflowId: string) => {
    setRejectingWorkflowId(workflowId);
    setRejectDialogOpen(true);
  };

  const handleRejectConfirm = () => {
    if (rejectingWorkflowId) {
      rejectMutation.mutate({ workflowId: rejectingWorkflowId, reason: rejectionReason });
    }
  };

  const filteredWorkflows = useMemo(() => {
    if (!workflows) return [];
    return workflows.filter(workflow =>
      workflow.name.toLowerCase().includes(searchQuery.toLowerCase())
    );
  }, [workflows, searchQuery]);

  const totalPages = Math.ceil(filteredWorkflows.length / itemsPerPage);
  const clampedPage = Math.max(1, Math.min(currentPage, totalPages || 1));
  const startIndex = (clampedPage - 1) * itemsPerPage;
  const endIndex = startIndex + itemsPerPage;
  const paginatedWorkflows = filteredWorkflows.slice(startIndex, endIndex);

  useEffect(() => {
    if (currentPage > totalPages && totalPages > 0) {
      setCurrentPage(totalPages);
    } else if (currentPage !== clampedPage) {
      setCurrentPage(clampedPage);
    }
  }, [totalPages, currentPage, clampedPage]);

  useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery, statusFilter]);

  const getStatusBadge = (status: WorkflowApprovalStatus) => {
    switch (status) {
      case "approved":
        return (
          <Badge variant="default" data-testid="badge-status-approved">
            <Check className="h-3 w-3 mr-1" />
            Approved
          </Badge>
        );
      case "pending_approval":
        return (
          <Badge variant="secondary" data-testid="badge-status-pending">
            <AlertCircle className="h-3 w-3 mr-1" />
            Pending Approval
          </Badge>
        );
      case "rejected":
        return (
          <Badge variant="destructive" data-testid="badge-status-rejected">
            <X className="h-3 w-3 mr-1" />
            Rejected
          </Badge>
        );
    }
  };

  const selectedWorkflowName = workflows.find(w => w.id === workflowToDelete)?.name ?? "";

  return (
    <PageLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div>
            <h1 className="text-3xl font-bold">Workflows</h1>
            <p className="text-muted-foreground">Manage and approve workflow automations</p>
          </div>
          <Button
            variant="default"
            data-testid="button-create-workflow"
            onClick={() => navigate('/workflows/new')}
          >
            Create Workflow
          </Button>
        </div>

        {/* Search Bar */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            type="text"
            placeholder="Search workflows by name..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-10"
            data-testid="input-search-workflows"
          />
        </div>

        {/* Filters */}
        <Tabs value={statusFilter} onValueChange={(v) => setStatusFilter(v as "all" | "pending_approval")}>
          <TabsList>
            <TabsTrigger value="all" data-testid="tab-all-workflows">
              All Workflows
            </TabsTrigger>
            {isAdmin && (
              <TabsTrigger value="pending_approval" data-testid="tab-pending-approval">
                Pending Approval
              </TabsTrigger>
            )}
          </TabsList>
        </Tabs>

        {/* Workflows List */}
        {isLoading ? (
          <div className="space-y-4">
            {[1, 2, 3].map((i) => (
              <Card key={i}>
                <CardContent className="p-6">
                  <div className="space-y-3">
                    <div className="h-6 bg-muted rounded w-1/3" />
                    <div className="h-4 bg-muted rounded w-2/3" />
                    <div className="h-4 bg-muted rounded w-1/4" />
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : filteredWorkflows.length === 0 ? (
          <EmptyState
            icon={AlertCircle}
            title={
              searchQuery
                ? "No workflows match your search"
                : statusFilter === "pending_approval"
                ? "No workflows pending approval"
                : "No workflows yet"
            }
            description={
              searchQuery
                ? "Try a different search term."
                : "Create your first workflow automation to get started."
            }
            ctaLabel={!searchQuery && statusFilter === "all" ? "Create Workflow" : undefined}
            onCtaClick={!searchQuery && statusFilter === "all" ? () => navigate('/workflows/new') : undefined}
            ctaTestId="button-empty-create-workflow"
          />
        ) : (
          <div className="space-y-4">
            {paginatedWorkflows.map((workflow: Workflow) => (
              <Card key={workflow.id} data-testid={`card-workflow-${workflow.id}`}>
                <CardHeader>
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 space-y-2">
                      <div className="flex items-center gap-3 flex-wrap">
                        <CardTitle data-testid={`text-workflow-name-${workflow.id}`}>
                          {workflow.name}
                        </CardTitle>
                        {getStatusBadge(workflow.approvalStatus)}
                      </div>
                      {workflow.description && (
                        <p className="text-sm text-muted-foreground" data-testid={`text-workflow-description-${workflow.id}`}>
                          {workflow.description}
                        </p>
                      )}
                      <div className="flex items-center gap-4 text-xs text-muted-foreground flex-wrap">
                        <span>Trigger: {workflow.triggerType}</span>
                        <span>Created: {new Date(workflow.createdAt).toLocaleDateString()}</span>
                        {workflow.approvedAt && (
                          <span>Approved: {new Date(workflow.approvedAt).toLocaleDateString()}</span>
                        )}
                      </div>
                      {workflow.rejectionReason && (
                        <div className="mt-2 p-3 bg-destructive/10 border border-destructive/20 rounded-md">
                          <p className="text-sm text-destructive" data-testid={`text-rejection-reason-${workflow.id}`}>
                            <strong>Rejection Reason:</strong> {workflow.rejectionReason}
                          </p>
                        </div>
                      )}
                    </div>

                    <div className="flex items-center gap-2 flex-wrap">
                      {workflow.approvalStatus === "approved" && (
                        <div className="flex items-center gap-2">
                          <Switch
                            checked={workflow.isActive}
                            disabled={togglingIds.has(workflow.id)}
                            onCheckedChange={(checked) =>
                              toggleActiveMutation.mutate({ workflowId: workflow.id, isActive: checked })
                            }
                            data-testid={`switch-active-${workflow.id}`}
                          />
                          <Label className="text-sm text-muted-foreground select-none">
                            {workflow.isActive ? "Active" : "Inactive"}
                          </Label>
                        </div>
                      )}

                      {isAdmin && workflow.approvalStatus === "pending_approval" && (
                        <>
                          <Button
                            variant="default"
                            size="sm"
                            data-testid={`button-approve-${workflow.id}`}
                            onClick={() => handleApprove(workflow.id)}
                            disabled={approveMutation.isPending}
                          >
                            <Check className="h-4 w-4 mr-1" />
                            Approve
                          </Button>
                          <Button
                            variant="destructive"
                            size="sm"
                            data-testid={`button-reject-${workflow.id}`}
                            onClick={() => handleRejectClick(workflow.id)}
                            disabled={rejectMutation.isPending}
                          >
                            <X className="h-4 w-4 mr-1" />
                            Reject
                          </Button>
                        </>
                      )}

                      <Button
                        variant="outline"
                        size="sm"
                        data-testid={`button-edit-${workflow.id}`}
                        onClick={() => navigate(`/workflows/${workflow.id}/edit`)}
                      >
                        <Edit className="h-4 w-4 mr-1" />
                        Edit
                      </Button>

                      <Button
                        variant="ghost"
                        size="sm"
                        data-testid={`button-view-executions-${workflow.id}`}
                        onClick={() => navigate(`/workflows/${workflow.id}/executions`)}
                      >
                        <Eye className="h-4 w-4 mr-1" />
                        Executions
                      </Button>

                      <Button
                        variant="ghost"
                        size="sm"
                        data-testid={`button-delete-${workflow.id}`}
                        onClick={() => setWorkflowToDelete(workflow.id)}
                        disabled={deleteMutation.isPending && workflowToDelete === workflow.id}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  </div>
                </CardHeader>
              </Card>
            ))}
          </div>
        )}

        {/* Pagination */}
        {!isLoading && filteredWorkflows.length > itemsPerPage && (
          <div className="flex items-center justify-between border-t pt-4 flex-wrap gap-4">
            <div className="text-sm text-muted-foreground">
              Showing {startIndex + 1}–{Math.min(endIndex, filteredWorkflows.length)} of {filteredWorkflows.length} workflows
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                disabled={currentPage === 1}
                data-testid="button-previous-page"
              >
                <ChevronLeft className="h-4 w-4" />
                Previous
              </Button>
              <div className="flex items-center gap-1">
                {Array.from({ length: totalPages }, (_, i) => i + 1).map(page => (
                  <Button
                    key={page}
                    variant={currentPage === page ? "default" : "outline"}
                    size="sm"
                    onClick={() => setCurrentPage(page)}
                    className="w-10"
                    data-testid={`button-page-${page}`}
                  >
                    {page}
                  </Button>
                ))}
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                disabled={currentPage === totalPages}
                data-testid="button-next-page"
              >
                Next
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Rejection Dialog */}
      <Dialog open={rejectDialogOpen} onOpenChange={setRejectDialogOpen}>
        <DialogContent data-testid="dialog-reject-workflow">
          <DialogHeader>
            <DialogTitle>Reject Workflow</DialogTitle>
            <DialogDescription>
              Please provide a reason for rejecting this workflow. This will help the creator understand why their workflow was not approved.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="rejection-reason">Rejection Reason</Label>
              <Textarea
                id="rejection-reason"
                data-testid="input-rejection-reason"
                placeholder="Enter reason for rejection..."
                value={rejectionReason}
                onChange={(e) => setRejectionReason(e.target.value)}
                rows={4}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              data-testid="button-cancel-reject"
              onClick={() => {
                setRejectDialogOpen(false);
                setRejectionReason("");
                setRejectingWorkflowId(null);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              data-testid="button-confirm-reject"
              onClick={handleRejectConfirm}
              disabled={!rejectionReason.trim() || rejectMutation.isPending}
            >
              {rejectMutation.isPending ? "Rejecting..." : "Reject Workflow"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirm Dialog */}
      <DeleteConfirmDialog
        isOpen={workflowToDelete !== null}
        onOpenChange={(open) => { if (!open) setWorkflowToDelete(null); }}
        title="Delete Workflow"
        description={`Are you sure you want to delete "${selectedWorkflowName}"? This action cannot be undone.`}
        onConfirm={() => { if (workflowToDelete) deleteMutation.mutate(workflowToDelete); }}
        confirmTestId="button-confirm-delete-workflow"
      />
    </PageLayout>
  );
}
