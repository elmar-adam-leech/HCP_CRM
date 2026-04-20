import { memo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { DatePicker } from "@/components/ui/date-picker";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Filter, X } from "lucide-react";
import { format, subDays, startOfDay } from "date-fns";

export type FilterState = {
  status?: string;
  assignedTo?: string;
  dateFrom?: Date;
  dateTo?: Date;
};

export type DatePreset = {
  label: string;
  days: number;
};

type FilterPanelProps = {
  filters: FilterState;
  onFiltersChange: (filters: FilterState) => void;
  statusOptions?: { value: string; label: string }[];
  userOptions?: { value: string; label: string }[];
  dateLabel?: string;
  datePresets?: DatePreset[];
};

function getActivePresetDays(filters: FilterState, presets: DatePreset[]): number | null {
  if (!filters.dateFrom || filters.dateTo) return null;
  const fromDay = startOfDay(filters.dateFrom).getTime();
  for (const p of presets) {
    if (startOfDay(subDays(new Date(), p.days)).getTime() === fromDay) return p.days;
  }
  return null;
}

function getActiveFilterCount(filters: FilterState): number {
  return [
    filters.status && filters.status !== "all",
    filters.assignedTo,
    filters.dateFrom,
    filters.dateTo,
  ].filter(Boolean).length;
}

export function FilterPanelTrigger({
  filters,
  onFiltersChange,
  statusOptions = [],
  userOptions = [],
  dateLabel = "Created Date",
  datePresets,
}: FilterPanelProps) {
  const [isOpen, setIsOpen] = useState(false);

  const activeFilterCount = getActiveFilterCount(filters);
  const activePresetDays = datePresets ? getActivePresetDays(filters, datePresets) : null;
  const isAllActive = datePresets && !filters.dateFrom && !filters.dateTo;

  const clearAllFilters = () => {
    onFiltersChange({});
  };

  const updateFilter = (key: keyof FilterState, value: string | string[] | boolean | Date | undefined) => {
    onFiltersChange({ ...filters, [key]: value });
  };

  const handlePreset = (days: number) => {
    if (activePresetDays === days) {
      onFiltersChange({ ...filters, dateFrom: undefined, dateTo: undefined });
    } else {
      onFiltersChange({ ...filters, dateFrom: startOfDay(subDays(new Date(), days)), dateTo: undefined });
    }
  };

  const handleAllPreset = () => {
    onFiltersChange({ ...filters, dateFrom: undefined, dateTo: undefined });
  };

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          data-testid="button-open-filters"
          className="gap-2"
        >
          <Filter className="h-4 w-4" />
          Filters
          {activeFilterCount > 0 && (
            <Badge variant="secondary" className="ml-1 px-1.5 py-0 text-xs">
              {activeFilterCount}
            </Badge>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80" align="end" data-testid="popover-filters">
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="filter-status">Status</Label>
            <Select
              value={filters.status || "all"}
              onValueChange={(value) =>
                updateFilter("status", value === "all" ? undefined : value)
              }
            >
              <SelectTrigger id="filter-status" data-testid="select-filter-status">
                <SelectValue placeholder="All statuses" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                {statusOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {userOptions.length > 0 && (
            <div className="space-y-2">
              <Label htmlFor="filter-assigned">Assigned To</Label>
              <Select
                value={filters.assignedTo || "all"}
                onValueChange={(value) =>
                  updateFilter("assignedTo", value === "all" ? undefined : value)
                }
              >
                <SelectTrigger id="filter-assigned" data-testid="select-filter-assigned">
                  <SelectValue placeholder="All users" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All users</SelectItem>
                  {userOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-2">
            <Label>{dateLabel} Range</Label>

            {datePresets && datePresets.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pb-1">
                {datePresets.map((preset) => {
                  const active = activePresetDays === preset.days;
                  return (
                    <Button
                      key={preset.days}
                      variant="outline"
                      size="sm"
                      className={`h-7 px-2.5 text-xs${active ? " bg-primary text-primary-foreground border-primary hover:bg-primary/90" : ""}`}
                      onClick={() => handlePreset(preset.days)}
                      type="button"
                    >
                      {preset.label}
                    </Button>
                  );
                })}
                <Button
                  variant="outline"
                  size="sm"
                  className={`h-7 px-2.5 text-xs${isAllActive ? " bg-primary text-primary-foreground border-primary hover:bg-primary/90" : ""}`}
                  onClick={handleAllPreset}
                  type="button"
                >
                  All
                </Button>
              </div>
            )}

            <div className="space-y-2">
              <DatePicker
                value={filters.dateFrom}
                onChange={(date) => updateFilter("dateFrom", date)}
                placeholder="From date"
                disabled={(date) =>
                  date > new Date() || (filters.dateTo ? date > filters.dateTo : false)
                }
                data-testid="button-date-from"
              />
              <DatePicker
                value={filters.dateTo}
                onChange={(date) => updateFilter("dateTo", date)}
                placeholder="To date"
                disabled={(date) =>
                  date > new Date() || (filters.dateFrom ? date < filters.dateFrom : false)
                }
                data-testid="button-date-to"
              />
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={clearAllFilters}
              data-testid="button-clear-filters"
            >
              Clear All
            </Button>
            <Button
              size="sm"
              onClick={() => setIsOpen(false)}
              data-testid="button-apply-filters"
            >
              Apply
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function FilterPanelChips({
  filters,
  onFiltersChange,
  statusOptions = [],
  userOptions = [],
}: Pick<FilterPanelProps, "filters" | "onFiltersChange" | "statusOptions" | "userOptions">) {
  const activeFilterCount = getActiveFilterCount(filters);

  const clearAllFilters = () => {
    onFiltersChange({});
  };

  const removeFilter = (key: keyof FilterState) => {
    const newFilters = { ...filters };
    delete newFilters[key];
    onFiltersChange(newFilters);
  };

  if (activeFilterCount === 0) return null;

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {filters.status && filters.status !== "all" && (
        <Badge
          variant="secondary"
          className="gap-1 pr-1"
          data-testid="chip-filter-status"
        >
          Status: {statusOptions.find((o) => o.value === filters.status)?.label || filters.status}
          <Button
            variant="ghost"
            size="icon"
            className="h-4 w-4 p-0 hover:bg-transparent"
            onClick={() => removeFilter("status")}
            data-testid="button-remove-status"
          >
            <X className="h-3 w-3" />
          </Button>
        </Badge>
      )}

      {filters.assignedTo && (
        <Badge
          variant="secondary"
          className="gap-1 pr-1"
          data-testid="chip-filter-assigned"
        >
          Assigned: {userOptions.find((o) => o.value === filters.assignedTo)?.label || filters.assignedTo}
          <Button
            variant="ghost"
            size="icon"
            className="h-4 w-4 p-0 hover:bg-transparent"
            onClick={() => removeFilter("assignedTo")}
            data-testid="button-remove-assigned"
          >
            <X className="h-3 w-3" />
          </Button>
        </Badge>
      )}

      {filters.dateFrom && (
        <Badge
          variant="secondary"
          className="gap-1 pr-1"
          data-testid="chip-filter-date-from"
        >
          From: {format(filters.dateFrom, "MMM d, yyyy")}
          <Button
            variant="ghost"
            size="icon"
            className="h-4 w-4 p-0 hover:bg-transparent"
            onClick={() => removeFilter("dateFrom")}
            data-testid="button-remove-date-from"
          >
            <X className="h-3 w-3" />
          </Button>
        </Badge>
      )}

      {filters.dateTo && (
        <Badge
          variant="secondary"
          className="gap-1 pr-1"
          data-testid="chip-filter-date-to"
        >
          To: {format(filters.dateTo, "MMM d, yyyy")}
          <Button
            variant="ghost"
            size="icon"
            className="h-4 w-4 p-0 hover:bg-transparent"
            onClick={() => removeFilter("dateTo")}
            data-testid="button-remove-date-to"
          >
            <X className="h-3 w-3" />
          </Button>
        </Badge>
      )}

      <Button
        variant="ghost"
        size="sm"
        onClick={clearAllFilters}
        data-testid="button-clear-all-chips"
        className="h-8 px-2 text-xs"
      >
        Clear all
      </Button>
    </div>
  );
}

export const FilterPanel = memo(function FilterPanel(props: FilterPanelProps) {
  return (
    <div className="space-y-3">
      <FilterPanelTrigger {...props} />
      <FilterPanelChips
        filters={props.filters}
        onFiltersChange={props.onFiltersChange}
        statusOptions={props.statusOptions}
        userOptions={props.userOptions}
      />
    </div>
  );
});
