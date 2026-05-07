import { useQuery } from "@tanstack/react-query";
import { isToday, isPast, isThisWeek } from "date-fns";
import { Clock, AlertCircle, Calendar, ArrowRight, User, FileText } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Link } from "wouter";

interface FollowUpItem {
  id: string;
  type: "lead" | "estimate";
  name: string;
  followUpDate: string;
  followUpReason: string;
}

const getFollowUpStatus = (followUpDate: string) => {
  const date = new Date(followUpDate);
  if (isPast(date) && !isToday(date)) {
    return { label: "Overdue", variant: "destructive" as const, icon: AlertCircle };
  } else if (isToday(date)) {
    return { label: "Today", variant: "default" as const, icon: Clock };
  } else if (isThisWeek(date)) {
    return { label: "This Week", variant: "secondary" as const, icon: Calendar };
  } else {
    return { label: "Upcoming", variant: "outline" as const, icon: Calendar };
  }
};

export function FollowUpsWidget() {
  // The unified endpoint now always returns `{ items, total, hasMore }`
  // (paging envelope). Widget mode caps the page size to 5 server-side, so
  // we just unwrap `items` and ignore the pager fields here.
  const { data, isLoading } = useQuery<{ items: FollowUpItem[]; total: number; hasMore: boolean }>({
    queryKey: ["/api/follow-ups/unified", { widget: true }],
    queryFn: async () => {
      const res = await fetch("/api/follow-ups/unified?widget=true");
      if (!res.ok) throw new Error("Failed to fetch follow-ups");
      return res.json();
    },
  });
  const followUpItems: FollowUpItem[] = data?.items ?? [];

  return (
    <Card data-testid="card-followups-widget">
      <CardHeader className="flex flex-row items-center justify-between gap-1 space-y-0 pb-2">
        <CardTitle className="text-lg font-medium">Upcoming Follow-ups</CardTitle>
        <Link href="/follow-ups">
          <Button variant="ghost" size="sm" data-testid="link-view-all-followups">
            View all
            <ArrowRight className="h-3 w-3 ml-1" />
          </Button>
        </Link>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-3">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="animate-pulse">
                <div className="h-4 bg-muted rounded w-1/3 mb-2"></div>
                <div className="h-3 bg-muted rounded w-1/2"></div>
              </div>
            ))}
          </div>
        ) : followUpItems.length === 0 ? (
          <div className="text-center py-6 text-muted-foreground">
            <Calendar className="mx-auto h-8 w-8 mb-2 opacity-50" />
            <p className="text-sm">No upcoming follow-ups</p>
          </div>
        ) : (
          <div className="space-y-3">
            {followUpItems.map((item) => {
              const status = getFollowUpStatus(item.followUpDate);
              const StatusIcon = status.icon;
              const TypeIcon = item.type === 'lead' ? User : FileText;
              
              return (
                <div 
                  key={`${item.type}-${item.id}`} 
                  className="flex items-start justify-between gap-2 p-3 rounded-md hover-elevate"
                  data-testid={`item-followup-${item.id}`}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <TypeIcon className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                      <span className="font-medium text-sm truncate" data-testid={`text-name-${item.id}`}>
                        {item.name}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <StatusIcon className="h-3 w-3 flex-shrink-0" />
                      <span className="truncate" data-testid={`text-reason-${item.id}`}>
                        {item.followUpReason}
                      </span>
                    </div>
                  </div>
                  <Badge variant={status.variant} className="text-xs flex-shrink-0" data-testid={`badge-status-${item.id}`}>
                    {status.label}
                  </Badge>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
