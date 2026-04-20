import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { RefreshCw, X } from "lucide-react";

interface RefreshBannerProps {
  onRefresh: () => void;
  onDismiss: () => void;
}

export function RefreshBanner({ onRefresh, onDismiss }: RefreshBannerProps) {
  const [isRefreshing, setIsRefreshing] = useState(false);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    
    try {
      // Use the onRefresh callback provided by parent
      // This preserves user authentication and settings
      onRefresh();
    } catch (error) {
      console.error('Refresh failed:', error);
      setIsRefreshing(false);
      // Fallback to simple reload
      window.location.reload();
    }
  };

  return (
    <Card className="fixed top-4 left-1/2 transform -translate-x-1/2 z-50 shadow-lg border border-yellow-200 bg-yellow-50">
      <div className="flex items-center gap-3 p-3">
        <RefreshCw className="h-5 w-5 text-yellow-600" />
        <div className="flex-1">
          <p className="text-sm font-medium text-yellow-800">
            App Update Available
          </p>
          <p className="text-xs text-yellow-700">
            Please refresh to see the latest changes
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={handleRefresh}
            disabled={isRefreshing}
            data-testid="button-refresh-app"
          >
            {isRefreshing ? (
              <RefreshCw className="h-3 w-3 animate-spin mr-1" />
            ) : (
              <RefreshCw className="h-3 w-3 mr-1" />
            )}
            Refresh
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onDismiss}
            data-testid="button-dismiss-refresh"
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      </div>
    </Card>
  );
}