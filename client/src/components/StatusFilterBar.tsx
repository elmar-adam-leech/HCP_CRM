import { memo, type ReactNode } from "react";
import { Filter } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { formatStatusLabel } from "@/lib/utils";

type StatusFilterBarProps = {
  statuses: readonly string[];
  activeStatus: string;
  counts: Record<string, number | undefined>;
  onStatusChange: (status: string) => void;
  formatLabel?: (status: string) => string;
  extraFilters?: ReactNode;
};

export const StatusFilterBar = memo(function StatusFilterBar({
  statuses,
  activeStatus,
  counts,
  onStatusChange,
  formatLabel = formatStatusLabel,
  extraFilters,
}: StatusFilterBarProps) {
  const allStatuses = ["all", ...statuses] as const;

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
      <div className="flex items-center gap-2">
        <Filter className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm text-muted-foreground hidden sm:inline">Quick Filter:</span>
      </div>
      <div className="flex flex-wrap gap-2">
        {allStatuses.map((status) => {
          const count = counts[status];
          const label = status === "all" ? "All" : formatLabel(status);
          const countLabel = count !== undefined ? ` (${count})` : "";
          return (
            <Badge
              key={status}
              variant={activeStatus === status ? "default" : "outline"}
              className="cursor-pointer hover-elevate"
              onClick={() => onStatusChange(status)}
              data-testid={`filter-${status}`}
            >
              {label}{countLabel}
            </Badge>
          );
        })}
        {extraFilters}
      </div>
    </div>
  );
});
