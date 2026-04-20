import { DetailsModal } from "@/components/DetailsModal";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/StatusBadge";
import { LineItemsTable } from "@/components/LineItemsTable";
import { useQuery } from "@tanstack/react-query";
import { useUsers } from "@/hooks/useUsers";
import { formatCurrency, formatEntityTitle } from "@/lib/utils";
import type { Job } from "@shared/schema";

export type JobListItem = {
  id: string;
  title: string;
  contactId: string;
  contactName: string;
  contactEmail: string | null;
  contactPhone: string | null;
  status: "scheduled" | "in_progress" | "completed" | "cancelled";
  value: number;
  scheduledDate: string;
  type: string;
  priority: "high" | "low" | "medium";
  estimatedHours: number | null;
  externalSource?: string;
  estimateId?: string;
};

type JobDetailsModalProps = {
  isOpen: boolean;
  job: JobListItem | undefined;
  onClose: () => void;
};

function formatPaymentMethod(method: string): string {
  const map: Record<string, string> = {
    cash: "Cash",
    check: "Check",
    card: "Card",
    ach: "ACH",
    financing: "Financing",
  };
  return map[method.toLowerCase()] ?? method;
}

export function JobDetailsModal({ isOpen, job, onClose }: JobDetailsModalProps) {
  const { data: jobDetail } = useQuery<Job>({
    queryKey: ["/api/jobs", job?.id],
    enabled: isOpen && !!job?.id,
  });
  const { data: users } = useUsers();
  const salesperson = jobDetail?.salespersonUserId
    ? users?.find((u) => u.id === jobDetail.salespersonUserId)
    : null;

  const paidAmountNum = jobDetail?.paidAmount != null ? parseFloat(jobDetail.paidAmount) : null;
  const hasPayment = paidAmountNum != null && !Number.isNaN(paidAmountNum);

  return (
    <DetailsModal
      isOpen={isOpen}
      onClose={onClose}
      title={job ? `${formatEntityTitle('job', job.title)} - Job Details` : "Job Details"}
      description="View detailed information about this job."
    >
      {job && (
        <div className="space-y-6">
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <strong>Customer:</strong> {job.contactName || "Unknown Contact"}
            </div>
            <div>
              <strong>Type:</strong> {job.type}
            </div>
            <div>
              <strong>Status:</strong> <StatusBadge status={job.status} entityType="job" />
            </div>
            <div>
              <strong>Priority:</strong>{" "}
              <Badge
                variant={
                  job.priority === "high" ? "destructive" : job.priority === "medium" ? "default" : "secondary"
                }
              >
                {job.priority}
              </Badge>
            </div>
            <div>
              <strong>Value:</strong> {formatCurrency(job.value)}
            </div>
            <div>
              <strong>Scheduled Date:</strong> {job.scheduledDate}
            </div>
            <div data-testid="row-job-salesperson">
              <strong>Salesperson:</strong> {salesperson?.name || "Unassigned"}
            </div>
            {job.estimatedHours != null && (
              <div>
                <strong>Estimated Hours:</strong> {job.estimatedHours}h
              </div>
            )}
            {job.externalSource && (
              <div>
                <strong>Source:</strong>{" "}
                <Badge variant="secondary" className="ml-2">
                  {job.externalSource === "housecall-pro" ? "Housecall Pro" : job.externalSource}
                </Badge>
              </div>
            )}
          </div>

          <div>
            <h3 className="font-medium mb-2">Payment Summary</h3>
            {hasPayment ? (
              <div
                className="rounded-md border p-3 space-y-2 text-sm"
                data-testid="block-payment-summary"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">Paid Amount</span>
                  <span className="font-medium tabular-nums">{formatCurrency(paidAmountNum!)}</span>
                </div>
                {jobDetail?.paymentMethod && (
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-muted-foreground">Method</span>
                    <span>{formatPaymentMethod(jobDetail.paymentMethod)}</span>
                  </div>
                )}
                {jobDetail?.paidAt && (
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-muted-foreground">Paid At</span>
                    <span>{new Date(jobDetail.paidAt).toLocaleString()}</span>
                  </div>
                )}
                {jobDetail?.isDeposit && (
                  <div>
                    <Badge variant="secondary" data-testid="badge-deposit">Deposit</Badge>
                  </div>
                )}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground" data-testid="text-payment-empty">
                No payments recorded yet.
              </p>
            )}
          </div>

          <div>
            <h3 className="font-medium mb-2">Line Items</h3>
            <LineItemsTable items={jobDetail?.lineItems} />
          </div>

          {job.externalSource === "housecall-pro" && (
            <div className="text-sm text-muted-foreground bg-muted border rounded-md p-3">
              <strong>Tracking Only:</strong> This job was automatically synced from Housecall Pro for lead value
              tracking. Status updates and job management should be done in Housecall Pro.
            </div>
          )}

          {job.estimateId && (
            <div className="text-sm text-muted-foreground bg-muted border rounded-md p-3">
              <strong>Generated from Estimate:</strong> This job was created from an approved estimate. You can
              track the original estimate ID: {job.estimateId}
            </div>
          )}
        </div>
      )}
    </DetailsModal>
  );
}
