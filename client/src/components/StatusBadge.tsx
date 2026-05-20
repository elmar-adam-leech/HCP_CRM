import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { getStatusBadgeClasses } from "@/lib/card-utils";
import { Ban, XCircle } from "lucide-react";

type StatusBadgeProps = {
  status: "new" | "scheduled" | "sent" | "approved" | "rejected" | "declined" | "in_progress" | "completed" | "cancelled" | "contacted" | "qualified" | "converted" | "disqualified" | "lost";
  entityType?: "lead" | "estimate" | "job";
  className?: string;
};

const statusLabels: Record<string, string> = {
  new: "New",
  contacted: "Following Up",
  scheduled: "Scheduled",
  sent: "Sent",
  approved: "Approved",
  rejected: "Rejected",
  declined: "Declined",
  qualified: "Qualified",
  converted: "Converted",
  disqualified: "Disqualified",
  lost: "Lost",
  in_progress: "In Progress",
  completed: "Completed",
  cancelled: "Cancelled",
};

export function StatusBadge({ status, entityType, className }: StatusBadgeProps) {
  const label = statusLabels[status];

  if (!label) {
    console.warn(`Unknown status: ${status}`);
    return (
      <Badge variant="secondary" className={className} data-testid={`badge-status-${status}`}>
        {status}
      </Badge>
    );
  }

  const colorClasses = entityType ? getStatusBadgeClasses(entityType, status) : "";
  const isRed = status === "rejected" || status === "declined" || status === "disqualified" || status === "cancelled" || status === "lost";
  const variant = isRed ? "destructive" as const : (colorClasses ? "default" as const : "secondary" as const);

  // Distinguish the two destructive lead-terminal statuses at a glance:
  // Disqualified (bad-fit) gets Ban; Lost (real lost-deal) gets XCircle.
  const Icon = status === "lost" ? XCircle : status === "disqualified" ? Ban : null;

  return (
    <Badge
      variant={variant}
      className={cn("gap-1", colorClasses, className)}
      data-testid={`badge-status-${status}`}
    >
      {Icon ? <Icon className="w-3 h-3" /> : null}
      {label}
    </Badge>
  );
}
