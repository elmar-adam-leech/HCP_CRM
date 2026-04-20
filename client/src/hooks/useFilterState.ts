import { useState, useEffect } from "react";
import { useSearch } from "wouter";
import { useDebounce } from "@/hooks/use-debounce";

interface UseFilterStateOptions {
  externalSearch?: string;
  resetDeps?: unknown[];
}

/**
 * Shared hook that encapsulates:
 *  - URL search-param → state sync (one-time on mount / when URL changes)
 *  - Debounced search query
 *  - Page reset whenever filters change
 *
 * Usage:
 *   const { searchQuery, setSearchQuery, debouncedSearch, page, setPage } = useFilterState({ externalSearch });
 */
export function useFilterState({
  externalSearch = "",
  resetDeps = [],
}: UseFilterStateOptions = {}) {
  const urlSearch = useSearch();

  const urlParams = new URLSearchParams(urlSearch);
  const initialSearch = externalSearch || urlParams.get("search") || "";

  const [searchQuery, setSearchQuery] = useState(initialSearch);
  const debouncedSearch = useDebounce(searchQuery, 300);
  const [page, setPage] = useState(1);

  useEffect(() => {
    const params = new URLSearchParams(urlSearch);
    const searchParam = params.get("search");
    if (searchParam) {
      setSearchQuery(searchParam);
      window.history.replaceState({}, "", window.location.pathname);
    } else if (externalSearch !== undefined) {
      setSearchQuery(externalSearch);
    }
  }, [externalSearch, urlSearch]);

  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, ...resetDeps]);

  return {
    searchQuery,
    setSearchQuery,
    debouncedSearch,
    page,
    setPage,
    urlSearch,
  };
}
