import { useState, useEffect } from "react";
import { type FilterState } from "@/components/FilterPanel";
// Re-export so callers don't need to import FilterPanel separately
export type { FilterState };

export type ViewMode = "cards" | "kanban" | "spreadsheet";

export interface PagePreferences {
  viewMode?: ViewMode;
  filterStatus?: string;
  advancedFilters?: FilterState;
  searchQuery?: string;
  sortBy?: string;
  sortOrder?: "asc" | "desc";
}

interface UsePagePreferencesOptions {
  pageKey: string;
  defaultViewMode?: ViewMode;
  defaultFilterStatus?: string;
  defaultSortBy?: string;
  defaultSortOrder?: "asc" | "desc";
}

export function usePagePreferences({
  pageKey,
  defaultViewMode = "cards",
  defaultFilterStatus = "all",
  defaultSortBy,
  defaultSortOrder = "desc",
}: UsePagePreferencesOptions) {
  const storageKey = `page-preferences-${pageKey}`;

  // Load initial preferences from localStorage
  const loadPreferences = (): PagePreferences => {
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (parsed.advancedFilters) {
          if (parsed.advancedFilters.dateFrom && typeof parsed.advancedFilters.dateFrom === 'string') {
            const d = new Date(parsed.advancedFilters.dateFrom);
            parsed.advancedFilters.dateFrom = isNaN(d.getTime()) ? undefined : d;
          }
          if (parsed.advancedFilters.dateTo && typeof parsed.advancedFilters.dateTo === 'string') {
            const d = new Date(parsed.advancedFilters.dateTo);
            parsed.advancedFilters.dateTo = isNaN(d.getTime()) ? undefined : d;
          }
          if (typeof parsed.advancedFilters === 'object' && parsed.advancedFilters !== null) {
            for (const key of Object.keys(parsed.advancedFilters)) {
              const val = parsed.advancedFilters[key];
              if (val instanceof Date && isNaN(val.getTime())) {
                parsed.advancedFilters[key] = undefined;
              }
            }
          }
        } else {
          parsed.advancedFilters = {};
        }
        return parsed;
      }
    } catch (error) {
      console.error(`Failed to load preferences for ${pageKey}:`, error);
    }
    return {
      viewMode: defaultViewMode,
      filterStatus: defaultFilterStatus,
      advancedFilters: {},
      searchQuery: "",
      sortBy: defaultSortBy,
      sortOrder: defaultSortOrder,
    };
  };

  const [preferences, setPreferences] = useState<PagePreferences>(loadPreferences);

  // Save preferences to localStorage whenever they change
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(preferences));
    } catch (error) {
      console.error(`Failed to save preferences for ${pageKey}:`, error);
    }
  }, [preferences, storageKey, pageKey]);

  // Helper functions to update individual preferences
  const setViewMode = (viewMode: ViewMode) => {
    setPreferences((prev) => ({ ...prev, viewMode }));
  };

  const setFilterStatus = (filterStatus: string) => {
    setPreferences((prev) => ({ ...prev, filterStatus }));
  };

  const setAdvancedFilters = (advancedFilters: FilterState) => {
    setPreferences((prev) => ({ ...prev, advancedFilters }));
  };

  const setSearchQuery = (searchQuery: string) => {
    setPreferences((prev) => ({ ...prev, searchQuery }));
  };

  const setSortBy = (sortBy: string) => {
    setPreferences((prev) => ({ ...prev, sortBy }));
  };

  const setSortOrder = (sortOrder: "asc" | "desc") => {
    setPreferences((prev) => ({ ...prev, sortOrder }));
  };

  // Reset all preferences to defaults
  const resetPreferences = () => {
    const defaultPrefs: PagePreferences = {
      viewMode: defaultViewMode,
      filterStatus: defaultFilterStatus,
      advancedFilters: {},
      searchQuery: "",
      sortBy: defaultSortBy,
      sortOrder: defaultSortOrder,
    };
    setPreferences(defaultPrefs);
  };

  return {
    preferences,
    setViewMode,
    setFilterStatus,
    setAdvancedFilters,
    setSearchQuery,
    setSortBy,
    setSortOrder,
    resetPreferences,
    // Convenience getters
    viewMode: preferences.viewMode || defaultViewMode,
    filterStatus: preferences.filterStatus || defaultFilterStatus,
    advancedFilters: (preferences.advancedFilters || {}) as FilterState,
    searchQuery: preferences.searchQuery || "",
    sortBy: preferences.sortBy || defaultSortBy,
    sortOrder: preferences.sortOrder || defaultSortOrder,
  };
}
