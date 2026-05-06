import { useState, useRef, useEffect, forwardRef, useImperativeHandle } from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { Loader2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { PopoverContent } from "@/components/ui/popover";
import { useDebounce } from "@/hooks/use-debounce";

export interface AddressComponents {
  street: string;
  city: string;
  state: string;
  zip: string;
  country?: string;
}

export interface AddressAutocompleteRef {
  /**
   * Best-effort: if the user typed an address but never picked a suggestion,
   * resolve the top suggestion in the background and emit it via the existing
   * `onAddressSelect` callback. Resolves to the resolved address components
   * (so callers can synchronously read them in the same submit cycle without
   * waiting for a state-driven re-render), or `undefined` when nothing was
   * resolved (already picked, no suggestions, API failed, etc.).
   */
  resolvePending: () => Promise<{ formatted: string; components: AddressComponents } | undefined>;
}

interface AddressAutocompleteProps {
  value: string;
  onChange: (value: string) => void;
  onAddressSelect: (formatted: string, components: AddressComponents) => void;
  endpoint: string;
  credentials?: RequestCredentials;
  placeholder?: string;
  "data-testid"?: string;
}

interface PlaceSuggestion {
  placePrediction?: { placeId?: string; text?: { text?: string } };
}

export const AddressAutocomplete = forwardRef<AddressAutocompleteRef, AddressAutocompleteProps>(
  function AddressAutocomplete(
    {
      value,
      onChange,
      onAddressSelect,
      endpoint,
      credentials = "include",
      placeholder,
      "data-testid": testId,
    },
    ref,
  ) {
    interface CachedSuggestion { placeId: string; text: string }
    const [suggestions, setSuggestions] = useState<CachedSuggestion[]>([]);
    const [showDropdown, setShowDropdown] = useState(false);
    const [anchorWidth, setAnchorWidth] = useState(0);
    const [inputValue, setInputValue] = useState(value);
    const [apiError, setApiError] = useState(false);
    const [resolving, setResolving] = useState(false);
    const wrapperRef = useRef<HTMLDivElement>(null);
    const isUserTyping = useRef(false);
    const sessionTokenRef = useRef<string | null>(null);
    // Input string we've already resolved (via pick or auto-resolve). Used
    // so resolvePending() short-circuits when nothing has changed.
    const resolvedForValueRef = useRef<string | null>(null);
    // True from the moment a suggestion is clicked until its place-details
    // fetch completes. Prevents the blur-driven resolver (clicking a
    // suggestion blurs the input) from racing handleSelect and overwriting
    // the picked address with a re-lookup of the input text.
    const pickInFlightRef = useRef(false);
    // Cached suggestions plus the exact input they were fetched against —
    // protects against stale results being attached to a later submission.
    const suggestionsRef = useRef<CachedSuggestion[]>([]);
    const suggestionsForInputRef = useRef<string>('');
    const inputValueRef = useRef(value);
    suggestionsRef.current = suggestions;
    inputValueRef.current = inputValue;

    const debouncedInput = useDebounce(inputValue, 300);

    useEffect(() => {
      setInputValue(value);
    }, [value]);

    useEffect(() => {
      if (showDropdown && wrapperRef.current) {
        setAnchorWidth(wrapperRef.current.offsetWidth);
      }
    }, [showDropdown]);

    async function fetchSuggestionsOnce(input: string): Promise<Array<{ placeId: string; text: string }>> {
      if (!input || input.length < 3) return [];
      const token = sessionTokenRef.current;
      const autocompleteUrl = new URL(`${endpoint}/autocomplete`, window.location.href);
      autocompleteUrl.searchParams.set('input', input);
      if (token) {
        autocompleteUrl.searchParams.set('sessionToken', token);
      }
      const resp = await fetch(autocompleteUrl.toString(), { credentials });
      if (!resp.ok) {
        return [];
      }
      const data = await resp.json();
      return (data.suggestions as PlaceSuggestion[] || [])
        .map((s) => ({
          placeId: s.placePrediction?.placeId || "",
          text: s.placePrediction?.text?.text || "",
        }))
        .filter((s) => s.placeId && s.text);
    }

    async function fetchPlaceDetails(
      placeId: string,
      fallbackText: string,
    ): Promise<{ formatted: string; components: AddressComponents }> {
      const token = sessionTokenRef.current;
      try {
        const detailsUrl = new URL(`${endpoint}/details`, window.location.href);
        detailsUrl.searchParams.set('placeId', placeId);
        if (token) {
          detailsUrl.searchParams.set('sessionToken', token);
        }
        const resp = await fetch(detailsUrl.toString(), { credentials });
        if (!resp.ok) {
          return {
            formatted: fallbackText,
            components: { street: fallbackText, city: "", state: "", zip: "", country: "US" },
          };
        }
        const place = await resp.json();
        let streetNumber = "";
        let route = "";
        let city = "";
        let state = "";
        let zip = "";
        for (const component of place.addressComponents || []) {
          const types: string[] = component.types || [];
          if (types.includes("street_number")) streetNumber = component.longText || "";
          else if (types.includes("route")) route = component.longText || "";
          else if (types.includes("locality")) city = component.longText || "";
          else if (types.includes("administrative_area_level_1")) state = component.shortText || "";
          else if (types.includes("postal_code")) zip = component.longText || "";
        }
        const street = [streetNumber, route].filter(Boolean).join(" ");
        const formatted = place.formattedAddress || fallbackText;
        return { formatted, components: { street, city, state, zip, country: "US" } };
      } catch (e) {
        console.warn("[Places] Failed to fetch place details:", e);
        return {
          formatted: fallbackText,
          components: { street: fallbackText, city: "", state: "", zip: "", country: "US" },
        };
      }
    }

    useEffect(() => {
      if (!isUserTyping.current) return;

      const fetchSuggestions = async (input: string) => {
        if (!input || input.length < 3) {
          setSuggestions([]);
          setShowDropdown(false);
          return;
        }
        try {
          const mapped = await fetchSuggestionsOnce(input);
          if (mapped.length === 0) {
            // Could be empty results OR an HTTP error — fetchSuggestionsOnce
            // collapses both to []. We can't distinguish here without a
            // refactor; leaving the API-error banner state untouched on
            // empty results is the safer choice (avoids false alarms).
            setSuggestions([]);
            setShowDropdown(false);
            return;
          }
          setApiError(false);
          setSuggestions(mapped);
          suggestionsForInputRef.current = input;
          setShowDropdown(mapped.length > 0);
        } catch (e) {
          console.warn("[Places] Failed to fetch suggestions:", e);
          setApiError(true);
          setSuggestions([]);
          setShowDropdown(false);
        }
      };

      fetchSuggestions(debouncedInput);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [debouncedInput, endpoint, credentials]);

    const handleInputChange = (val: string) => {
      isUserTyping.current = true;
      if (!sessionTokenRef.current) {
        sessionTokenRef.current = crypto.randomUUID();
      }
      setApiError(false);
      // Editing invalidates any prior resolution and any cached suggestions
      // (which were fetched against the previous input string).
      resolvedForValueRef.current = null;
      if (suggestionsRef.current.length > 0) {
        setSuggestions([]);
      }
      suggestionsForInputRef.current = '';
      onChange(val);
      setInputValue(val);
    };

    // Auto-resolve on blur so the parent form has structured components
    // ready by the time submit fires. Deferred via microtask so a real
    // suggestion-click (which sets resolvedForValueRef) wins the race.
    const handleBlur = () => {
      // A suggestion pick is in flight — let handleSelect own the resolve.
      if (pickInFlightRef.current) return;
      const current = inputValueRef.current?.trim() ?? '';
      if (!current || current.length < 3) return;
      if (resolvedForValueRef.current === current) return;
      Promise.resolve().then(() => {
        if (pickInFlightRef.current) return;
        if (resolvedForValueRef.current === inputValueRef.current?.trim()) return;
        void resolvePendingInternal();
      });
    };

    const handleSelect = async (suggestion: { placeId: string; text: string }) => {
      // Mark synchronously so the blur-driven resolver (the click blurs the
      // input) short-circuits before its microtask runs.
      pickInFlightRef.current = true;
      resolvedForValueRef.current = suggestion.text;
      setShowDropdown(false);
      setSuggestions([]);
      onChange(suggestion.text);
      setInputValue(suggestion.text);
      try {
        const result = await fetchPlaceDetails(suggestion.placeId, suggestion.text);
        sessionTokenRef.current = null;
        onChange(result.formatted);
        setInputValue(result.formatted);
        onAddressSelect(result.formatted, result.components);
        resolvedForValueRef.current = result.formatted;
      } finally {
        pickInFlightRef.current = false;
      }
    };

    // Shared by the imperative ref (submit) and onBlur. Picks the top
    // suggestion only when it was fetched for the current input — fetches
    // fresh otherwise — then resolves details and broadcasts components.
    const resolvePendingInternal = async (): Promise<
      { formatted: string; components: AddressComponents } | undefined
    > => {
      const current = inputValueRef.current?.trim() ?? "";
      if (!current || current.length < 3) return undefined;
      if (resolvedForValueRef.current === current) return undefined;

      setResolving(true);
      try {
        let top: CachedSuggestion | undefined;
        if (
          suggestionsRef.current.length > 0 &&
          suggestionsForInputRef.current === current
        ) {
          top = suggestionsRef.current[0];
        }
        if (!top) {
          try {
            if (!sessionTokenRef.current) {
              sessionTokenRef.current = crypto.randomUUID();
            }
            const fresh = await fetchSuggestionsOnce(current);
            if ((inputValueRef.current?.trim() ?? "") !== current) return undefined;
            top = fresh[0];
          } catch (e) {
            console.warn("[Places] resolvePending suggestion fetch failed:", e);
            return undefined;
          }
        }
        if (!top) return undefined;
        const result = await fetchPlaceDetails(top.placeId, top.text);
        sessionTokenRef.current = null;
        onChange(result.formatted);
        setInputValue(result.formatted);
        onAddressSelect(result.formatted, result.components);
        resolvedForValueRef.current = result.formatted;
        return result;
      } finally {
        setResolving(false);
      }
    };

    useImperativeHandle(
      ref,
      () => ({ resolvePending: resolvePendingInternal }),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [],
    );

    return (
      <div ref={wrapperRef}>
        <PopoverPrimitive.Root open={showDropdown} onOpenChange={setShowDropdown}>
          <PopoverPrimitive.Anchor asChild>
            <Input
              value={value}
              onChange={(e) => handleInputChange(e.target.value)}
              onFocus={() => {
                if (suggestions.length > 0) setShowDropdown(true);
              }}
              onBlur={handleBlur}
              placeholder={placeholder}
              data-testid={testId}
              autoComplete="off"
            />
          </PopoverPrimitive.Anchor>
          <PopoverContent
            className="p-0 z-[200]"
            style={{ width: anchorWidth || undefined }}
            align="start"
            sideOffset={4}
            onOpenAutoFocus={(e) => e.preventDefault()}
            onInteractOutside={() => setShowDropdown(false)}
          >
            {suggestions.map((s, i) => (
              <button
                key={i}
                type="button"
                className="w-full text-left px-3 py-2 text-sm hover-elevate cursor-pointer"
                onMouseDown={(e) => {
                  e.preventDefault();
                  handleSelect(s);
                }}
              >
                {s.text}
              </button>
            ))}
          </PopoverContent>
        </PopoverPrimitive.Root>
        {resolving ? (
          <p
            className="flex items-center gap-1 text-xs text-muted-foreground mt-1"
            data-testid="hint-confirming-address"
          >
            <Loader2 className="h-3 w-3 animate-spin" />
            Confirming address…
          </p>
        ) : (
          <p className={`text-xs text-muted-foreground mt-1 ${apiError ? "visible" : "invisible"}`}>
            Address suggestions unavailable
          </p>
        )}
      </div>
    );
  },
);
