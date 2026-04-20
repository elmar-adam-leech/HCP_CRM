import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { getStatusBadgeClasses } from "@/lib/card-utils";

type StatusBadgeProps = {
  status: "new" | "scheduled" | "sent" | "approved" | "rejected" | "declined" | "in_progress" | "completed" | "cancelled" | "contacted" | "qualified" | "converted" | "disqualified";
  entityType?: "lead" | "estimate" | "job";
  className?: string;
};

const statusLabels: Record<string, string> = {
  new: "New",
  contacted: "Contacted",
  scheduled: "Scheduled",
  sent: "Sent",
  approved: "Approved",
  rejected: "Rejected",
  declined: "Declined",
  qualified: "Qualified",
  converted: "Converted",
  disqualified: "Disqualified",
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
  const isRed = status === "rejected" || status === "declined" || status === "disqualified" || status === "cancelled";
  const variant = isRed ? "destructive" as const : (colorClasses ? "default" as const : "secondary" as const);

  return (
    <Badge
      variant={variant}
      className={cn(colorClasses, className)}
      data-testid={`badge-status-${status}`}
    >
      {label}
    </Badge>
  );
}
