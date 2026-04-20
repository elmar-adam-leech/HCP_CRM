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
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  MoreHorizontal,
  Edit,
  CalendarClock,
  CalendarX,
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
  Calendar,
  MessageSquare,
  Mail,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";
import { CallButton } from "./CallButton";
import { TextButton } from "./TextButton";
import { EmailButton } from "./EmailButton";
import { FollowUpItem, getFollowUpStatus } from "./FollowUpCard";
import { formatDateSpreadsheet, formatCurrency } from "@/lib/utils";

type FollowUpSpreadsheetViewProps = {
  items: FollowUpItem[];
  isLoading: boolean;
  onSetFollowUp: (item: FollowUpItem) => void;
  onContact: (item: FollowUpItem, method: "phone" | "email") => void;
  onEdit: (item: FollowUpItem) => void;
  onOpenDetail: (item: FollowUpItem) => void;
  onRemoveFollowUp: (item: FollowUpItem) => void;
};

export const FollowUpSpreadsheetView = memo(function FollowUpSpreadsheetView({
  items,
  isLoading,
  onSetFollowUp,
  onContact,
  onEdit,
  onOpenDetail,
  onRemoveFollowUp,
}: FollowUpSpreadsheetViewProps) {
  const [sortDir, setSortDir] = useState<"asc" | "desc" | null>(null);

  function handleFollowUpDateSort() {
    setSortDir((prev) => {
      if (prev === null) return "desc";
      if (prev === "desc") return "asc";
      return null;
    });
  }

  const sortedItems =
    sortDir === null
      ? items
      : [...items].sort((a, b) => {
          const aTime = a.followUpDate
            ? new Date(a.followUpDate).getTime()
            : 0;
          const bTime = b.followUpDate
            ? new Date(b.followUpDate).getTime()
            : 0;
          return sortDir === "desc" ? bTime - aTime : aTime - bTime;
        });

  const SortIcon =
    sortDir === "desc"
      ? ArrowDown
      : sortDir === "asc"
        ? ArrowUp
        : ArrowUpDown;

  if (!isLoading && items.length === 0) {
    return (
      <Card>
        <CardContent className="p-8 text-center">
          <Calendar className="mx-auto h-12 w-12 text-muted-foreground mb-4" />
          <h3 className="text-lg font-semibold mb-2">No follow-ups scheduled</h3>
          <p className="text-muted-foreground">
            You're all caught up! No leads, estimates, or jobs need follow-up right now.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="rounded-md border" data-testid="followups-spreadsheet">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>
              <button
                onClick={handleFollowUpDateSort}
                className="flex items-center gap-1 font-medium text-left hover:text-foreground transition-colors"
                data-testid="sort-followup-date"
              >
                Follow-up Date
                <SortIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              </button>
            </TableHead>
            <TableHead>Follow-up Reason</TableHead>
            <TableHead>Value</TableHead>
            <TableHead className="w-32">Contact</TableHead>
            <TableHead className="w-12">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading &&
            Array.from({ length: 6 }, (_, i) => (
              <TableRow key={`skeleton-${i}`}>
                <TableCell>
                  <Skeleton className="h-4 w-32" />
                </TableCell>
                <TableCell>
                  <Skeleton className="h-5 w-16" />
                </TableCell>
                <TableCell>
                  <Skeleton className="h-5 w-20" />
                </TableCell>
                <TableCell>
                  <Skeleton className="h-4 w-24" />
                </TableCell>
                <TableCell>
                  <Skeleton className="h-4 w-40" />
                </TableCell>
                <TableCell>
                  <Skeleton className="h-4 w-20" />
                </TableCell>
                <TableCell />
                <TableCell />
              </TableRow>
            ))}
          {sortedItems.map((item) => {
            const status = getFollowUpStatus(item.followUpDate);
            const StatusIcon = status.icon;

            return (
              <TableRow
                key={`${item.type}-${item.id}`}
                data-testid={`row-followup-${item.id}`}
              >
                <TableCell className="font-medium">
                  <button
                    className="text-left hover:underline focus:outline-none focus:underline"
                    onClick={() => onOpenDetail(item)}
                    data-testid={`link-name-${item.id}`}
                  >
                    {item.name || "—"}
                  </button>
                </TableCell>
                <TableCell>
                  <Badge variant="secondary" className="text-xs">
                    {item.type === "lead" ? "Lead" : item.type === "estimate" ? "Estimate" : "Job"}
                  </Badge>
                </TableCell>
                <TableCell>
                  <Badge
                    variant={status.variant}
                    className="flex items-center gap-1 w-fit"
                    data-testid={`badge-status-${item.id}`}
                  >
                    <StatusIcon className="h-3 w-3" />
                    {status.label}
                  </Badge>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {formatDateSpreadsheet(item.followUpDate)}
                </TableCell>
                <TableCell className="text-muted-foreground max-w-48 truncate">
                  {item.followUpReason || "—"}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {item.type === "lead" ? "—" : (() => {
                    const raw = item.value ?? item.amount;
                    if (raw === undefined || raw === null || raw === "") return "—";
                    const num = typeof raw === "string" ? parseFloat(raw) : raw;
                    return isNaN(num) ? "—" : formatCurrency(num);
                  })()}
                </TableCell>
                <TableCell onClick={(e) => e.stopPropagation()}>
                  <div className="flex items-center gap-1">
                    <CallButton
                      recipientName={item.name}
                      recipientPhone={item.phone || ""}
                      leadId={item.type === "lead" ? item.id : (item.contactId ?? undefined)}
                      estimateId={item.type === "estimate" ? item.id : undefined}
                      variant="ghost"
                      size="icon"
                    />
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="inline-flex">
                          {item.phone ? (
                            <TextButton
                              recipientName={item.name}
                              recipientPhone={item.phone}
                              variant="ghost"
                              size="icon"
                              leadId={item.type === "lead" ? item.id : (item.contactId ?? undefined)}
                              estimateId={
                                item.type === "estimate" ? item.id : undefined
                              }
                              recipientEmail={item.email}
                              recipientAddress={item.address}
                              contactId={item.contactId ?? (item.type === "lead" ? item.id : undefined)}
                              status={item.status}
                              source={item.source}
                              notes={item.notes}
                              followUpDate={item.followUpDate}
                            />
                          ) : (
                            <Button
                              variant="ghost"
                              size="icon"
                              disabled
                              aria-label="No phone number"
                              className="opacity-30 cursor-not-allowed pointer-events-none"
                              data-testid={`button-text-followup-${item.id}`}
                            >
                              <MessageSquare className="h-4 w-4" />
                            </Button>
                          )}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>
                        {item.phone || "No phone number"}
                      </TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="inline-flex">
                          {item.email ? (
                            <EmailButton
                              recipientName={item.name}
                              recipientEmail={item.email}
                              variant="ghost"
                              size="icon"
                              leadId={item.type === "lead" ? item.id : (item.contactId ?? undefined)}
                              estimateId={
                                item.type === "estimate" ? item.id : undefined
                              }
                              onSendEmail={() => onContact(item, "email")}
                            />
                          ) : (
                            <Button
                              variant="ghost"
                              size="icon"
                              disabled
                              aria-label="No email"
                              className="opacity-30 cursor-not-allowed pointer-events-none"
                              data-testid={`button-email-followup-${item.id}`}
                            >
                              <Mail className="h-4 w-4" />
                            </Button>
                          )}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>{item.email || "No email"}</TooltipContent>
                    </Tooltip>
                  </div>
                </TableCell>
                <TableCell onClick={(e) => e.stopPropagation()}>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        data-testid={`button-followup-menu-${item.id}`}
                      >
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-48">
                      <DropdownMenuItem
                        onClick={() => onEdit(item)}
                        data-testid={`menu-edit-${item.id}`}
                      >
                        <Edit className="h-4 w-4 mr-2" />
                        {item.type === "lead" ? "Edit Lead" : item.type === "estimate" ? "Edit Estimate" : "Edit Job"}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => onSetFollowUp(item)}
                        data-testid={`menu-set-followup-${item.id}`}
                      >
                        <CalendarClock className="h-4 w-4 mr-2" />
                        Reschedule
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => onRemoveFollowUp(item)}
                        data-testid={`menu-remove-followup-${item.id}`}
                      >
                        <CalendarX className="h-4 w-4 mr-2" />
                        Remove Follow-Up
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
  );
});
