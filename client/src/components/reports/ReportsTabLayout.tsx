import { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export interface ReportItem {
  slug: string;
  name: string;
  render: () => ReactNode;
}

interface ReportsTabLayoutProps {
  items: ReportItem[];
  activeSlug: string;
  onSelect: (slug: string) => void;
  testIdPrefix?: string;
}

export function ReportsTabLayout({
  items,
  activeSlug,
  onSelect,
  testIdPrefix = "report",
}: ReportsTabLayoutProps) {
  const active = items.find((i) => i.slug === activeSlug) ?? items[0];

  return (
    <div className="flex flex-col gap-4 md:flex-row md:gap-6">
      <div className="md:hidden">
        <Select value={active?.slug} onValueChange={onSelect}>
          <SelectTrigger data-testid={`select-${testIdPrefix}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {items.map((item) => (
              <SelectItem
                key={item.slug}
                value={item.slug}
                data-testid={`select-${testIdPrefix}-${item.slug}`}
              >
                {item.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <nav
        className="hidden md:flex md:w-48 md:flex-shrink-0 md:flex-col md:gap-1"
        aria-label="Reports navigation"
      >
        {items.map((item) => {
          const isActive = item.slug === active?.slug;
          return (
            <Button
              key={item.slug}
              variant="ghost"
              className="justify-start data-[active=true]:bg-sidebar-accent data-[active=true]:text-sidebar-accent-foreground"
              data-active={isActive}
              data-testid={`button-${testIdPrefix}-${item.slug}`}
              onClick={() => onSelect(item.slug)}
            >
              {item.name}
            </Button>
          );
        })}
      </nav>

      <div className="flex-1 min-w-0">{active?.render()}</div>
    </div>
  );
}
