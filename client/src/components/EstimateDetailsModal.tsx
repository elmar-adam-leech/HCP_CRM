import { DetailsModal } from "@/components/DetailsModal";
import { Badge } from "@/components/ui/badge";
import { ActivityList } from "@/components/ActivityList";
import { CommunicationActionButtons } from "@/components/CommunicationActionButtons";
import { LineItemsTable } from "@/components/LineItemsTable";
import { Phone, Mail, Calendar, User, CheckCircle, XCircle, Clock, UserCircle } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { WorkflowEnrollmentBadges } from "./WorkflowEnrollmentBadges";
import { formatCurrency, formatEntityTitle } from "@/lib/utils";
import { useUsers } from "@/hooks/useUsers";
import type { Contact, Estimate, EstimateSummary, HcpOptionEntry } from "@shared/schema";
import { isHcpApprovedOptionStatus, isHcpDeclinedOptionStatus, isHcpExpiredOptionStatus } from "@shared/hcp-option-status";

export type EstimateListItem = {
  id: string;
  title: string;
  contactId: string;
  contactName: string;
  contactEmails?: string[] | null;
  contactPhones?: string[] | null;
  contactTags?: string[] | null;
  contactHasJobs?: boolean;
  status: EstimateSummary["status"] | "cancelled";
  value: number;
  createdDate: string;
  expiryDate: string;
  description: string;
  externalSource?: string;
  externalId?: string;
  housecallProEstimateId?: string;
  hcpOptions?: HcpOptionEntry[] | null;
};

type EstimateDetailsModalProps = {
  isOpen: boolean;
  onClose: () => void;
  estimate: EstimateListItem | undefined;
  detailsContact: Contact | undefined;
  onSendEmail: () => void;
  hasUnreadText?: boolean;
  hasUnreadEmail?: boolean;
};

export function EstimateDetailsModal({
  isOpen,
  onClose,
  estimate,
  detailsContact,
  onSendEmail,
  hasUnreadText,
  hasUnreadEmail,
}: EstimateDetailsModalProps) {
  const { data: estimateDetail } = useQuery<Estimate>({
    queryKey: ["/api/estimates", estimate?.id],
    enabled: isOpen && !!estimate?.id,
  });
  const { data: users } = useUsers();
  const salesperson = estimateDetail?.salespersonUserId
    ? users?.find((u) => u.id === estimateDetail.salespersonUserId)
    : null;

  return (
    <DetailsModal
      isOpen={isOpen}
      onClose={onClose}
      title={estimate?.title ? formatEntityTitle('estimate', estimate.title) : "Estimate Details"}
      description="Estimate details and activity history"
      desktopMaxWidth="max-w-3xl"
    >
      {estimate && (
        <div className="grid gap-6 md:grid-cols-2">
          <div className="space-y-4">
            <div className="grid gap-3">
              <div className="flex items-center gap-2">
                <User className="h-4 w-4 text-muted-foreground" />
                <span className="font-medium">Customer:</span>
                <span>{detailsContact?.name || estimate.contactName || "Not provided"}</span>
              </div>

              <div className="flex items-center gap-2">
                <Mail className="h-4 w-4 text-muted-foreground" />
                <span className="font-medium">Email:</span>
                <span>
                  {detailsContact?.emails && detailsContact.emails.length > 0
                    ? detailsContact.emails.join(", ")
                    : "Not provided"}
                </span>
              </div>

              <div className="flex items-center gap-2">
                <Phone className="h-4 w-4 text-muted-foreground" />
                <span className="font-medium">Phone:</span>
                <span>
                  {detailsContact?.phones && detailsContact.phones.length > 0
                    ? detailsContact.phones.join(", ")
                    : "Not provided"}
                </span>
              </div>

              <div className="flex items-center gap-2" data-testid="row-estimate-salesperson">
                <UserCircle className="h-4 w-4 text-muted-foreground" />
                <span className="font-medium">Salesperson:</span>
                <span>{salesperson?.name || "Unassigned"}</span>
              </div>

              <div className="flex items-center gap-2">
                <Calendar className="h-4 w-4 text-muted-foreground" />
                <span className="font-medium">Created:</span>
                <span>{estimate.createdDate}</span>
              </div>

              <div className="flex items-center gap-2">
                <Calendar className="h-4 w-4 text-muted-foreground" />
                <span className="font-medium">Expires:</span>
                <span>{estimate.expiryDate}</span>
              </div>

              <div className="pt-4">
                <span className="font-medium">Description:</span>
                <p className="mt-1 text-sm text-muted-foreground">
                  {estimate.description || "No description provided"}
                </p>
              </div>

              {estimate.hcpOptions && estimate.hcpOptions.length > 0 && (
                <div className="pt-4">
                  <span className="font-medium">Estimate Options</span>
                  <div className="mt-2 space-y-2">
                    {estimate.hcpOptions.map((opt) => {
                      const approved = isHcpApprovedOptionStatus(opt.approval_status);
                      const declined = isHcpDeclinedOptionStatus(opt.approval_status);
                      const expired = isHcpExpiredOptionStatus(opt.approval_status);
                      const borderTint = approved
                        ? 'border-green-500/40 bg-green-500/5'
                        : declined
                          ? 'border-destructive/40 bg-destructive/5'
                          : expired
                            ? 'border-amber-500/40 bg-amber-500/5'
                            : '';
                      return (
                        <div
                          key={opt.id}
                          data-testid={`option-row-${opt.id}`}
                          className={`flex items-center justify-between gap-2 p-2 rounded-md border ${borderTint}`}
                        >
                          <div className="flex items-center gap-2 min-w-0 flex-wrap">
                            {approved && <CheckCircle className="h-4 w-4 text-green-600 dark:text-green-400 shrink-0" />}
                            {declined && <XCircle className="h-4 w-4 text-destructive shrink-0" />}
                            {expired && <Clock className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0" />}
                            <span className="text-sm">{opt.name || `Option ${opt.option_number || opt.id}`}</span>
                            {approved && <Badge variant="secondary" className="text-xs">Approved</Badge>}
                            {declined && <Badge variant="destructive" className="text-xs">Declined</Badge>}
                            {expired && <Badge variant="secondary" className="text-xs">Expired</Badge>}
                          </div>
                          <span className="text-sm font-medium tabular-nums">
                            {opt.total_amount != null ? formatCurrency(opt.total_amount / 100) : '—'}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="pt-4">
                <span className="font-medium">Line Items</span>
                <div className="mt-2">
                  <LineItemsTable items={estimateDetail?.lineItems} />
                </div>
              </div>

              <div className="pt-4">
                <span className="font-medium">Active Workflows</span>
                <div className="mt-2">
                  <WorkflowEnrollmentBadges contactId={estimate.contactId} variant="full" />
                </div>
              </div>

              <div className="pt-4">
                <CommunicationActionButtons
                  recipientName={detailsContact?.name || estimate.contactName || ''}
                  recipientEmail={detailsContact?.emails?.[0] || estimate.contactEmails?.[0] || ''}
                  recipientPhone={detailsContact?.phones?.[0] || estimate.contactPhones?.[0] || ''}
                  onSendEmail={onSendEmail}
                  estimateId={estimate.id}
                  customerId={estimate.contactId}
                  contactId={estimate.contactId}
                  hasUnreadText={hasUnreadText}
                  hasUnreadEmail={hasUnreadEmail}
                  showQuickNote={false}
                  forceInAppEmail
                />
              </div>
            </div>
          </div>

          <ActivityList estimateId={estimate.id} className="md:col-span-1" />
        </div>
      )}
    </DetailsModal>
  );
}
