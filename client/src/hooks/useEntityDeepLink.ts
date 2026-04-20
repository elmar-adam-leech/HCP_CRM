import { useEffect } from "react";
import { useToast } from "@/hooks/use-toast";

/**
 * Handles the "?open=ID" deep-link pattern shared by entity list pages.
 *
 * When the page URL contains `?open=<id>`:
 *  1. If the entity is already in `entities`, open its detail modal immediately.
 *  2. Otherwise, call `fetchFn(id)` to fetch/assemble the entity and open the modal.
 *  3. In both cases, strip the `?open=` param from the URL so refreshing/sharing
 *     doesn't re-open the modal unexpectedly.
 *
 * @param entities     - The currently loaded list of entities (must have an `id` field).
 * @param isLoading    - Whether the entity list is still loading (prevents premature fetch).
 * @param urlSearch    - The raw `window.location.search` string (used to detect `?open=`).
 * @param fetchFn      - Async function that fetches/assembles the entity by ID and returns
 *                       it shaped for `onOpen`. May make multiple API calls internally.
 * @param onOpen       - Callback invoked with the resolved entity to open its detail modal.
 * @param notFoundMsg  - Human-readable label used in the "not found" toast (e.g. "lead").
 */
export function useEntityDeepLink<T extends { id: string }>({
  entities,
  isLoading,
  urlSearch,
  fetchFn,
  onOpen,
  notFoundMsg = "record",
}: {
  entities: T[];
  isLoading: boolean;
  urlSearch: string;
  fetchFn: (id: string) => Promise<T>;
  onOpen: (entity: T) => void;
  notFoundMsg?: string;
}) {
  const { toast } = useToast();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const openId = params.get("open");
    if (!openId) return;

    const fromLoaded = entities.find((e) => e.id === openId);
    if (fromLoaded) {
      onOpen(fromLoaded);
      window.history.replaceState({}, "", window.location.pathname);
      return;
    }

    if (entities.length === 0 && isLoading) return;

    fetchFn(openId)
      .then((entity) => {
        onOpen(entity);
        window.history.replaceState({}, "", window.location.pathname);
      })
      .catch(() => {
        window.history.replaceState({}, "", window.location.pathname);
        toast({
          title: "Not Found",
          description: `The requested ${notFoundMsg} could not be found.`,
          variant: "destructive",
        });
      });
  }, [entities, isLoading, urlSearch]);
}
