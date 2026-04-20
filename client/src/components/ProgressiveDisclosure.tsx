import { useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface ProgressiveDisclosureProps {
  children: React.ReactNode;
  triggerLabel?: string;
  defaultOpen?: boolean;
  className?: string;
  contentClassName?: string;
}

export function ProgressiveDisclosure({
  children,
  triggerLabel = "Show more",
  defaultOpen = false,
  className,
  contentClassName,
}: ProgressiveDisclosureProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen} className={cn("w-full", className)}>
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="flex items-center gap-1 text-muted-foreground hover:text-foreground"
          data-testid="button-toggle-disclosure"
        >
          <span className="text-sm">{isOpen ? "Show less" : triggerLabel}</span>
          {isOpen ? (
            <ChevronUp className="h-4 w-4" />
          ) : (
            <ChevronDown className="h-4 w-4" />
          )}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className={cn("pt-2", contentClassName)}>
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}
