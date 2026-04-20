import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { insertEstimateSchema } from "@shared/schema";
import type { EstimateSummary } from "@shared/schema";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";

const editEstimateFormSchema = insertEstimateSchema.pick({
  title: true,
  description: true,
  amount: true,
  status: true,
});

export type EditEstimateFormValues = z.infer<typeof editEstimateFormSchema>;

type EditEstimateModalProps = {
  isOpen: boolean;
  estimate: EstimateSummary | undefined;
  onClose: () => void;
  onSave: (values: EditEstimateFormValues) => void;
  isSaving: boolean;
};

export function EditEstimateModal({
  isOpen,
  estimate,
  onClose,
  onSave,
  isSaving,
}: EditEstimateModalProps) {
  const form = useForm<EditEstimateFormValues>({
    resolver: zodResolver(editEstimateFormSchema),
    defaultValues: {
      title: "",
      description: "",
      amount: "0",
      status: "scheduled",
    },
  });

  useEffect(() => {
    if (estimate) {
      const safeStatus = (["sent", "scheduled", "in_progress", "approved", "rejected"] as const).includes(
        estimate.status as "sent" | "scheduled" | "in_progress" | "approved" | "rejected"
      )
        ? (estimate.status as "sent" | "scheduled" | "in_progress" | "approved" | "rejected")
        : "scheduled";

      form.reset({
        title: estimate.title || "",
        description: estimate.description || "",
        amount: estimate.amount?.toString() || "0",
        status: safeStatus,
      });
    }
  }, [estimate, form]);

  const handleClose = () => {
    form.reset();
    onClose();
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && handleClose()}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto mx-4">
        <DialogHeader>
          <DialogTitle>Edit Estimate - {estimate?.title}</DialogTitle>
          <DialogDescription>
            Update the estimate details including title, amount, status, and notes.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSave)} className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <FormField
                control={form.control}
                name="title"
                render={({ field }) => (
                  <FormItem className="md:col-span-2">
                    <FormLabel>Title</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="Enter estimate title"
                        {...field}
                        data-testid="input-edit-estimate-title"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="amount"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Amount</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        step="0.01"
                        placeholder="0.00"
                        {...field}
                        data-testid="input-edit-estimate-amount"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="status"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Status</FormLabel>
                    <FormControl>
                      <select
                        {...field}
                        className="w-full px-3 py-2 border border-input rounded-md"
                        data-testid="select-edit-estimate-status"
                      >
                        <option value="scheduled">Scheduled</option>
                        <option value="in_progress">In Progress</option>
                        <option value="sent">Sent</option>
                        <option value="approved">Approved</option>
                        <option value="rejected">Rejected</option>
                      </select>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Description</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="Enter estimate description..."
                      className="resize-none"
                      rows={4}
                      {...field}
                      value={field.value || ""}
                      data-testid="textarea-edit-estimate-description"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="flex justify-end gap-2 pt-4">
              <Button
                type="button"
                variant="outline"
                onClick={handleClose}
                data-testid="button-cancel-edit-estimate"
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={isSaving}
                data-testid="button-save-edit-estimate"
              >
                {isSaving ? "Saving..." : "Save Changes"}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
