import { Button } from "@/components/ui/button";
import { LayoutGrid, List, Table } from "lucide-react";
import type { ViewMode } from "@/hooks/use-page-preferences";

type ViewToggleProps = {
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
};

export function ViewToggle({ viewMode, onViewModeChange }: ViewToggleProps) {
  return (
    <div className="flex items-center border rounded-md self-start sm:self-auto">
      <Button
        variant={viewMode === "cards" ? "default" : "ghost"}
        size="sm"
        onClick={() => onViewModeChange("cards")}
        data-testid="view-cards"
      >
        <LayoutGrid className="h-4 w-4" />
      </Button>
      <Button
        variant={viewMode === "kanban" ? "default" : "ghost"}
        size="sm"
        onClick={() => onViewModeChange("kanban")}
        data-testid="view-kanban"
      >
        <List className="h-4 w-4" />
      </Button>
      <Button
        variant={viewMode === "spreadsheet" ? "default" : "ghost"}
        size="sm"
        onClick={() => onViewModeChange("spreadsheet")}
        data-testid="view-spreadsheet"
      >
        <Table className="h-4 w-4" />
      </Button>
    </div>
  );
}
