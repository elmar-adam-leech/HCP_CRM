import { useState, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface UseHcpImportOptions {
  entityType: "jobs" | "estimates";
  syncStartDate: string | null;
  queryKeysToInvalidate: string[];
}

export function useHcpImport({ entityType, syncStartDate, queryKeysToInvalidate }: UseHcpImportOptions) {
  const [importDateOpen, setImportDateOpen] = useState(false);
  const [selectedImportDate, setSelectedImportDate] = useState<Date | undefined>(undefined);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (syncStartDate) {
      setSelectedImportDate(new Date(syncStartDate));
    }
  }, [syncStartDate]);

  const handleConfirmImport = async () => {
    setImportDateOpen(false);
    toast({ title: "Import Started", description: `Importing ${entityType} from Housecall Pro...` });

    const selectedDateISO = selectedImportDate?.toISOString();
    const dateChanged = selectedDateISO && selectedDateISO !== syncStartDate;

    try {
      if (dateChanged) {
        await apiRequest("POST", "/api/housecall-pro/sync-start-date", { syncStartDate: selectedDateISO });
      }
      const response = await apiRequest("POST", `/api/housecall-pro/sync?type=${entityType}`);
      const data = await response.json();
      queryKeysToInvalidate.forEach((key) => queryClient.invalidateQueries({ queryKey: [key] }));
      const countKey = entityType === "jobs" ? "newJobs" : "newEstimates";
      const count = data[countKey];
      toast({
        title: "Import Successful",
        description: `Successfully imported ${entityType} from Housecall Pro.${count ? ` Added ${count} new ${entityType}.` : ""}`,
      });
    } catch (error: unknown) {
      if (dateChanged) {
        await apiRequest("POST", "/api/housecall-pro/sync-start-date", { syncStartDate }).catch((err: unknown) => {
          console.error("[useHcpImport] Failed to revert sync-start-date:", err);
        });
      }
      toast({
        title: "Import Failed",
        description: error instanceof Error ? error.message : `Failed to import ${entityType} from Housecall Pro`,
        variant: "destructive",
      });
    }
  };

  return { importDateOpen, setImportDateOpen, selectedImportDate, setSelectedImportDate, handleConfirmImport };
}
