import { useSyncStatus } from "@/hooks/use-sync-status";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Progress } from "@/components/ui/progress";
import { CheckCircle, AlertCircle, Loader2 } from "lucide-react";
import { useState, useEffect } from "react";

export function SyncStatusBar() {
  const { syncStatus } = useSyncStatus();
  const [showSuccess, setShowSuccess] = useState(false);

  useEffect(() => {
    // Show success message for 5 seconds after sync completes
    if (!syncStatus.isRunning && syncStatus.lastSync) {
      setShowSuccess(true);
      const timer = setTimeout(() => {
        setShowSuccess(false);
      }, 5000);
      return () => clearTimeout(timer);
    }
  }, [syncStatus.isRunning, syncStatus.lastSync]);

  // Don't show anything if no sync activity
  if (!syncStatus.isRunning && !showSuccess && !syncStatus.error) {
    return null;
  }

  if (syncStatus.error) {
    return (
      <Alert className="m-4 border-destructive" data-testid="sync-error-bar">
        <AlertCircle className="h-4 w-4 text-destructive" />
        <AlertDescription>
          <strong>Sync Error:</strong> {syncStatus.error}
        </AlertDescription>
      </Alert>
    );
  }

  if (syncStatus.isRunning) {
    return (
      <Alert className="m-4 border-blue-500 bg-blue-50 dark:bg-blue-950" data-testid="sync-running-bar">
        <Loader2 className="h-4 w-4 animate-spin text-blue-600" />
        <AlertDescription className="text-blue-800 dark:text-blue-200">
          <div className="flex items-center justify-between">
            <span>
              <strong>Syncing...</strong>
              {syncStatus.progress && <span className="ml-2">{syncStatus.progress}</span>}
            </span>
          </div>
          <Progress value={undefined} className="mt-2 h-2" />
        </AlertDescription>
      </Alert>
    );
  }

  if (showSuccess) {
    return (
      <Alert className="m-4 border-green-500 bg-green-50 dark:bg-green-950" data-testid="sync-success-bar">
        <CheckCircle className="h-4 w-4 text-green-600" />
        <AlertDescription className="text-green-800 dark:text-green-200">
          <strong>Sync completed successfully!</strong> 
          {syncStatus.lastSync && (
            <span className="ml-2">
              at {new Date(syncStatus.lastSync).toLocaleTimeString()}
            </span>
          )}
        </AlertDescription>
      </Alert>
    );
  }

  return null;
}