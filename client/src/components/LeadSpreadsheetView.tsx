import { memo, useState } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { StatusBadge } from "./StatusBadge";
import { getStatusRowBorderColor } from "@/lib/card-utils";
import {
  MoreHorizontal,
  Edit,
  Trash2,
  Settings,
  CalendarClock,
  Archive,
  ArchiveRestore,
  MessageSquare,
  Mail,
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
  Clock,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import type { Contact } from "@shared/schema";
import { CallButton } from "./CallButton";
import { TextButton } from "./TextButton";
import { EmailButton } from "./EmailButton";
import { EmailComposerModal } from "./EmailComposerModal";
import { formatDateSpreadsheet } from "@/lib/utils";

type LeadSpreadsheetViewProps = {
  leads: Contact[];
  isLoading: boolean;
  onLeadClick: (leadId: string) => void;
  onEdit: (leadId: string) => void;
  onDelete: (leadId: string) => void;
  onArchive?: (leadId: string) => void;
  onRestore?: (leadId: string) => void;
  onAge?: (leadId: string) => void;
  onUnage?: (leadId: string) => void;
  onEditStatus: (leadId: string) => void;
  onSetFollowUp: (lead: Contact) => void;
  onSchedule?: (leadId: string) => void;
  sortDir?: "asc" | "desc" | null;
  onSortChange?: () => void;
  onEmailSent?: (contactId: string) => void;
  onTextSent?: (contactId: string) => void;
  onCallCompleted?: (contactId: string) => void;
  unreadCounts?: Record<string, { text: number; email: number }>;
};

export const LeadSpreadsheetView = memo(function LeadSpreadsheetView({
  leads,
  isLoading,
  onLeadClick,
  onEdit,
  onDelete,
  onArchive,
  onRestore,
  onAge,
  onUnage,
  onEditStatus,
  onSetFollowUp,
  onSchedule,
  sortDir = null,
  onSortChange,
  onEmailSent,
  onTextSent,
  onCallCompleted,
  unreadCounts,
}: LeadSpreadsheetViewProps) {
  const [emailingLead, setEmailingLead] = useState<Contact | null>(null);
  const [activitySortDir, setActivitySortDir] = useState<"asc" | "desc" | null>(null);

  function handleActivitySort() {
    setActivitySortDir((prev) => {
      if (prev === null) return "desc";
      if (prev === "desc") return "asc";
      return null;
    });
  }

  const displayLeads = activitySortDir === null
    ? leads
    : [...leads].sort((a, b) => {
        const aTime = a.lastActivityAt ? new Date(a.lastActivityAt).getTime() : (a.createdAt ? new Date(a.createdAt).getTime() : 0);
        const bTime = b.lastActivityAt ? new Date(b.lastActivityAt).getTime() : (b.createdAt ? new Date(b.createdAt).getTime() : 0);
        return activitySortDir === "desc" ? bTime - aTime : aTime - bTime;
      });

  const CreatedSortIcon = sortDir === "desc" ? ArrowDown : sortDir === "asc" ? ArrowUp : ArrowUpDown;
  const ActivitySortIcon = activitySortDir === "desc" ? ArrowDown : activitySortDir === "asc" ? ArrowUp : ArrowUpDown;

  return (
    <>
      <div className="rounded-md border" data-testid="leads-spreadsheet">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Assigned To</TableHead>
              <TableHead>Follow-up Date</TableHead>
              <TableHead>
                <button
                  onClick={onSortChange}
                  className="flex items-center gap-1 font-medium text-left hover:text-foreground transition-colors"
                  data-testid="sort-created-date"
                >
                  Created Date
                  <CreatedSortIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                </button>
              </TableHead>
              <TableHead>
                <button
                  onClick={handleActivitySort}
                  className="flex items-center gap-1 font-medium text-left hover:text-foreground transition-colors"
                  data-testid="sort-activity-date"
                >
                  Activity Date
                  <ActivitySortIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                </button>
              </TableHead>
              <TableHead className="w-28">Contact</TableHead>
              <TableHead className="w-12">Schedule</TableHead>
              <TableHead className="w-12" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && Array.from({ length: 8 }, (_, i) => (
              <TableRow key={`skeleton-${i}`}>
                <TableCell><Skeleton className="h-4 w-32" /></TableCell>
                <TableCell><Skeleton className="h-5 w-20" /></TableCell>
                <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                <TableCell />
                <TableCell />
                <TableCell />
              </TableRow>
            ))}
            {displayLeads.map((lead) => {
              const phone =
                lead.phones && lead.phones.length > 0 ? lead.phones[0] : null;
              const email =
                lead.emails && lead.emails.length > 0 ? lead.emails[0] : null;

              return (
                <TableRow
                  key={lead.id}
                  className={`cursor-pointer ${getStatusRowBorderColor('lead', lead.status || 'new')}`}
                  onClick={() => onLeadClick(lead.id)}
                  data-testid={`row-lead-${lead.id}`}
                >
                  <TableCell className="font-medium">{lead.name || "—"}</TableCell>
                  <TableCell>
                    {lead.status ? (
                      <StatusBadge
                        status={
                          lead.status as Parameters<typeof StatusBadge>[0]["status"]
                        }
                        entityType="lead"
                      />
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {lead.assignedToUserName || "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDateSpreadsheet(lead.followUpDate)}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDateSpreadsheet(lead.createdAt)}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDateSpreadsheet(lead.lastActivityAt || lead.createdAt)}
                  </TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center gap-1">
                      <CallButton
                        recipientName={lead.name || ""}
                        recipientPhone={phone || ""}
                        leadId={lead.id}
                        variant="ghost"
                        size="icon"
                        onCallCompleted={onCallCompleted ? () => onCallCompleted(lead.id) : undefined}
                      />
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="inline-flex">
                            {phone ? (
                              <TextButton
                                recipientName={lead.name || ""}
                                recipientPhone={phone}
                                variant="ghost"
                                size="icon"
                                leadId={lead.id}
                                recipientEmail={email || undefined}
                                recipientAddress={lead.address ?? undefined}
                                contactId={lead.id}
                                status={lead.status ?? undefined}
                                source={lead.source ?? undefined}
                                notes={lead.notes ?? undefined}
                                followUpDate={lead.followUpDate ? new Date(lead.followUpDate).toLocaleDateString() : undefined}
                                onSent={onTextSent ? () => onTextSent(lead.id) : undefined}
                                hasUnread={(unreadCounts?.[lead.id]?.text ?? 0) > 0}
                              >
                                <MessageSquare className="h-4 w-4" />
                              </TextButton>
                            ) : (
                              <Button
                                variant="ghost"
                                size="icon"
                                disabled
                                aria-label="No phone number"
                                className="opacity-30 cursor-not-allowed pointer-events-none"
                                data-testid={`button-text-lead-${lead.id}`}
                              >
                                <MessageSquare className="h-4 w-4" />
                              </Button>
                            )}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>{phone || "No phone number"}</TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="inline-flex">
                            {email ? (
                              <EmailButton
                                recipientName={lead.name || ""}
                                recipientEmail={email}
                                variant="ghost"
                                size="icon"
                                leadId={lead.id}
                                onSendEmail={() => setEmailingLead(lead)}
                                hasUnread={(unreadCounts?.[lead.id]?.email ?? 0) > 0}
                              >
                                <Mail className="h-4 w-4" />
                              </EmailButton>
                            ) : (
                              <Button
                                variant="ghost"
                                size="icon"
                                disabled
                                aria-label="No email"
                                className="opacity-30 cursor-not-allowed pointer-events-none"
                                data-testid={`button-email-lead-${lead.id}`}
                              >
                                <Mail className="h-4 w-4" />
                              </Button>
                            )}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>{email || "No email"}</TooltipContent>
                      </Tooltip>
                    </div>
                  </TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Schedule"
                      onClick={() => onSchedule?.(lead.id)}
                      data-testid={`button-schedule-${lead.id}`}
                    >
                      <CalendarClock className="h-4 w-4" />
                    </Button>
                  </TableCell>
                  <TableCell
                    onClick={(e) => e.stopPropagation()}
                  >
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          data-testid={`button-lead-menu-${lead.id}`}
                        >
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-48">
                        <DropdownMenuItem
                          onClick={() => onSetFollowUp(lead)}
                          data-testid={`menu-set-followup-${lead.id}`}
                        >
                          <CalendarClock className="h-4 w-4 mr-2" />
                          Set Follow Up
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => onEdit(lead.id)}
                          data-testid={`menu-edit-lead-${lead.id}`}
                        >
                          <Edit className="h-4 w-4 mr-2" />
                          Edit Lead
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => onEditStatus(lead.id)}
                          data-testid={`menu-edit-status-${lead.id}`}
                        >
                          <Settings className="h-4 w-4 mr-2" />
                          Edit Status
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        {onRestore && (
                          <DropdownMenuItem
                            onClick={() => onRestore(lead.id)}
                            data-testid={`menu-restore-lead-${lead.id}`}
                          >
                            <ArchiveRestore className="h-4 w-4 mr-2" />
                            Restore Lead
                          </DropdownMenuItem>
                        )}
                        {onUnage && (
                          <DropdownMenuItem
                            onClick={() => onUnage(lead.id)}
                            data-testid={`menu-unage-lead-${lead.id}`}
                          >
                            <ArchiveRestore className="h-4 w-4 mr-2" />
                            Restore Lead
                          </DropdownMenuItem>
                        )}
                        {onArchive && (
                          <DropdownMenuItem
                            onClick={() => onArchive(lead.id)}
                            data-testid={`menu-archive-lead-${lead.id}`}
                          >
                            <Archive className="h-4 w-4 mr-2" />
                            Archive Lead
                          </DropdownMenuItem>
                        )}
                        {onAge && (
                          <DropdownMenuItem
                            onClick={() => onAge(lead.id)}
                            data-testid={`menu-age-lead-${lead.id}`}
                          >
                            <Clock className="h-4 w-4 mr-2" />
                            Mark as Aged
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuItem
                          onClick={() => onDelete(lead.id)}
                          className="text-destructive focus:text-destructive"
                          data-testid={`menu-delete-lead-${lead.id}`}
                        >
                          <Trash2 className="h-4 w-4 mr-2" />
                          Delete Lead
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {emailingLead && (
        <EmailComposerModal
          isOpen={!!emailingLead}
          onClose={() => setEmailingLead(null)}
          recipientName={emailingLead.name || ""}
          recipientEmail={
            emailingLead.emails && emailingLead.emails.length > 0
              ? emailingLead.emails[0]
              : ""
          }
          recipientPhone={emailingLead.phones?.[0] || ""}
          recipientAddress={emailingLead.address || ""}
          contactId={emailingLead.id}
          leadId={emailingLead.id}
          onSent={onEmailSent ? () => {
            const leadId = emailingLead.id;
            onEmailSent(leadId);
            setEmailingLead(null);
          } : undefined}
        />
      )}
    </>
  );
});
