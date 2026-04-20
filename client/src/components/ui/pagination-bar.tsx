import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight } from "lucide-react";

interface PaginationBarProps {
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  totalItems?: number;
  pageSize?: number;
  className?: string;
}

function buildPageRange(page: number, totalPages: number): (number | "...")[] {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }
  const pages: (number | "...")[] = [];
  if (page <= 4) {
    for (let i = 1; i <= 5; i++) pages.push(i);
    pages.push("...");
    pages.push(totalPages);
  } else if (page >= totalPages - 3) {
    pages.push(1);
    pages.push("...");
    for (let i = totalPages - 4; i <= totalPages; i++) pages.push(i);
  } else {
    pages.push(1);
    pages.push("...");
    pages.push(page - 1);
    pages.push(page);
    pages.push(page + 1);
    pages.push("...");
    pages.push(totalPages);
  }
  return pages;
}

export function PaginationBar({
  page,
  totalPages,
  onPageChange,
  totalItems,
  pageSize,
  className,
}: PaginationBarProps) {
  if (totalPages <= 1 && (totalItems === undefined || totalItems === 0)) return null;

  const pageRange = buildPageRange(page, totalPages);
  const start = totalItems !== undefined && pageSize !== undefined ? (page - 1) * pageSize + 1 : undefined;
  const end = totalItems !== undefined && pageSize !== undefined ? Math.min(page * pageSize, totalItems) : undefined;

  return (
    <div className={`flex flex-col items-center gap-2 ${className ?? ""}`}>
      {totalItems !== undefined && pageSize !== undefined && totalItems > 0 && (
        <p className="text-sm text-muted-foreground">
          Showing {start}–{end} of {totalItems}
        </p>
      )}
      {totalPages > 1 && (
        <div className="flex items-center gap-1 flex-wrap justify-center">
          <Button
            variant="outline"
            size="icon"
            onClick={() => onPageChange(page - 1)}
            disabled={page === 1}
            aria-label="Previous page"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>

          {pageRange.map((p, i) =>
            p === "..." ? (
              <span key={`ellipsis-${i}`} className="px-2 text-muted-foreground select-none">
                ...
              </span>
            ) : (
              <Button
                key={p}
                variant={p === page ? "default" : "outline"}
                size="icon"
                onClick={() => onPageChange(p as number)}
                aria-label={`Page ${p}`}
                aria-current={p === page ? "page" : undefined}
              >
                {p}
              </Button>
            )
          )}

          <Button
            variant="outline"
            size="icon"
            onClick={() => onPageChange(page + 1)}
            disabled={page === totalPages}
            aria-label="Next page"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  );
}
