import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { formatStatusLabel } from "@/lib/utils";

type EditStatusModalProps = {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  contactName?: string;
  currentStatus?: string;
  statuses: readonly string[];
  onStatusChange: (status: string) => void;
  isPending?: boolean;
};

export function EditStatusModal({
  isOpen,
  onOpenChange,
  contactName,
  currentStatus,
  statuses,
  onStatusChange,
  isPending = false,
}: EditStatusModalProps) {
  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Update Lead Status</DialogTitle>
          {contactName && (
            <DialogDescription>Change the status of {contactName}</DialogDescription>
          )}
        </DialogHeader>
        <div className="grid grid-cols-2 gap-2">
          {statuses.map((status) => (
            <Button
              key={status}
              variant={currentStatus === status ? "default" : "outline"}
              onClick={() => onStatusChange(status)}
              disabled={isPending}
              data-testid={`button-status-${status}`}
              className="justify-start"
            >
              {formatStatusLabel(status)}
            </Button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
