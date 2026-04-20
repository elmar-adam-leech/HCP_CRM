import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

// Unified skeleton loading card used across Leads, Jobs, and Estimates lists.
//
// Previously LeadCardSkeleton, JobCardSkeleton, and EstimateCardSkeleton were
// three nearly-identical files. This single component replaces all three with
// a configurable `lines` prop so it adapts to the information density of each
// entity type without duplicating the structure.
//
// Usage:
//   <CardSkeleton lines={3} />   // Lead card (3 detail rows)
//   <CardSkeleton lines={3} />   // Job card
//   <CardSkeleton lines={4} />   // Estimate card (more detail rows)

interface CardSkeletonProps {
  /** Number of icon+text detail rows to render in the card body. Defaults to 3. */
  lines?: number;
  /** Show an extra multi-line text block at the bottom (used by estimates). */
  showMultilineBlock?: boolean;
  /** Show action badges (used by estimates). */
  showBadges?: boolean;
}

export function CardSkeleton({ lines = 3, showMultilineBlock = false, showBadges = false }: CardSkeletonProps) {
  return (
    <Card className="bg-muted/20">
      <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0 pb-2">
        <div className="flex items-center space-x-3 flex-1 min-w-0">
          <Skeleton className="h-10 w-10 rounded-full shrink-0" />
          <div className="flex-1 min-w-0 space-y-2">
            <Skeleton className="h-4 w-3/4" />
            <div className="flex items-center gap-2 flex-wrap">
              <Skeleton className="h-5 w-16" />
              <Skeleton className="h-5 w-20" />
            </div>
          </div>
        </div>
        <Skeleton className="h-8 w-8 rounded-md shrink-0" />
      </CardHeader>

      <CardContent className="space-y-3">
        <div className="space-y-2">
          {Array.from({ length: lines }).map((_, i) => (
            <div key={i} className="flex items-center gap-2 min-w-0">
              <Skeleton className="h-4 w-4 shrink-0" />
              <Skeleton className={`h-4 ${i % 3 === 0 ? "w-32" : i % 3 === 1 ? "w-28" : "w-36"}`} />
            </div>
          ))}
        </div>

        {showMultilineBlock && (
          <div className="flex items-start gap-2">
            <Skeleton className="h-4 w-4 mt-0.5 shrink-0" />
            <div className="space-y-1 flex-1">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          </div>
        )}

        {showBadges && (
          <div className="flex flex-wrap gap-2">
            <Skeleton className="h-8 w-16" />
            <Skeleton className="h-8 w-16" />
            <Skeleton className="h-8 w-16" />
          </div>
        )}

        <div className="flex gap-2 pt-2 border-t">
          <Skeleton className="h-8 flex-1" />
        </div>
      </CardContent>
    </Card>
  );
}
