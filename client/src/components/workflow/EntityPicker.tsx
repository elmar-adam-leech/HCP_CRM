import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Check, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { apiRequest } from "@/lib/queryClient";

export type EntityOption = {
  id: string;
  name: string;
  subtitle: string;
};

type EntityPickerProps = {
  entityType: string;
  value: EntityOption | null;
  onChange: (value: EntityOption | null) => void;
  placeholder?: string;
};

/**
 * Typeahead picker used by the workflow Test dialog. Hits the
 * /api/workflows/test-entities endpoint, which returns a uniform
 * {id,name,subtitle} shape for leads/contacts/estimates/jobs so the picker
 * doesn't need to know each entity's column layout.
 */
export function EntityPicker({ entityType, value, onChange, placeholder }: EntityPickerProps) {
  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchQuery), 250);
    return () => clearTimeout(t);
  }, [searchQuery]);

  const { data: results = [], isLoading } = useQuery<EntityOption[]>({
    queryKey: ['/api/workflows/test-entities', { entityType, search: debouncedSearch }],
    queryFn: async () => {
      const params = new URLSearchParams({ entityType, limit: '15' });
      if (debouncedSearch) params.set('search', debouncedSearch);
      const r = await apiRequest('GET', `/api/workflows/test-entities?${params.toString()}`);
      return r.json();
    },
    enabled: open,
  });

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between"
          data-testid="button-select-test-entity"
        >
          <span className="truncate text-left">
            {value
              ? `${value.name}${value.subtitle ? ` — ${value.subtitle}` : ''}`
              : (placeholder || `Search ${entityType}…`)}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder={`Search ${entityType}…`}
            value={searchQuery}
            onValueChange={setSearchQuery}
            data-testid="input-search-test-entity"
          />
          <CommandList>
            <CommandEmpty>
              <div className="p-2 text-sm text-muted-foreground">
                {isLoading ? 'Searching…' : `No ${entityType} found.`}
              </div>
            </CommandEmpty>
            <CommandGroup>
              {results.map((opt) => (
                <CommandItem
                  key={opt.id}
                  value={opt.id}
                  onSelect={() => {
                    onChange(opt);
                    setOpen(false);
                  }}
                  data-testid={`option-test-entity-${opt.id}`}
                >
                  <Check
                    className={cn(
                      "mr-2 h-4 w-4",
                      value?.id === opt.id ? "opacity-100" : "opacity-0",
                    )}
                  />
                  <div className="flex flex-col min-w-0">
                    <span className="truncate">{opt.name}</span>
                    {opt.subtitle && (
                      <span className="text-xs text-muted-foreground truncate">
                        {opt.subtitle}
                      </span>
                    )}
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
