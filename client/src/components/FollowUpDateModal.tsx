import { useState } from "react";
import { format } from "date-fns";
import { CalendarIcon, CalendarDays } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

interface FollowUpDateModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (date: Date | undefined) => void;
  entityName?: string;
  defaultDate?: Date;
  isSaving?: boolean;
  size?: "default" | "compact";
}

export function FollowUpDateModal({
  isOpen,
  onClose,
  onSave,
  entityName,
  defaultDate,
  isSaving = false,
  size = "default",
}: FollowUpDateModalProps) {
  const [followUpDate, setFollowUpDate] = useState<Date | undefined>(defaultDate);

  const handleClose = () => {
    setFollowUpDate(undefined);
    onClose();
  };

  const handleSave = () => {
    onSave(followUpDate);
    setFollowUpDate(undefined);
  };

  const handleClear = () => {
    setFollowUpDate(undefined);
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && handleClose()}>
      <DialogContent className={cn(
        size === "compact" && "w-full max-w-full sm:max-w-md mx-2 sm:mx-4"
      )}>
        <DialogHeader>
          <DialogTitle>Set Follow-Up Date</DialogTitle>
          <DialogDescription>
            {entityName ? `Set a follow-up date for ${entityName}` : "Set a reminder to follow up"}
          </DialogDescription>
        </DialogHeader>
        
        <div className="space-y-4">
          <div className={cn(
            "space-y-2",
            size === "compact" && "flex justify-center"
          )}>
            {size === "default" && (
              <label className="text-sm font-medium">Follow-Up Date</label>
            )}
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  className={cn(
                    "w-full justify-start text-left font-normal",
                    !followUpDate && "text-muted-foreground",
                    size === "compact" && "min-h-10"
                  )}
                  data-testid="button-follow-up-date-picker"
                >
                  {size === "compact" ? (
                    <CalendarDays className="mr-2 h-4 w-4 shrink-0" />
                  ) : (
                    <CalendarIcon className="mr-2 h-4 w-4" />
                  )}
                  <span className={size === "compact" ? "truncate" : ""}>
                    {followUpDate ? format(followUpDate, "PPP") : "Pick a date"}
                  </span>
                </Button>
              </PopoverTrigger>
              <PopoverContent 
                className="w-auto p-0" 
                align={size === "compact" ? "center" : "start"}
              >
                <Calendar
                  mode="single"
                  selected={followUpDate}
                  onSelect={setFollowUpDate}
                  initialFocus
                  data-testid="calendar-follow-up-date"
                />
              </PopoverContent>
            </Popover>
          </div>

          <div className={cn(
            "flex gap-2",
            size === "compact" ? "flex-wrap justify-end" : "justify-end space-x-2"
          )}>
            <Button
              type="button"
              variant="outline"
              size={size === "compact" ? "sm" : "default"}
              className={size === "compact" ? "w-full sm:w-auto" : ""}
              onClick={handleClose}
              data-testid="button-cancel-follow-up"
            >
              Cancel
            </Button>
            {followUpDate && (
              <Button
                type="button"
                variant="outline"
                size={size === "compact" ? "sm" : "default"}
                className={size === "compact" ? "w-full sm:w-auto" : ""}
                onClick={handleClear}
                data-testid="button-clear-follow-up"
              >
                Clear Date
              </Button>
            )}
            <Button
              size={size === "compact" ? "sm" : "default"}
              className={size === "compact" ? "w-full sm:w-auto" : ""}
              onClick={handleSave}
              disabled={isSaving}
              data-testid="button-save-follow-up"
            >
              {isSaving ? "Saving..." : "Save"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
