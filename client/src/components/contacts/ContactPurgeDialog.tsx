import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import type { Contact } from "@shared/schema";

type ContactWithCounts = Contact & {
  leadCount: number;
  estimateCount: number;
  jobCount: number;
};

interface ContactPurgeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contact: ContactWithCounts | null;
  reason: string;
  onReasonChange: (reason: string) => void;
  onConfirm: () => void;
  isPending: boolean;
}

export function ContactPurgeDialog({
  open,
  onOpenChange,
  contact,
  reason,
  onReasonChange,
  onConfirm,
  isPending,
}: ContactPurgeDialogProps) {
  const handleClose = () => {
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) handleClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Erase Personal Data</DialogTitle>
          <DialogDescription>
            This will anonymize all personally identifiable information for{" "}
            <strong>{contact?.name}</strong>. Name, email addresses, phone numbers, and address
            will be replaced with anonymized values. This action cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <Label htmlFor="erase-reason">Reason for erasure (optional)</Label>
          <Textarea
            id="erase-reason"
            value={reason}
            onChange={(e) => onReasonChange(e.target.value)}
            placeholder="e.g., Data subject request under GDPR Art. 17"
            className="min-h-[80px]"
            data-testid="textarea-erase-reason"
          />
        </div>
        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={handleClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={isPending}
            onClick={onConfirm}
            data-testid="button-confirm-erase"
          >
            {isPending ? "Erasing..." : "Erase Personal Data"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
