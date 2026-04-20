import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useBulkSelection } from "@/contexts/BulkSelectionContext";
import { X, Trash2, Download, Edit, Archive, RotateCcw, Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import { useState } from "react";
import { DeleteConfirmDialog } from "@/components/DeleteConfirmDialog";
import { useToast } from "@/hooks/use-toast";

interface BulkActionToolbarProps {
  onDelete?: (ids: string[]) => Promise<void>;
  onStatusChange?: (ids: string[], status: string) => Promise<void>;
  onExport?: (ids: string[]) => Promise<void>;
  onArchive?: (ids: string[]) => Promise<void>;
  onRestore?: (ids: string[]) => Promise<void>;
  onAge?: (ids: string[]) => Promise<void>;
  onUnage?: (ids: string[]) => Promise<void>;
  statusOptions?: { value: string; label: string }[];
  className?: string;
}

export function BulkActionToolbar({
  onDelete,
  onStatusChange,
  onExport,
  onArchive,
  onRestore,
  onAge,
  onUnage,
  statusOptions = [],
  className,
}: BulkActionToolbarProps) {
  const { selectedIds, selectedCount, clearSelection, isSelectionMode } = useBulkSelection();
  const { toast } = useToast();
  const [isProcessing, setIsProcessing] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  if (!isSelectionMode) return null;

  const handleDeleteConfirm = async () => {
    if (!onDelete) return;
    setDeleteDialogOpen(false);
    setIsProcessing(true);
    try {
      await onDelete(Array.from(selectedIds));
      clearSelection();
    } catch (error) {
      console.error("Failed to delete items:", error);
      toast({
        variant: "destructive",
        title: "Delete failed",
        description: error instanceof Error ? error.message : "Failed to delete the selected items. Please try again.",
      });
    } finally {
      setIsProcessing(false);
    }
  };

  const handleStatusChange = async (status: string) => {
    if (!onStatusChange) return;
    setIsProcessing(true);
    try {
      await onStatusChange(Array.from(selectedIds), status);
      clearSelection();
    } catch (error) {
      console.error("Failed to update status:", error);
      toast({
        variant: "destructive",
        title: "Status update failed",
        description: error instanceof Error ? error.message : "Failed to update the selected items. Please try again.",
      });
    } finally {
      setIsProcessing(false);
    }
  };

  const handleExport = async () => {
    if (!onExport) return;
    setIsProcessing(true);
    try {
      await onExport(Array.from(selectedIds));
    } catch (error) {
      console.error("Failed to export items:", error);
      toast({
        variant: "destructive",
        title: "Export failed",
        description: error instanceof Error ? error.message : "Failed to export the selected items. Please try again.",
      });
    } finally {
      setIsProcessing(false);
    }
  };

  const handleBulkAction = async (action: ((ids: string[]) => Promise<void>) | undefined, label: string) => {
    if (!action) return;
    setIsProcessing(true);
    try {
      await action(Array.from(selectedIds));
      clearSelection();
    } catch (error) {
      console.error(`Failed to ${label} items:`, error);
      toast({
        variant: "destructive",
        title: `${label} failed`,
        description: error instanceof Error ? error.message : `Failed to ${label.toLowerCase()} the selected items. Please try again.`,
      });
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <>
      <div
        className={cn(
          "fixed bottom-0 left-0 right-0 bg-primary text-primary-foreground shadow-lg border-t z-50",
          "transition-transform duration-300 ease-in-out",
          className
        )}
        data-testid="bulk-action-toolbar"
      >
        <div className="container mx-auto px-4 py-3">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-4">
              <span className="font-medium" data-testid="text-selected-count">
                {selectedCount} {selectedCount === 1 ? "item" : "items"} selected
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={clearSelection}
                disabled={isProcessing}
                className="text-primary-foreground hover:bg-primary-foreground/20"
                data-testid="button-clear-selection"
              >
                <X className="h-4 w-4 mr-1" />
                Clear
              </Button>
            </div>

            <div className="flex items-center gap-2">
              {statusOptions.length > 0 && onStatusChange && (
                <Select onValueChange={handleStatusChange} disabled={isProcessing}>
                  <SelectTrigger
                    className="w-[180px] bg-white/90 border-white/40 text-primary hover:bg-white"
                    data-testid="select-status-change"
                  >
                    <Edit className="h-4 w-4 mr-2" />
                    <SelectValue placeholder="Change status" />
                  </SelectTrigger>
                  <SelectContent>
                    {statusOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}

              {onArchive && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleBulkAction(onArchive, "Archive")}
                  disabled={isProcessing}
                  className="text-primary-foreground hover:bg-primary-foreground/20"
                  data-testid="button-bulk-archive"
                >
                  <Archive className="h-4 w-4 mr-1" />
                  Archive
                </Button>
              )}

              {onRestore && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleBulkAction(onRestore, "Restore")}
                  disabled={isProcessing}
                  className="text-primary-foreground hover:bg-primary-foreground/20"
                  data-testid="button-bulk-restore"
                >
                  <RotateCcw className="h-4 w-4 mr-1" />
                  Restore
                </Button>
              )}

              {onAge && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleBulkAction(onAge, "Mark as Aged")}
                  disabled={isProcessing}
                  className="text-primary-foreground hover:bg-primary-foreground/20"
                  data-testid="button-bulk-age"
                >
                  <Clock className="h-4 w-4 mr-1" />
                  Mark Aged
                </Button>
              )}

              {onUnage && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleBulkAction(onUnage, "Restore from Aged")}
                  disabled={isProcessing}
                  className="text-primary-foreground hover:bg-primary-foreground/20"
                  data-testid="button-bulk-unage"
                >
                  <RotateCcw className="h-4 w-4 mr-1" />
                  Restore
                </Button>
              )}

              {onExport && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleExport}
                  disabled={isProcessing}
                  className="text-primary-foreground hover:bg-primary-foreground/20"
                  data-testid="button-export"
                >
                  <Download className="h-4 w-4 mr-1" />
                  Export
                </Button>
              )}

              {onDelete && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setDeleteDialogOpen(true)}
                  disabled={isProcessing}
                  className="text-primary-foreground hover:bg-destructive hover:text-destructive-foreground"
                  data-testid="button-delete"
                >
                  <Trash2 className="h-4 w-4 mr-1" />
                  Delete
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>

      <DeleteConfirmDialog
        isOpen={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        title="Delete Items"
        description={`Are you sure you want to delete ${selectedCount} ${selectedCount === 1 ? "item" : "items"}? This action cannot be undone.`}
        onConfirm={handleDeleteConfirm}
        confirmTestId="button-confirm-bulk-delete"
      />
    </>
  );
}
