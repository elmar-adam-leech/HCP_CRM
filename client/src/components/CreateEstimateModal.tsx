import { Plus } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { CreateEstimateForm } from "@/components/CreateEstimateForm";

interface CreateEstimateModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function CreateEstimateModal({ isOpen, onClose }: CreateEstimateModalProps) {
  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[600px] max-h-[90vh] overflow-y-auto" data-testid="modal-add-estimate">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Plus className="h-5 w-5" />
            Create New Estimate
          </DialogTitle>
          <DialogDescription>Create a new estimate for a lead or customer.</DialogDescription>
        </DialogHeader>
        <CreateEstimateForm onSuccess={onClose} onCancel={onClose} />
      </DialogContent>
    </Dialog>
  );
}
