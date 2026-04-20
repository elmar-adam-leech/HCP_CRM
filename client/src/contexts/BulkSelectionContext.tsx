import { createContext, useContext, useState, useCallback, ReactNode } from "react";

export type EntityType = "leads" | "estimates" | "jobs";

interface BulkSelectionContextValue {
  selectedIds: Set<string>;
  entityType: EntityType | null;
  isSelectionMode: boolean;
  selectItem: (id: string, type: EntityType) => void;
  deselectItem: (id: string) => void;
  toggleItem: (id: string, type: EntityType) => void;
  selectAll: (ids: string[], type: EntityType) => void;
  clearSelection: () => void;
  isSelected: (id: string) => boolean;
  selectedCount: number;
}

const BulkSelectionContext = createContext<BulkSelectionContextValue | undefined>(undefined);

export function BulkSelectionProvider({ children }: { children: ReactNode }) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [entityType, setEntityType] = useState<EntityType | null>(null);

  const selectItem = useCallback((id: string, type: EntityType) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    setEntityType(type);
  }, []);

  const deselectItem = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      if (next.size === 0) {
        setEntityType(null);
      }
      return next;
    });
  }, []);

  const toggleItem = useCallback((id: string, type: EntityType) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
        if (next.size === 0) {
          setEntityType(null);
        }
      } else {
        next.add(id);
        setEntityType(type);
      }
      return next;
    });
  }, []);

  const selectAll = useCallback((ids: string[], type: EntityType) => {
    setSelectedIds(new Set(ids));
    setEntityType(type);
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
    setEntityType(null);
  }, []);

  const isSelected = useCallback((id: string) => {
    return selectedIds.has(id);
  }, [selectedIds]);

  const value: BulkSelectionContextValue = {
    selectedIds,
    entityType,
    isSelectionMode: selectedIds.size > 0,
    selectItem,
    deselectItem,
    toggleItem,
    selectAll,
    clearSelection,
    isSelected,
    selectedCount: selectedIds.size,
  };

  return (
    <BulkSelectionContext.Provider value={value}>
      {children}
    </BulkSelectionContext.Provider>
  );
}

export function useBulkSelection() {
  const context = useContext(BulkSelectionContext);
  if (context === undefined) {
    throw new Error("useBulkSelection must be used within a BulkSelectionProvider");
  }
  return context;
}
