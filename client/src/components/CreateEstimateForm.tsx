import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DatePicker } from "@/components/ui/date-picker";
import { ContactCombobox } from "@/components/ui/contact-combobox";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { invalidateEstimates } from "@/hooks/useInvalidations";

const createEstimateSchema = z.object({
  contactId: z.string().min(1, "Please select a contact"),
  title: z.string().min(1, "Title is required"),
  description: z.string().optional(),
  amount: z.number().min(0).optional(),
  validUntil: z.date().optional(),
  followUpDate: z.date().optional(),
  status: z.enum(["sent", "scheduled", "in_progress", "approved", "rejected"]).default("scheduled"),
});

type CreateEstimateFormData = z.infer<typeof createEstimateSchema>;

interface CreateEstimateFormProps {
  onSuccess: () => void;
  onCancel: () => void;
}

export function CreateEstimateForm({ onSuccess, onCancel }: CreateEstimateFormProps) {
  const { toast } = useToast();

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors },
  } = useForm<CreateEstimateFormData>({
    resolver: zodResolver(createEstimateSchema),
    defaultValues: { status: "scheduled" },
  });

  const createEstimateMutation = useMutation({
    mutationFn: async (data: CreateEstimateFormData) => {
      const response = await apiRequest('POST', '/api/estimates', {
        title: data.title,
        description: data.description || '',
        amount: data.amount,
        contactId: data.contactId,
        status: data.status,
        validUntil: data.validUntil?.toISOString(),
        followUpDate: data.followUpDate?.toISOString(),
      });
      return response.json();
    },
    onSuccess: () => {
      toast({ title: "Estimate created", description: "Estimate has been created successfully" });
      invalidateEstimates();
      onSuccess();
    },
    onError: (error: any) => {
      toast({
        variant: "destructive",
        title: "Failed to create estimate",
        description: error.message || "Please try again",
      });
    },
  });

  return (
    <form onSubmit={handleSubmit((data) => createEstimateMutation.mutate(data))} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="contact">Contact *</Label>
        <ContactCombobox
          value={watch("contactId") ?? ""}
          onChange={(id) => setValue("contactId", id)}
          error={errors.contactId?.message}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="title">Title *</Label>
        <Input
          id="title"
          {...register("title")}
          placeholder="HVAC Installation Quote"
          data-testid="input-title"
        />
        {errors.title && <p className="text-sm text-destructive">{errors.title.message}</p>}
      </div>

      <div className="space-y-2">
        <Label htmlFor="description">Description</Label>
        <Textarea
          id="description"
          {...register("description")}
          placeholder="Detailed description of the work to be performed"
          rows={3}
          data-testid="input-description"
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="amount">Amount (Optional)</Label>
        <Input
          id="amount"
          type="number"
          step="0.01"
          min="0"
          {...register("amount", { valueAsNumber: true })}
          placeholder="5000.00"
          data-testid="input-amount"
        />
        {errors.amount && <p className="text-sm text-destructive">{errors.amount.message}</p>}
      </div>

      <div className="space-y-2">
        <Label htmlFor="status">Status</Label>
        <Select value={watch("status")} onValueChange={(value: any) => setValue("status", value)}>
          <SelectTrigger id="status" data-testid="select-status">
            <SelectValue placeholder="Select status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="scheduled">Scheduled</SelectItem>
            <SelectItem value="in_progress">In Progress</SelectItem>
            <SelectItem value="sent">Sent</SelectItem>
            <SelectItem value="approved">Approved</SelectItem>
            <SelectItem value="rejected">Rejected</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label>Valid Until (Optional)</Label>
        <DatePicker
          value={watch("validUntil")}
          onChange={(date) => setValue("validUntil", date)}
          disabled={(date) => date < new Date()}
          data-testid="button-valid-until"
        />
      </div>

      <div className="space-y-2">
        <Label>Follow-Up Date (Optional)</Label>
        <DatePicker
          value={watch("followUpDate")}
          onChange={(date) => setValue("followUpDate", date)}
          disabled={(date) => date < new Date()}
          data-testid="button-follow-up"
        />
      </div>

      <div className="flex justify-end gap-2 pt-4">
        <Button type="button" variant="outline" onClick={onCancel} data-testid="button-cancel">
          Cancel
        </Button>
        <Button type="submit" disabled={createEstimateMutation.isPending} data-testid="button-create-estimate">
          {createEstimateMutation.isPending ? "Creating..." : "Create Estimate"}
        </Button>
      </div>
    </form>
  );
}
