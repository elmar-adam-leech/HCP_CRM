import { FileText, Phone, Mail, MessageSquare, Calendar, UserCheck, AlertCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type ActivityType =
  | "note"
  | "call"
  | "email"
  | "sms"
  | "meeting"
  | "follow_up"
  | "status_change";

const ICON_MAP: Record<ActivityType, typeof FileText> = {
  note: FileText,
  call: Phone,
  email: Mail,
  sms: MessageSquare,
  meeting: Calendar,
  follow_up: UserCheck,
  status_change: AlertCircle,
};

const COLOR_MAP: Record<ActivityType, string> = {
  note: "bg-chart-1/10 text-chart-1",
  call: "bg-chart-2/10 text-chart-2",
  email: "bg-chart-3/10 text-chart-3",
  sms: "bg-chart-4/10 text-chart-4",
  meeting: "bg-chart-5/10 text-chart-5",
  follow_up: "bg-primary/10 text-primary",
  status_change: "bg-destructive/10 text-destructive",
};

export function getActivityIcon(type: ActivityType) {
  const Icon = ICON_MAP[type] ?? FileText;
  return <Icon className="w-4 h-4" />;
}

export function getActivityTypeColor(type: ActivityType): string {
  return COLOR_MAP[type] ?? "bg-muted text-muted-foreground";
}

export function getActivityTypeLabel(type: ActivityType): string {
  return type.replace("_", " ").toLowerCase();
}

interface ActivityTypeBadgeProps {
  type: ActivityType;
  showLabel?: boolean;
  className?: string;
}

export function ActivityTypeBadge({ type, showLabel = false, className }: ActivityTypeBadgeProps) {
  return (
    <Badge
      variant="secondary"
      className={cn(getActivityTypeColor(type), "border-0", className)}
    >
      {getActivityIcon(type)}
      {showLabel && <span className="ml-1">{getActivityTypeLabel(type)}</span>}
    </Badge>
  );
}
