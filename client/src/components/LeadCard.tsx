import { memo, useState } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "./StatusBadge";
import { CustomerBadge } from "./CustomerBadge";
import { Phone, Mail, MapPin, Calendar, MoreHorizontal, Edit, Trash2, Settings, CalendarClock, Tag, Archive, ArchiveRestore, UserCheck, ExternalLink, Clock } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { CommunicationActionButtons } from "./CommunicationActionButtons";
import { ViewDetailsButton } from "./ViewDetailsButton";
import { InlineEdit } from "./InlineEdit";
import { TagsDialog } from "./TagsDialog";
import { WorkflowEnrollmentBadges } from "./WorkflowEnrollmentBadges";
import { getInitials, hcpUrl } from "@/lib/utils";
import { getStatusBorderColor } from "@/lib/card-utils";
import { useContactMutations } from "@/hooks/useContactMutations";
import type { Contact } from "@shared/schema";

// hasJobs is a virtual computed column added by the paginated contacts query,
// not part of the base Contact schema row.
type LeadCardContact = Contact & { hasJobs?: boolean };

type LeadCardProps = {
  lead: LeadCardContact;
  onSchedule?: (leadId: string) => void;
  onSendEmail?: (lead: LeadCardContact) => void;
  onEdit?: (leadId: string) => void;
  onDelete?: (leadId: string) => void;
  onArchive?: (leadId: string) => void;
  onRestore?: (leadId: string) => void;
  onAge?: (leadId: string) => void;
  onUnage?: (leadId: string) => void;
  onEditStatus?: (leadId: string) => void;
  onViewDetails?: (leadId: string) => void;
  onSetFollowUp?: (lead: LeadCardContact) => void;
  selectable?: boolean;
  isSelected?: boolean;
  onToggleSelect?: () => void;
  hasUnreadText?: boolean;
  hasUnreadEmail?: boolean;
  onTextSent?: () => void;
  onCallCompleted?: () => void;
};

export const LeadCard = memo(function LeadCard({ lead, onSchedule, onSendEmail, onEdit, onDelete, onArchive, onRestore, onAge, onUnage, onEditStatus, onViewDetails, onSetFollowUp, selectable = false, isSelected = false, onToggleSelect, hasUnreadText, hasUnreadEmail, onTextSent, onCallCompleted }: LeadCardProps) {
  const [tagsDialogOpen, setTagsDialogOpen] = useState(false);
  const { updateContact } = useContactMutations();

  const leadName = lead.name || '';
  const leadEmail = (lead.emails && lead.emails.length > 0) ? lead.emails[0] : '';
  const leadPhone = (lead.phones && lead.phones.length > 0) ? lead.phones[0] : '';
  const leadAddress = lead.address || '';
  const leadSource = lead.source || '';
  const leadScheduledDate = lead.scheduledAt ? new Date(lead.scheduledAt).toLocaleDateString() : undefined;
  const leadTags = lead.tags || [];

  return (
    <div className="min-w-0 w-full">
      <Card 
        className={`relative hover-elevate ${getStatusBorderColor('lead', lead.status || 'new')}`}
        data-testid={`card-lead-${lead.id}`}
      >
      <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0 pb-2">
        <div className="flex items-center space-x-3 flex-1 min-w-0">
          {selectable && (
            <Checkbox
              checked={isSelected}
              onCheckedChange={() => onToggleSelect?.()}
              data-testid={`checkbox-lead-${lead.id}`}
              className="shrink-0"
            />
          )}
          <Avatar className="h-10 w-10 shrink-0">
            <AvatarFallback>{getInitials(leadName)}</AvatarFallback>
          </Avatar>
          <div className="flex-1 min-w-0">
            <div className="text-base font-medium">
              <InlineEdit
                value={leadName}
                onSave={async (newValue) => {
                  updateContact.mutate({ contactId: lead.id, updates: { name: String(newValue) } });
                }}
                placeholder="Lead name"
                showEditIcon
                displayClassName="font-medium"
              />
            </div>
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              <StatusBadge status={lead.status as Parameters<typeof StatusBadge>[0]['status']} entityType="lead" />
              <CustomerBadge hasJobs={lead.hasJobs} />
              <span className="text-xs text-muted-foreground truncate">{leadSource}</span>
              {lead.housecallProCustomerId && (
                <a
                  href={hcpUrl('customer', lead.housecallProCustomerId)}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                >
                  <Badge variant="secondary" className="text-xs flex items-center gap-1">
                    <ExternalLink className="h-3 w-3" />
                    Housecall Pro
                  </Badge>
                </a>
              )}
            </div>
          </div>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="shrink-0" data-testid={`button-lead-menu-${lead.id}`}>
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <ViewDetailsButton 
              onViewDetails={() => onViewDetails?.(lead.id)} 
              testId={`menu-view-details-${lead.id}`}
            />
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => onSetFollowUp?.(lead)} data-testid={`menu-set-followup-${lead.id}`}>
              <CalendarClock className="h-4 w-4 mr-2" />
              Set Follow Up
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onEdit?.(lead.id)} data-testid={`menu-edit-lead-${lead.id}`}>
              <Edit className="h-4 w-4 mr-2" />
              Edit Lead
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onEditStatus?.(lead.id)} data-testid={`menu-edit-status-${lead.id}`}>
              <Settings className="h-4 w-4 mr-2" />
              Edit Status
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setTagsDialogOpen(true)} data-testid={`menu-add-tags-${lead.id}`}>
              <Tag className="h-4 w-4 mr-2" />
              Add Tags
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {onRestore && (
              <DropdownMenuItem onClick={() => onRestore(lead.id)} data-testid={`menu-restore-lead-${lead.id}`}>
                <ArchiveRestore className="h-4 w-4 mr-2" />
                Restore Lead
              </DropdownMenuItem>
            )}
            {onUnage && (
              <DropdownMenuItem onClick={() => onUnage(lead.id)} data-testid={`menu-unage-lead-${lead.id}`}>
                <ArchiveRestore className="h-4 w-4 mr-2" />
                Restore Lead
              </DropdownMenuItem>
            )}
            {onArchive && (
              <DropdownMenuItem onClick={() => onArchive(lead.id)} data-testid={`menu-archive-lead-${lead.id}`}>
                <Archive className="h-4 w-4 mr-2" />
                Archive Lead
              </DropdownMenuItem>
            )}
            {onAge && (
              <DropdownMenuItem onClick={() => onAge(lead.id)} data-testid={`menu-age-lead-${lead.id}`}>
                <Clock className="h-4 w-4 mr-2" />
                Mark as Aged
              </DropdownMenuItem>
            )}
            <DropdownMenuItem 
              onClick={() => onDelete?.(lead.id)} 
              className="text-destructive focus:text-destructive" 
              data-testid={`menu-delete-lead-${lead.id}`}
            >
              <Trash2 className="h-4 w-4 mr-2" />
              Delete Lead
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-2 text-sm text-muted-foreground">
          <div className="flex items-center gap-2 min-w-0">
            <Mail className="h-4 w-4 shrink-0" />
            <span className="truncate min-w-0">{leadEmail || 'No email'}</span>
          </div>
          <div className="flex items-center gap-2 min-w-0">
            <Phone className="h-4 w-4 shrink-0" />
            <span className="truncate min-w-0">{leadPhone || 'No phone'}</span>
          </div>
          <div className="flex items-center gap-2 min-w-0">
            <MapPin className="h-4 w-4 shrink-0" />
            <span className="truncate min-w-0">{leadAddress || 'No address'}</span>
          </div>
          {leadScheduledDate && (
            <div className="flex items-center gap-2 min-w-0">
              <Calendar className="h-4 w-4 shrink-0" />
              <span className="truncate min-w-0">Scheduled: {leadScheduledDate}</span>
            </div>
          )}
          {lead.assignedToUserName && (
            <div className="flex items-center gap-2 min-w-0">
              <UserCheck className="h-4 w-4 shrink-0" />
              <span className="truncate min-w-0">{lead.assignedToUserName}</span>
            </div>
          )}
        </div>
        
        <CommunicationActionButtons
          recipientName={leadName}
          recipientEmail={leadEmail}
          recipientPhone={leadPhone}
          onSendEmail={() => onSendEmail?.(lead)}
          leadId={lead.id}
          recipientAddress={leadAddress}
          contactId={lead.id}
          status={lead.status ?? undefined}
          source={leadSource}
          notes={lead.notes ?? undefined}
          followUpDate={lead.followUpDate ? new Date(lead.followUpDate).toLocaleDateString() : undefined}
          hasUnreadText={hasUnreadText}
          hasUnreadEmail={hasUnreadEmail}
          onTextSent={onTextSent}
          onCallCompleted={onCallCompleted}
        />
        
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            size="sm"
            className="flex-1 sm:flex-none w-full sm:w-auto"
            onClick={() => onSchedule?.(lead.id)}
            data-testid={`button-schedule-lead-${lead.id}`}
          >
            Schedule
          </Button>
        </div>
        
        {/* Customer Section - shown when lead is converted to customer */}
        {lead.hasJobs && (
          <div className="pt-2 border-t">
            <div className="flex items-center gap-2 text-sm">
              <Badge variant="default" className="bg-green-500 hover:bg-green-600">
                Customer
              </Badge>
              <span className="text-muted-foreground text-xs">This lead has been converted to a customer</span>
            </div>
          </div>
        )}
        
        {/* Workflow Enrollment Badges */}
        <WorkflowEnrollmentBadges contactId={lead.id} variant="compact" />
        
        {/* Tags Display */}
        {leadTags.length > 0 && (
          <div className="pt-2 border-t">
            <div className="flex flex-wrap gap-2">
              {leadTags.map((tag: string) => (
                <Badge
                  key={tag}
                  variant="secondary"
                  className="text-xs"
                  data-testid={`badge-lead-tag-${tag}`}
                >
                  {tag}
                </Badge>
              ))}
            </div>
          </div>
        )}
      </CardContent>
      
      {/* Date watermarks */}
      <div className="absolute bottom-2 left-3 right-3 flex items-center justify-between gap-2 text-[10px] text-muted-foreground/40 pointer-events-none select-none">
        {(lead.lastActivityAt || lead.createdAt) && (
          <span>Last Activity: {new Date(lead.lastActivityAt || lead.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
        )}
        {lead.createdAt && (
          <span>Created: {new Date(lead.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
        )}
      </div>

      {/* Tags Dialog */}
      <TagsDialog
        open={tagsDialogOpen}
        onOpenChange={setTagsDialogOpen}
        tags={leadTags}
        onSave={(newTags) => {
          updateContact.mutate({ contactId: lead.id, updates: { tags: newTags } });
        }}
        entityName={leadName}
        entityType="lead"
      />
    </Card>
    </div>
  );
});
