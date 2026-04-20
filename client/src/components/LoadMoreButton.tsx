import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

type LoadMoreButtonProps = {
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
  label?: string;
  testId?: string;
};

export function LoadMoreButton({
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
  label = "Load More",
  testId,
}: LoadMoreButtonProps) {
  if (!hasNextPage) return null;

  return (
    <div className="flex justify-center mt-8">
      <Button
        onClick={onLoadMore}
        disabled={isFetchingNextPage}
        variant="outline"
        data-testid={testId}
      >
        {isFetchingNextPage ? (
          <>
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            Loading...
          </>
        ) : (
          label
        )}
      </Button>
    </div>
  );
}
