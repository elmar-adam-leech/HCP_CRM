import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { downloadCsv } from "@/lib/csv";

export type BulkEntityType = "contact" | "job" | "estimate";

export interface BulkEntity {
  id: string;
  [key: string]: unknown;
}

export interface BulkExportColumn {
  header: string;
  getValue: (entity: BulkEntity) => string | number | null | undefined;
}

interface BulkResult {
  succeeded: number;
  failed: number;
  errors: string[];
}

export interface UseBulkActionsOptions {
  entityType: BulkEntityType;
  deleteEndpoint: (id: string) => string;
  statusEndpoint: (id: string) => string;
  onInvalidate: () => void;
  exportFilename: string;
  exportHeaders: string[];
  getExportRow: (entity: BulkEntity) => (string | number | undefined)[];
  entities: BulkEntity[];
}

export interface UseBulkActionsResult {
  handleBulkDelete: (ids: string[]) => Promise<void>;
  handleBulkStatusChange: (ids: string[], status: string) => Promise<void>;
  handleBulkExport: (ids: string[]) => Promise<void>;
  isBulkPending: boolean;
}

const BULK_ENDPOINTS: Partial<Record<BulkEntityType, { status: string; delete: string }>> = {
  contact: {
    status: "/api/contacts/bulk-status",
    delete: "/api/contacts/bulk-delete",
  },
};

export function useBulkActions({
  entityType,
  deleteEndpoint,
  statusEndpoint,
  onInvalidate,
  exportFilename,
  exportHeaders,
  getExportRow,
  entities,
}: UseBulkActionsOptions): UseBulkActionsResult {
  const { toast } = useToast();
  const bulkEndpoints = BULK_ENDPOINTS[entityType];

  const deleteMutation = useMutation({
    mutationFn: async (ids: string[]) => {
      if (bulkEndpoints) {
        const res = await apiRequest("POST", bulkEndpoints.delete, { ids });
        return (await res.json()) as BulkResult;
      }
      await Promise.all(ids.map((id) => apiRequest("DELETE", deleteEndpoint(id))));
      return { succeeded: ids.length, failed: 0, errors: [] } as BulkResult;
    },
    onSuccess: (result, ids) => {
      onInvalidate();
      if (result.failed > 0 && result.succeeded > 0) {
        toast({
          title: `Deleted ${result.succeeded} of ${ids.length} item(s)`,
          description: `${result.failed} item(s) could not be deleted.`,
          variant: "destructive",
        });
      } else if (result.failed > 0) {
        toast({
          title: "Delete failed",
          description: `None of the ${ids.length} item(s) could be deleted.`,
          variant: "destructive",
        });
      } else {
        toast({ title: `Deleted ${result.succeeded} item(s)` });
      }
    },
    onError: (error) => {
      toast({
        title: "Delete failed",
        description: error instanceof Error ? error.message : "Some items could not be deleted.",
        variant: "destructive",
      });
    },
  });

  const statusMutation = useMutation({
    mutationFn: async ({ ids, status }: { ids: string[]; status: string }) => {
      if (bulkEndpoints) {
        const res = await apiRequest("POST", bulkEndpoints.status, { ids, status });
        return (await res.json()) as BulkResult;
      }
      await Promise.all(ids.map((id) => apiRequest("PATCH", statusEndpoint(id), { status })));
      return { succeeded: ids.length, failed: 0, errors: [] } as BulkResult;
    },
    onSuccess: (result, { ids, status }) => {
      onInvalidate();
      if (result.failed > 0 && result.succeeded > 0) {
        toast({
          title: `Updated ${result.succeeded} of ${ids.length} item(s) to ${status}`,
          description: `${result.failed} item(s) could not be updated.`,
          variant: "destructive",
        });
      } else if (result.failed > 0) {
        toast({
          title: "Status update failed",
          description: `None of the ${ids.length} item(s) could be updated.`,
          variant: "destructive",
        });
      } else {
        toast({ title: `Updated ${result.succeeded} item(s) to ${status}` });
      }
    },
    onError: (error) => {
      toast({
        title: "Status update failed",
        description: error instanceof Error ? error.message : "Some items could not be updated.",
        variant: "destructive",
      });
    },
  });

  const handleBulkDelete = async (ids: string[]) => {
    await deleteMutation.mutateAsync(ids);
  };

  const handleBulkStatusChange = async (ids: string[], status: string) => {
    await statusMutation.mutateAsync({ ids, status });
  };

  const handleBulkExport = async (ids: string[]) => {
    const selected = entities.filter((e) => ids.includes(e.id));
    downloadCsv(exportFilename, exportHeaders, selected.map(getExportRow));
    toast({ title: `Exported ${ids.length} item(s)` });
  };

  return {
    handleBulkDelete,
    handleBulkStatusChange,
    handleBulkExport,
    isBulkPending: deleteMutation.isPending || statusMutation.isPending,
  };
}
