import { Badge } from "@/components/ui/badge";
import { CheckCircle2 } from "lucide-react";

interface CustomerBadgeProps {
  hasJobs?: boolean;
  className?: string;
}

export function CustomerBadge({ hasJobs, className }: CustomerBadgeProps) {
  if (!hasJobs) {
    return null;
  }

  return (
    <Badge 
      variant="outline" 
      className={`border-green-600 dark:border-green-500 text-green-700 dark:text-green-400 ${className || ''}`}
      data-testid="badge-customer"
    >
      <CheckCircle2 className="w-3 h-3 mr-1" />
      Customer
    </Badge>
  );
}
