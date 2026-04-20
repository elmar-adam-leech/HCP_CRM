import { useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

type Contractor = {
  id: string;
  name: string;
  domain: string;
  role?: string;
  logoUrl?: string | null;
};

type ContractorSwitcherProps = {
  contractors: Contractor[];
  currentContractor: Contractor;
  onContractorChange: (contractor: Contractor) => void;
};

export function ContractorSwitcher({
  contractors,
  currentContractor,
  onContractorChange,
}: ContractorSwitcherProps) {
  const [open, setOpen] = useState(false);

  const handleSelect = (contractor: Contractor) => {
    onContractorChange(contractor);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between"
          data-testid="button-contractor-switcher"
        >
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <img
              src={currentContractor.logoUrl || "/hcp-crm-logo.png"}
              alt={currentContractor.name}
              className="h-7 w-7 shrink-0 object-contain"
            />

            <div className="text-left min-w-0 flex-1">
              <div className="font-medium truncate">{currentContractor.name}</div>
              <div className="text-xs text-muted-foreground truncate">
                {currentContractor.role} • {currentContractor.domain}
              </div>
            </div>
          </div>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-full p-0 z-50">
        <Command>
          <CommandInput placeholder="Search contractors..." />
          <CommandEmpty>No contractor found.</CommandEmpty>
          <CommandList>
            <CommandGroup>
              {contractors.map((contractor) => (
                <CommandItem
                  key={contractor.id}
                  value={contractor.name}
                  onSelect={() => handleSelect(contractor)}
                  data-testid={`item-contractor-${contractor.id}`}
                >
                  <Check
                    className={cn(
                      "mr-2 h-4 w-4",
                      currentContractor.id === contractor.id ? "opacity-100" : "opacity-0"
                    )}
                  />
                  <div className="flex flex-col">
                    <span className="font-medium">{contractor.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {contractor.role} • {contractor.domain}
                    </span>
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