import { format } from "date-fns";
import { CalendarIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

interface DatePickerProps {
  value: Date | undefined;
  onChange: (date: Date | undefined) => void;
  placeholder?: string;
  disabled?: boolean | ((date: Date) => boolean);
  className?: string;
  align?: "start" | "center" | "end";
  "data-testid"?: string;
}

export function DatePicker({
  value,
  onChange,
  placeholder = "Pick a date",
  disabled,
  className,
  align = "start",
  "data-testid": testId,
}: DatePickerProps) {
  const calendarDisabled = typeof disabled === "boolean" ? undefined : disabled;
  const buttonDisabled = typeof disabled === "boolean" ? disabled : undefined;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className={cn(
            "w-full justify-start text-left font-normal",
            !value && "text-muted-foreground",
            className
          )}
          disabled={buttonDisabled}
          data-testid={testId}
        >
          <CalendarIcon className="mr-2 h-4 w-4" />
          {value ? format(value, "PPP") : placeholder}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align={align}>
        <Calendar
          mode="single"
          selected={value}
          onSelect={onChange}
          disabled={calendarDisabled}
          initialFocus
        />
      </PopoverContent>
    </Popover>
  );
}
