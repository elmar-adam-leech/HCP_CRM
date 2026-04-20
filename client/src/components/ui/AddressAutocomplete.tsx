import { useState, useRef, useEffect } from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
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

interface AddressAutocompleteProps {
  value: string;
  onChange: (value: string) => void;
  onAddressSelect: (formatted: string, components: AddressComponents) => void;
  endpoint: string;
  credentials?: RequestCredentials;
  placeholder?: string;
  "data-testid"?: string;
}

export function AddressAutocomplete({
  value,
  onChange,
  onAddressSelect,
  endpoint,
  credentials = "include",
  placeholder,
  "data-testid": testId,
}: AddressAutocompleteProps) {
  const [suggestions, setSuggestions] = useState<Array<{ placeId: string; text: string }>>([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const [anchorWidth, setAnchorWidth] = useState(0);
  const [inputValue, setInputValue] = useState(value);
  const [apiError, setApiError] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const isUserTyping = useRef(false);
  const sessionTokenRef = useRef<string | null>(null);

  const debouncedInput = useDebounce(inputValue, 300);

  useEffect(() => {
    setInputValue(value);
  }, [value]);

  useEffect(() => {
    if (showDropdown && wrapperRef.current) {
      setAnchorWidth(wrapperRef.current.offsetWidth);
    }
  }, [showDropdown]);

  useEffect(() => {
    if (!isUserTyping.current) return;

    const fetchSuggestions = async (input: string) => {
      if (!input || input.length < 3) {
        setSuggestions([]);
        setShowDropdown(false);
        return;
      }
      try {
        const token = sessionTokenRef.current;
        const autocompleteUrl = new URL(`${endpoint}/autocomplete`, window.location.href);
        autocompleteUrl.searchParams.set('input', input);
        if (token) {
          autocompleteUrl.searchParams.set('sessionToken', token);
        }
        const resp = await fetch(autocompleteUrl.toString(), { credentials });
        if (!resp.ok) {
          setApiError(true);
          setSuggestions([]);
          setShowDropdown(false);
          return;
        }
        setApiError(false);
        const data = await resp.json();
        interface PlaceSuggestion {
          placePrediction?: { placeId?: string; text?: { text?: string } };
        }
        const mapped = (data.suggestions as PlaceSuggestion[] || [])
          .map((s) => ({
            placeId: s.placePrediction?.placeId || "",
            text: s.placePrediction?.text?.text || "",
          }))
          .filter((s) => s.placeId && s.text);
        setSuggestions(mapped);
        setShowDropdown(mapped.length > 0);
      } catch (e) {
        console.warn("[Places] Failed to fetch suggestions:", e);
        setApiError(true);
        setSuggestions([]);
        setShowDropdown(false);
      }
    };

    fetchSuggestions(debouncedInput);
  }, [debouncedInput, endpoint, credentials]);

  const handleInputChange = (val: string) => {
    isUserTyping.current = true;
    if (!sessionTokenRef.current) {
      sessionTokenRef.current = crypto.randomUUID();
    }
    setApiError(false);
    onChange(val);
    setInputValue(val);
  };

  const handleSelect = async (suggestion: { placeId: string; text: string }) => {
    setShowDropdown(false);
    setSuggestions([]);
    onChange(suggestion.text);
    setInputValue(suggestion.text);
    const token = sessionTokenRef.current;
    sessionTokenRef.current = null;
    try {
      const detailsUrl = new URL(`${endpoint}/details`, window.location.href);
      detailsUrl.searchParams.set('placeId', suggestion.placeId);
      if (token) {
        detailsUrl.searchParams.set('sessionToken', token);
      }
      const resp = await fetch(detailsUrl.toString(), { credentials });
      if (!resp.ok) {
        onAddressSelect(suggestion.text, {
          street: suggestion.text,
          city: "",
          state: "",
          zip: "",
          country: "US",
        });
        return;
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
      const formatted = place.formattedAddress || suggestion.text;
      onChange(formatted);
      setInputValue(formatted);
      onAddressSelect(formatted, { street, city, state, zip, country: "US" });
    } catch (e) {
      console.warn("[Places] Failed to fetch place details:", e);
      onAddressSelect(suggestion.text, {
        street: suggestion.text,
        city: "",
        state: "",
        zip: "",
        country: "US",
      });
    }
  };

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
      <p className={`text-xs text-muted-foreground mt-1 ${apiError ? "visible" : "invisible"}`}>
        Address suggestions unavailable
      </p>
    </div>
  );
}
