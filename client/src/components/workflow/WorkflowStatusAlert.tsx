import { Link } from "wouter";
import { AlertCircle, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import type { Workflow } from "@/types/workflow";

type WorkflowStatusAlertProps = {
  workflow: Workflow;
};

export function WorkflowStatusAlert({ workflow }: WorkflowStatusAlertProps) {
  if (workflow.approvalStatus === 'approved') return null;

  return (
    <Alert variant={workflow.approvalStatus === 'rejected' ? 'destructive' : 'default'} data-testid="alert-approval-status">
      <AlertCircle className="h-4 w-4" />
      <AlertDescription className="flex items-center justify-between gap-4">
        <div>
          {workflow.approvalStatus === 'pending_approval' && (
            <span>
              This workflow is pending admin approval. You cannot activate it until it's approved.
            </span>
          )}
          {workflow.approvalStatus === 'rejected' && (
            <div className="space-y-1">
              <div>This workflow has been rejected and cannot be activated.</div>
              {workflow.rejectionReason && (
                <div className="text-sm">
                  <strong>Reason:</strong> {workflow.rejectionReason}
                </div>
              )}
            </div>
          )}
        </div>
        <Link href="/workflows/manage">
          <Button variant={workflow.approvalStatus === 'rejected' ? 'outline' : 'secondary'} size="sm" data-testid="button-view-approvals">
            View Approvals
            <ExternalLink className="h-3 w-3 ml-2" />
          </Button>
        </Link>
      </AlertDescription>
    </Alert>
  );
}
