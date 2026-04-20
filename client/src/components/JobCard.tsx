import { memo, useState } from "react";
import { useIsMobile } from "@/hooks/use-mobile";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { StatusBadge } from "./StatusBadge";
import { Calendar, Clock, MoreHorizontal, ExternalLink, Phone, Mail, Tag, Trash2 } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { ViewDetailsButton } from "./ViewDetailsButton";
import { TagsDialog } from "./TagsDialog";
import { useContact } from "@/hooks/useContact";
import { useToast } from "@/hooks/use-toast";
import { getInitials, formatCurrency, formatEntityTitle, hcpUrl } from "@/lib/utils";
import { getStatusBorderColor, updateContactTags } from "@/lib/card-utils";

type JobCardProps = {
  job: {
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
    priority: "low" | "medium" | "high";
    estimatedHours: number | null;
    externalSource?: string;
    externalId?: string;
    estimateId?: string;
  };
  onStatusChange?: (jobId: string, newStatus: string) => void;
  onViewDetails?: (jobId: string) => void;
  onDelete?: (jobId: string, jobTitle: string) => void;
  selectable?: boolean;
  isSelected?: boolean;
  onToggleSelect?: () => void;
  hasUnreadText?: boolean;
  hasUnreadEmail?: boolean;
};

export const JobCard = memo(function JobCard({ job, onStatusChange, onViewDetails, onDelete, selectable = false, isSelected = false, onToggleSelect, hasUnreadText, hasUnreadEmail }: JobCardProps) {
  const { toast } = useToast();
  const isMobile = useIsMobile();
  const showMarkComplete = isMobile
    && (job.status === "scheduled" || job.status === "in_progress")
    && job.externalSource !== 'housecall-pro'
    && !!onStatusChange;
  const [tagsDialogOpen, setTagsDialogOpen] = useState(false);

  const { data: contact } = useContact(job.contactId);

  const isHousecallProJob = job.externalSource === 'housecall-pro';

  const handleUpdateContactTags = async (newTags: string[]) => {
    if (!contact) return;
    try {
      await updateContactTags(contact.id, newTags);
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
    <Card
      className={`hover-elevate ${getStatusBorderColor('job', job.status)}`}
      data-testid={`card-job-${job.id}`}
    >
      <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0 pb-2">
        {selectable && (
          <Checkbox
            checked={isSelected}
            onCheckedChange={() => onToggleSelect?.()}
            data-testid={`checkbox-job-${job.id}`}
            className="shrink-0 mt-1"
          />
        )}
        <div className="space-y-1 flex-1 min-w-0">
          <CardTitle className="text-base font-medium line-clamp-2">{formatEntityTitle('job', job.title)}</CardTitle>
          <div className="flex items-center gap-2 flex-wrap">
            <StatusBadge status={job.status} entityType="job" />
            <span className="text-xs text-muted-foreground">{job.type}</span>
            {isHousecallProJob && job.externalId && (
              <a
                href={hcpUrl('job', job.externalId)}
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
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="shrink-0" data-testid={`button-job-menu-${job.id}`}>
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <ViewDetailsButton
              onViewDetails={() => onViewDetails?.(job.id)}
              testId={`menu-view-details-${job.id}`}
            />
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => setTagsDialogOpen(true)} data-testid={`menu-add-tags-${job.id}`}>
              <Tag className="h-4 w-4 mr-2" />
              Add Tags
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => onDelete?.(job.id, formatEntityTitle('job', job.title))}
              className="text-destructive focus:text-destructive"
              data-testid={`menu-delete-job-${job.id}`}
            >
              <Trash2 className="h-4 w-4 mr-2" />
              Delete Job
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Avatar className="h-6 w-6">
              <AvatarFallback className="text-xs">
                {getInitials(job.contactName)}
              </AvatarFallback>
            </Avatar>
            <span className="text-sm text-muted-foreground">{job.contactName}</span>
          </div>
          <div className="flex items-center gap-1 text-sm font-medium">
            {formatCurrency(job.value)}
          </div>
        </div>

        <div className="space-y-2 text-sm text-muted-foreground">
          <div className="flex items-center gap-2 min-w-0">
            <Mail className="h-4 w-4 shrink-0" />
            <span className="truncate min-w-0">{job.contactEmail || 'No email'}</span>
          </div>
          <div className="flex items-center gap-2 min-w-0">
            <Phone className="h-4 w-4 shrink-0" />
            <span className="truncate min-w-0">{job.contactPhone || 'No phone'}</span>
          </div>
          <div className="flex items-center gap-2">
            <Calendar className="h-4 w-4" />
            <span>{job.scheduledDate}</span>
          </div>
          {job.estimatedHours != null && (
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4" />
              <span>{job.estimatedHours}h estimated</span>
            </div>
          )}
        </div>

        {isHousecallProJob && (
          <div className="text-xs text-muted-foreground bg-blue-500/10 border border-blue-500/20 p-2 rounded-md">
            <span className="font-medium">Tracking Only:</span> This job was automatically synced from Housecall Pro for lead value tracking. Status updates are managed in Housecall Pro.
          </div>
        )}

        <div className="flex gap-2 pt-2 border-t">
          <Button
            variant="outline"
            size="sm"
            className="flex-1"
            onClick={() => onViewDetails?.(job.id)}
            data-testid={`button-view-job-${job.id}`}
          >
            View Details
          </Button>
        </div>

        {showMarkComplete && (
          <Button
            variant="default"
            size="sm"
            className="w-full"
            onClick={() => onStatusChange!(job.id, 'completed')}
            data-testid={`button-mark-complete-${job.id}`}
          >
            Mark Complete
          </Button>
        )}

        {contact?.tags && contact.tags.length > 0 && (
          <div className="pt-2 border-t">
            <div className="flex flex-wrap gap-2">
              {contact.tags.map((tag: string) => (
                <Badge
                  key={tag}
                  variant="secondary"
                  className="text-xs"
                  data-testid={`badge-job-tag-${tag}`}
                >
                  {tag}
                </Badge>
              ))}
            </div>
          </div>
        )}
      </CardContent>

      {contact && (
        <TagsDialog
          open={tagsDialogOpen}
          onOpenChange={setTagsDialogOpen}
          tags={contact.tags || []}
          onSave={handleUpdateContactTags}
          entityName={contact.name}
          entityType="job"
        />
      )}
    </Card>
  );
});
