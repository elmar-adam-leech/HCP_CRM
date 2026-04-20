export type WorkflowApprovalStatus = "approved" | "pending_approval" | "rejected";

export type Workflow = {
  id: string;
  contractorId: string;
  name: string;
  description: string | null;
  isActive: boolean;
  triggerType: string;
  triggerConfig?: string;
  approvalStatus: WorkflowApprovalStatus;
  approvedBy: string | null;
  approvedAt: string | null;
  rejectionReason: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};
