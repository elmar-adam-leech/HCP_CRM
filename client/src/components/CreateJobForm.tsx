import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { DatePicker } from "@/components/ui/date-picker";
import { ContactCombobox } from "@/components/ui/contact-combobox";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { invalidateJobs, invalidateContacts, invalidateEstimates } from "@/hooks/useInvalidations";
import { Check, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";

const createJobSchema = z.object({
  contactId: z.string().min(1, "Please select a contact"),
  title: z.string().min(1, "Title is required"),
  type: z.string().min(1, "Type is required"),
  value: z.number().min(0, "Value must be positive"),
  status: z.enum(["scheduled", "in_progress", "completed", "cancelled"]).default("scheduled"),
  priority: z.enum(["low", "medium", "high"]).default("medium"),
  estimatedHours: z.number().optional(),
  scheduledDate: z.date().optional(),
  estimateId: z.string().optional(),
});

type CreateJobFormData = z.infer<typeof createJobSchema>;

interface CreateJobFormProps {
  onSuccess: () => void;
  onCancel: () => void;
}

export function CreateJobForm({ onSuccess, onCancel }: CreateJobFormProps) {
  const { toast } = useToast();
  const [estimateSearchQuery, setEstimateSearchQuery] = useState("");
  const [estimatePopoverOpen, setEstimatePopoverOpen] = useState(false);

  const { data: estimateSearchResults = [], isLoading: estimatesSearchLoading } = useQuery<Array<{
    id: string;
    title: string;
    amount: number;
    contactName: string;
  }>>({
    queryKey: ['/api/estimates/paginated', { search: estimateSearchQuery, limit: 10 }],
    queryFn: async () => {
      const response = await apiRequest(
        'GET',
        `/api/estimates/paginated?search=${encodeURIComponent(estimateSearchQuery)}&limit=10`
      );
      const result = await response.json();
      return result.data ?? [];
    },
    enabled: estimatePopoverOpen && estimateSearchQuery.length >= 2,
    staleTime: 10_000,
  });

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors },
  } = useForm<CreateJobFormData>({
    resolver: zodResolver(createJobSchema),
    defaultValues: {
      status: "scheduled",
      priority: "medium",
    },
  });

  const selectedStatus = watch("status");
  const selectedPriority = watch("priority");
  const selectedEstimateId = watch("estimateId");

  const createJobMutation = useMutation({
    mutationFn: async (data: CreateJobFormData) => {
      const response = await apiRequest('POST', '/api/jobs', {
        title: data.title,
        type: data.type,
        value: data.value,
        contactId: data.contactId,
        status: data.status,
        priority: data.priority,
        estimatedHours: data.estimatedHours,
        scheduledDate: data.scheduledDate?.toISOString(),
        estimateId: data.estimateId || null,
      });
      return response.json();
    },
    onSuccess: () => {
      toast({ title: "Job created", description: "Job has been created successfully" });
      invalidateJobs();
      invalidateContacts();
      invalidateEstimates();
      onSuccess();
    },
    onError: (error: unknown) => {
      toast({
        variant: "destructive",
        title: "Failed to create job",
        description: error instanceof Error ? error.message : "Please try again",
      });
    },
  });

  const onSubmit = (data: CreateJobFormData) => {
    createJobMutation.mutate(data);
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="contact">Contact (Customer) *</Label>
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
          placeholder="HVAC Repair Service"
          data-testid="input-title"
        />
        {errors.title && <p className="text-sm text-destructive">{errors.title.message}</p>}
      </div>

      <div className="space-y-2">
        <Label htmlFor="type">Job Type *</Label>
        <Input
          id="type"
          {...register("type")}
          placeholder="Installation, Repair, Maintenance, etc."
          data-testid="input-type"
        />
        {errors.type && <p className="text-sm text-destructive">{errors.type.message}</p>}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="value">Job Value *</Label>
          <Input
            id="value"
            type="number"
            step="0.01"
            min="0"
            {...register("value", { valueAsNumber: true })}
            placeholder="500.00"
            data-testid="input-value"
          />
          {errors.value && <p className="text-sm text-destructive">{errors.value.message}</p>}
        </div>

        <div className="space-y-2">
          <Label htmlFor="estimatedHours">Estimated Hours</Label>
          <Input
            id="estimatedHours"
            type="number"
            step="0.5"
            min="0"
            {...register("estimatedHours", { valueAsNumber: true })}
            placeholder="4"
            data-testid="input-estimated-hours"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="status">Status</Label>
          <Select value={selectedStatus} onValueChange={(value: string) => setValue("status", value as any)}>
            <SelectTrigger id="status" data-testid="select-status">
              <SelectValue placeholder="Select status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="scheduled">Scheduled</SelectItem>
              <SelectItem value="in_progress">In Progress</SelectItem>
              <SelectItem value="completed">Completed</SelectItem>
              <SelectItem value="cancelled">Cancelled</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label htmlFor="priority">Priority</Label>
          <Select value={selectedPriority} onValueChange={(value: string) => setValue("priority", value as any)}>
            <SelectTrigger id="priority" data-testid="select-priority">
              <SelectValue placeholder="Select priority" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="low">Low</SelectItem>
              <SelectItem value="medium">Medium</SelectItem>
              <SelectItem value="high">High</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-2">
        <Label>Scheduled Date (Optional)</Label>
        <DatePicker
          value={watch("scheduledDate")}
          onChange={(date) => setValue("scheduledDate", date)}
          data-testid="button-scheduled-date"
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="estimate">Link to Estimate (Optional)</Label>
        <Popover open={estimatePopoverOpen} onOpenChange={setEstimatePopoverOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              role="combobox"
              aria-expanded={estimatePopoverOpen}
              className="w-full justify-between"
              data-testid="button-select-estimate"
              type="button"
            >
              {selectedEstimateId
                ? (estimateSearchResults.find(e => e.id === selectedEstimateId)?.title ?? "Estimate linked")
                : "Search for an estimate..."}
              <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-full p-0" align="start">
            <Command shouldFilter={false}>
              <CommandInput
                placeholder="Type to search estimates..."
                value={estimateSearchQuery}
                onValueChange={setEstimateSearchQuery}
              />
              <CommandList>
                {selectedEstimateId && (
                  <CommandItem onSelect={() => { setValue("estimateId", undefined); setEstimatePopoverOpen(false); }}>
                    Clear selection
                  </CommandItem>
                )}
                {estimateSearchQuery.length < 2 ? (
                  <CommandEmpty>Type at least 2 characters to search</CommandEmpty>
                ) : estimatesSearchLoading ? (
                  <CommandEmpty>Searching...</CommandEmpty>
                ) : estimateSearchResults.length === 0 ? (
                  <CommandEmpty>No estimates found</CommandEmpty>
                ) : (
                  <CommandGroup>
                    {estimateSearchResults.map((est) => (
                      <CommandItem
                        key={est.id}
                        value={est.id}
                        onSelect={() => { setValue("estimateId", est.id); setEstimatePopoverOpen(false); }}
                      >
                        <Check className={cn("mr-2 h-4 w-4", selectedEstimateId === est.id ? "opacity-100" : "opacity-0")} />
                        {est.title} — ${Number(est.amount).toLocaleString()}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )}
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </div>

      <div className="flex justify-end gap-2 pt-4">
        <Button type="button" variant="outline" onClick={onCancel} data-testid="button-cancel">
          Cancel
        </Button>
        <Button type="submit" disabled={createJobMutation.isPending} data-testid="button-create-job">
          {createJobMutation.isPending ? "Creating..." : "Create Job"}
        </Button>
      </div>
    </form>
  );
}
