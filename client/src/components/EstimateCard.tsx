import { memo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { StatusBadge } from "./StatusBadge";
import { CustomerBadge } from "./CustomerBadge";
import { Calendar, FileText, MoreHorizontal, Edit, ExternalLink, Phone, Mail, CalendarClock, Trash2, Tag, ListChecks } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { CommunicationActionButtons } from "./CommunicationActionButtons";
import { ViewDetailsButton } from "./ViewDetailsButton";
import { TagsDialog } from "./TagsDialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import { getInitials, formatCurrency, formatEntityTitle, hcpUrl } from "@/lib/utils";
import { updateContactTags, getStatusBorderColor } from "@/lib/card-utils";
import { WorkflowEnrollmentBadges } from "./WorkflowEnrollmentBadges";
import { useEstimateMutations } from "@/hooks/useEstimateMutations";
import type { EstimateListItem } from "./EstimateDetailsModal";
import { isHcpApprovedOptionStatus, isHcpDeclinedOptionStatus, isHcpExpiredOptionStatus } from "@shared/hcp-option-status";

const HCP_STATUS_OPTIONS: Array<{ value: 'sent' | 'in_progress' | 'approved' | 'rejected'; label: string }> = [
  { value: 'sent', label: 'Sent' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
];

export type EstimateCardItem = EstimateListItem;

type EstimateCardProps = {
  estimate: EstimateCardItem;
  onViewDetails?: (estimateId: string) => void;
  onEdit?: (estimateId: string) => void;
  onSendEmail?: (estimate: EstimateCardItem) => void;
  onSetFollowUp?: (estimate: EstimateCardItem) => void;
  onDelete?: (estimateId: string) => void;
  selectable?: boolean;
  isSelected?: boolean;
  onToggleSelect?: () => void;
  hasUnreadText?: boolean;
  hasUnreadEmail?: boolean;
};

export const EstimateCard = memo(function EstimateCard({ estimate, onViewDetails, onEdit, onSendEmail, onSetFollowUp, onDelete, selectable = false, isSelected = false, onToggleSelect, hasUnreadText, hasUnreadEmail }: EstimateCardProps) {
  const { toast } = useToast();
  const [tagsDialogOpen, setTagsDialogOpen] = useState(false);
  const { updateEstimate } = useEstimateMutations();

  const isHousecallProEstimate = estimate.externalSource === 'housecall-pro';

  const handleHcpStatusChange = (newStatus: 'sent' | 'in_progress' | 'approved' | 'rejected') => {
    if (newStatus === estimate.status) return;
    updateEstimate.mutate({
      estimateId: estimate.id,
      data: { status: newStatus } as EditEstimateFormValues,
      isExternal: true,
    });
  };

  const handleUpdateContactTags = async (newTags: string[]) => {
    if (!estimate.contactId) return;
    try {
      await updateContactTags(estimate.contactId, newTags);
      toast({ title: "Tags updated", description: "Contact tags have been updated successfully." });
    } catch (error) {
      toast({
        title: "Error updating tags",
        description: error instanceof Error ? error.message : "Failed to update tags",
        variant: "destructive",
      });
    }
  };

  return (
    <div className="min-w-0 w-full">
      <Card 
        className={`hover-elevate ${getStatusBorderColor('estimate', estimate.status)}`}
        data-testid={`card-estimate-${estimate.id}`}
      >
      <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0 pb-2">
        {selectable && (
          <Checkbox
            checked={isSelected}
            onCheckedChange={() => onToggleSelect?.()}
            data-testid={`checkbox-estimate-${estimate.id}`}
            className="shrink-0 mt-1"
          />
        )}
        <div className="space-y-1 flex-1 min-w-0">
          <CardTitle className="text-base font-medium line-clamp-2">{formatEntityTitle('estimate', estimate.title)}</CardTitle>
          <div className="flex items-center gap-2 flex-wrap">
            <StatusBadge status={estimate.status} entityType="estimate" />
            <CustomerBadge hasJobs={estimate.contactHasJobs} />
            {isHousecallProEstimate && (() => {
              const opts = Array.isArray(estimate.hcpOptions) ? estimate.hcpOptions : [];
              const approvedOpt = opts.find(o => isHcpApprovedOptionStatus(o.approval_status));
              const firstOpt = opts[0];
              const optionId = approvedOpt?.id || firstOpt?.id;
              const hcpEstimateUrl = optionId
                ? hcpUrl('estimate', optionId)
                : undefined;
              return hcpEstimateUrl ? (
                <a
                  href={hcpEstimateUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                >
                  <Badge variant="secondary" className="text-xs flex items-center gap-1">
                    <ExternalLink className="h-3 w-3" />
                    Housecall Pro
                  </Badge>
                </a>
              ) : null;
            })()}
            {isHousecallProEstimate && Array.isArray(estimate.hcpOptions) && estimate.hcpOptions.length > 0 && (() => {
              const opts = estimate.hcpOptions;
              const approved = opts.filter(o => isHcpApprovedOptionStatus(o.approval_status)).length;
              const declined = opts.filter(o => isHcpDeclinedOptionStatus(o.approval_status)).length;
              const expired = opts.filter(o => isHcpExpiredOptionStatus(o.approval_status)).length;
              return (
                <>
                  {opts.length > 1 && (
                    <Badge
                      variant="secondary"
                      className="text-xs flex items-center gap-1"
                      data-testid={`badge-option-count-${estimate.id}`}
                    >
                      <ListChecks className="h-3 w-3" />
                      {opts.length} options
                    </Badge>
                  )}
                  {approved > 0 && (
                    <Badge
                      variant="secondary"
                      className="text-xs"
                      data-testid={`badge-options-approved-${estimate.id}`}
                    >
                      {approved} approved
                    </Badge>
                  )}
                  {declined > 0 && (
                    <Badge
                      variant="destructive"
                      className="text-xs"
                      data-testid={`badge-options-declined-${estimate.id}`}
                    >
                      {declined} declined
                    </Badge>
                  )}
                  {expired > 0 && (
                    <Badge
                      variant="secondary"
                      className="text-xs text-amber-700 dark:text-amber-400"
                      data-testid={`badge-options-expired-${estimate.id}`}
                    >
                      {expired} expired
                    </Badge>
                  )}
                </>
              );
            })()}
          </div>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" data-testid={`button-estimate-menu-${estimate.id}`}>
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <ViewDetailsButton 
              onViewDetails={() => onViewDetails?.(estimate.id)} 
              testId={`menu-view-estimate-${estimate.id}`}
            />
            {!isHousecallProEstimate && (
              <DropdownMenuItem onClick={() => onEdit?.(estimate.id)} data-testid={`menu-edit-estimate-${estimate.id}`}>
                <Edit className="h-4 w-4 mr-2" />
                Edit Estimate
              </DropdownMenuItem>
            )}
            {isHousecallProEstimate && (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger data-testid={`menu-change-status-${estimate.id}`}>
                  <Edit className="h-4 w-4 mr-2" />
                  Change Status
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  {HCP_STATUS_OPTIONS.map((opt) => (
                    <DropdownMenuItem
                      key={opt.value}
                      onClick={() => handleHcpStatusChange(opt.value)}
                      disabled={opt.value === estimate.status || updateEstimate.isPending}
                      data-testid={`menu-status-${opt.value}-${estimate.id}`}
                    >
                      {opt.label}
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem disabled className="text-xs text-muted-foreground">
                    Other fields edited in Housecall Pro
                  </DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )}
            <DropdownMenuItem onClick={() => onSetFollowUp?.(estimate)} data-testid={`menu-set-followup-estimate-${estimate.id}`}>
              <CalendarClock className="h-4 w-4 mr-2" />
              Set Follow Up
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setTagsDialogOpen(true)} data-testid={`menu-add-tags-${estimate.id}`}>
              <Tag className="h-4 w-4 mr-2" />
              Add Tags
            </DropdownMenuItem>
            {!isHousecallProEstimate && (
              <DropdownMenuItem 
                onClick={() => onDelete?.(estimate.id)} 
                className="text-destructive focus:text-destructive"
                data-testid={`menu-delete-estimate-${estimate.id}`}
              >
                <Trash2 className="h-4 w-4 mr-2" />
                Delete Estimate
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </CardHeader>
      <CardContent className="space-y-3">
        <>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Avatar className="h-6 w-6">
                  <AvatarFallback className="text-xs">
                    {getInitials(estimate.contactName)}
                  </AvatarFallback>
                </Avatar>
                <span className="text-sm text-muted-foreground">{estimate.contactName || 'Unknown Contact'}</span>
              </div>
              <div className="flex items-center gap-1 text-sm font-medium">
                {formatCurrency(estimate.value)}
              </div>
            </div>
            
            <div className="space-y-2 text-sm text-muted-foreground">
              <div className="flex items-center gap-2 min-w-0">
                <Mail className="h-4 w-4 shrink-0" />
                <span className="truncate min-w-0">{estimate.contactEmails?.[0] || 'No email'}</span>
              </div>
              <div className="flex items-center gap-2 min-w-0">
                <Phone className="h-4 w-4 shrink-0" />
                <span className="truncate min-w-0">{estimate.contactPhones?.[0] || 'No phone'}</span>
              </div>
              <div className="flex items-center gap-2">
                <Calendar className="h-4 w-4" />
                <span>Created: {estimate.createdDate}</span>
              </div>
              <div className="flex items-center gap-2">
                <Calendar className="h-4 w-4" />
                <span>Expires: {estimate.expiryDate}</span>
              </div>
              {estimate.description && (
                <div className="flex items-start gap-2">
                  <FileText className="h-4 w-4 mt-0.5" />
                  <span className="line-clamp-2">{estimate.description}</span>
                </div>
              )}
            </div>
            
            <CommunicationActionButtons
              recipientName={estimate.contactName || ''}
              recipientEmail={estimate.contactEmails?.[0] || ''}
              recipientPhone={estimate.contactPhones?.[0] || ''}
              onSendEmail={() => onSendEmail?.(estimate)}
              estimateId={estimate.id}
              contactId={estimate.contactId}
              hasUnreadText={hasUnreadText}
              hasUnreadEmail={hasUnreadEmail}
            />
            
            {isHousecallProEstimate && (
              <div className="text-xs text-muted-foreground bg-blue-500/10 border border-blue-500/20 p-2 rounded-md">
                <span className="font-medium">Synced from Housecall Pro:</span> Status can be changed locally and your choice will be preserved on future syncs. Other fields are edited in Housecall Pro.
              </div>
            )}

            <div className="flex gap-2 pt-2 border-t">
              <Button
                variant="outline"
                size="sm"
                className="flex-1"
                onClick={() => onViewDetails?.(estimate.id)}
                data-testid={`button-view-estimate-${estimate.id}`}
              >
                View Details
              </Button>
            </div>

            <WorkflowEnrollmentBadges contactId={estimate.contactId} variant="compact" />

            {estimate.contactTags && estimate.contactTags.length > 0 && (
              <div className="pt-2 border-t">
                <div className="flex flex-wrap gap-2">
                  {estimate.contactTags.map((tag: string) => (
                    <Badge
                      key={tag}
                      variant="secondary"
                      className="text-xs"
                      data-testid={`badge-estimate-tag-${tag}`}
                    >
                      {tag}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
        </>
      </CardContent>
      
      <TagsDialog
        open={tagsDialogOpen}
        onOpenChange={setTagsDialogOpen}
        tags={estimate.contactTags || []}
        onSave={handleUpdateContactTags}
        entityName={estimate.contactName}
        entityType="estimate"
      />
    </Card>
    </div>
  );
});
