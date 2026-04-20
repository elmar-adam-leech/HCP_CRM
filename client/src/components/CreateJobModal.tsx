import { Plus } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { CreateJobForm } from "@/components/CreateJobForm";

type CreateJobModalProps = {
  isOpen: boolean;
  onClose: () => void;
};

export function CreateJobModal({ isOpen, onClose }: CreateJobModalProps) {
  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[600px]" data-testid="modal-add-job">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Plus className="h-5 w-5" />
            Create New Job
          </DialogTitle>
          <DialogDescription>Create a new job for a customer.</DialogDescription>
        </DialogHeader>

        <CreateJobForm onSuccess={onClose} onCancel={onClose} />
      </DialogContent>
    </Dialog>
  );
}
