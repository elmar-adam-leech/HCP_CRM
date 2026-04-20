import { createContext, useContext, useState, useEffect, ReactNode, useRef, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { CheckCircle, AlertCircle, Loader2 } from "lucide-react";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useWebSocketContext } from "@/contexts/WebSocketContext";

interface SyncStatus {
  isRunning: boolean;
  progress?: string;
  error?: string;
  lastSync?: Date;
}

interface SyncStatusContextType {
  syncStatus: SyncStatus;
  startSync: () => void;
}

const SyncStatusContext = createContext<SyncStatusContextType | undefined>(undefined);

export function useSyncStatus() {
  const context = useContext(SyncStatusContext);
  if (!context) {
    throw new Error("useSyncStatus must be used within a SyncStatusProvider");
  }
  return context;
}

export function SyncStatusProvider({ children }: { children: ReactNode }) {
  const [syncStatus, setSyncStatus] = useState<SyncStatus>({
    isRunning: false,
  });
  const { toast } = useToast();
  const previousSyncStatus = useRef<SyncStatus>({ isRunning: false });
  const toastId = useRef<string | null>(null);
  const { subscribe } = useWebSocketContext();

  const { data: authData } = useCurrentUser();
  const user = authData?.user;
  const canReceiveSyncUpdates =
    user?.role === 'admin' ||
    user?.role === 'super_admin' ||
    user?.role === 'manager' ||
    user?.canManageIntegrations === true ||
    user?.gmailConnected === true ||
    user?.hasActiveCompanyIntegrations === true;

  const { data: currentSyncStatus } = useQuery<SyncStatus>({
    queryKey: ['/api/sync-status'],
    enabled: canReceiveSyncUpdates,
    refetchInterval: 5 * 60 * 1000,
    refetchIntervalInBackground: false,
    staleTime: 60_000,
  });

  const handleSyncStatusUpdate = useCallback((newStatus: SyncStatus) => {
    const prevStatus = previousSyncStatus.current;

    if (!prevStatus.isRunning && newStatus.isRunning) {
      toast({
        title: newStatus.progress?.includes('Dialpad') ? "Syncing with Dialpad..." : "Syncing...",
        description: newStatus.progress || "Starting sync...",
        action: <Loader2 className="h-4 w-4 animate-spin" />,
        duration: Infinity,
      });
      toastId.current = "sync-running";
    } else if (prevStatus.isRunning && !newStatus.isRunning && !newStatus.error) {
      if (toastId.current) {
        toastId.current = null;
      }

      toast({
        title: "Sync completed successfully!",
        description: newStatus.lastSync
          ? `Completed at ${new Date(newStatus.lastSync).toLocaleTimeString()}`
          : "Your data is now up to date",
        action: <CheckCircle className="h-4 w-4 text-green-600" />,
        duration: 5000,
      });
    } else if (newStatus.error && newStatus.error !== prevStatus.error) {
      if (toastId.current) {
        toastId.current = null;
      }

      toast({
        title: "Sync Error",
        description: newStatus.error,
        action: <AlertCircle className="h-4 w-4 text-destructive" />,
        duration: 8000,
        variant: "destructive",
      });
    }

    setSyncStatus(newStatus);
    previousSyncStatus.current = newStatus;
  }, [toast]);

  useEffect(() => {
    if (!canReceiveSyncUpdates) return;

    const unsubscribe = subscribe((msg) => {
      if (msg.type === 'sync_status') {
        const wsStatus: SyncStatus = {
          isRunning: !!msg.isRunning,
          progress: (msg.progress as string) || undefined,
          error: (msg.error as string) || undefined,
          lastSync: msg.lastSync ? new Date(msg.lastSync as string) : undefined,
        };
        handleSyncStatusUpdate(wsStatus);
      }
    });
    return unsubscribe;
  }, [subscribe, canReceiveSyncUpdates, handleSyncStatusUpdate]);

  useEffect(() => {
    if (currentSyncStatus) {
      handleSyncStatusUpdate(currentSyncStatus);
    }
  }, [currentSyncStatus, handleSyncStatusUpdate]);

  const startSync = () => {
    const optimisticStatus: SyncStatus = {
      isRunning: true,
      error: undefined,
      progress: 'Starting sync...',
    };
    setSyncStatus(optimisticStatus);
    previousSyncStatus.current = optimisticStatus;

    toast({
      title: "Syncing...",
      description: "Starting sync...",
      action: <Loader2 className="h-4 w-4 animate-spin" />,
      duration: Infinity,
    });
    toastId.current = "sync-running";
  };

  return (
    <SyncStatusContext.Provider value={{ syncStatus, startSync }}>
      {children}
    </SyncStatusContext.Provider>
  );
}
