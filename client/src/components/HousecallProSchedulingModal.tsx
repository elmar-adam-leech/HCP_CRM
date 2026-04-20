import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Calendar as CalendarIcon, Clock, User, AlertCircle, CheckCircle2 } from "lucide-react";
import { format } from "date-fns";
import { z } from "zod";
import { cn } from "@/lib/utils";

// Use the database Lead type from schema instead of defining our own
interface ModalLead {
  id: string;
  name: string;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  value?: string | null;
  isScheduled?: boolean;
  housecallProEstimateId?: string | null;
}

interface Employee {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  role: string;
  is_active: boolean;
}

interface AvailabilitySlot {
  start_time: string;
  end_time: string;
  duration_minutes: number;
}

interface EstimatorAvailability {
  employee_id: string;
  employee_name: string;
  available_slots: AvailabilitySlot[];
}

interface HousecallProStatus {
  configured: boolean;
  connected: boolean;
  error?: string;
}

interface SchedulingModalProps {
  lead: ModalLead | null;
  isOpen: boolean;
  onClose: () => void;
  onScheduled?: (lead: ModalLead) => void;
}

const scheduleFormSchema = z.object({
  employeeId: z.string().min(1, "Please select an estimator"),
  date: z.date({ required_error: "Please select a date" }),
  timeSlot: z.string().min(1, "Please select an available time slot"),
  description: z.string().optional(),
});

type ScheduleFormValues = z.infer<typeof scheduleFormSchema>;

export function HousecallProSchedulingModal({ lead, isOpen, onClose, onScheduled }: SchedulingModalProps) {
  const { toast } = useToast();
  const [step, setStep] = useState<'check' | 'configure' | 'schedule'>('check');

  const form = useForm<ScheduleFormValues>({
    resolver: zodResolver(scheduleFormSchema),
    defaultValues: {
      description: "",
    },
  });

  // Check Housecall Pro status
  const { data: housecallProStatus, isLoading: statusLoading, error: statusError } = useQuery<HousecallProStatus>({
    queryKey: ['/api/housecall-pro/status'],
    enabled: isOpen,
  });

  // Get employees when ready to schedule - filter to estimators only
  const { data: allEmployees, isLoading: employeesLoading } = useQuery<Employee[]>({
    queryKey: ['/api/housecall-pro/employees'],
    enabled: isOpen && housecallProStatus?.configured && housecallProStatus?.connected,
  });

  // Filter employees to only show estimators
  const estimators = allEmployees?.filter(emp => 
    emp.is_active && (emp.role.toLowerCase().includes('estimator') || emp.role.toLowerCase().includes('sales'))
  ) || [];

  // Get availability when date is selected
  const selectedDate = form.watch('date');
  const selectedEmployeeId = form.watch('employeeId');
  
  const { data: availability, isLoading: availabilityLoading, error: availabilityError } = useQuery<EstimatorAvailability[]>({
    queryKey: ['/api/housecall-pro/availability', { 
      date: selectedDate ? format(selectedDate, 'yyyy-MM-dd') : undefined,
      estimatorIds: selectedEmployeeId || undefined 
    }],
    enabled: isOpen && selectedDate && housecallProStatus?.configured && housecallProStatus?.connected,
  });

  // Get available slots for the selected estimator
  const selectedEstimatorAvailability = availability?.find(avail => avail.employee_id === selectedEmployeeId);
  const availableSlots = selectedEstimatorAvailability?.available_slots || [];

  // Reset time slot when date or employee changes
  useEffect(() => {
    form.setValue('timeSlot', '');
  }, [selectedDate, selectedEmployeeId, form]);

  // Schedule lead mutation
  const scheduleMutation = useMutation({
    mutationFn: async (data: ScheduleFormValues) => {
      if (!lead) throw new Error('No lead selected');
      
      // Parse the selected time slot (format: "HH:MM-HH:MM")
      const parts = data.timeSlot.split('-');
      const startTime = parts[0];
      const endTime = parts[1];
      if (!startTime || !endTime) throw new Error('Invalid time slot format');

      const scheduledStart = new Date(data.date);
      const startParts = startTime.split(':');
      const startHour = startParts[0];
      const startMinute = startParts[1];
      if (!startHour || !startMinute) throw new Error('Invalid start time format');
      scheduledStart.setHours(parseInt(startHour), parseInt(startMinute));
      
      const scheduledEnd = new Date(data.date);
      const endParts = endTime.split(':');
      const endHour = endParts[0];
      const endMinute = endParts[1];
      if (!endHour || !endMinute) throw new Error('Invalid end time format');
      scheduledEnd.setHours(parseInt(endHour), parseInt(endMinute));

      const response = await apiRequest('POST', `/api/leads/${lead.id}/schedule`, {
        employeeId: data.employeeId,
        scheduledStart: scheduledStart.toISOString(),
        scheduledEnd: scheduledEnd.toISOString(),
        description: data.description,
      });
      return response.json();
    },
    onSuccess: (data) => {
      toast({
        title: "Lead Scheduled Successfully",
        description: `${lead?.name} has been scheduled in Housecall Pro.`,
      });
      
      // Invalidate the contacts/paginated cache — the Leads page uses this key,
      // not /api/leads. The old /api/leads keys had no effect on that list.
      queryClient.invalidateQueries({ queryKey: ['/api/contacts/paginated'] });
      queryClient.invalidateQueries({ queryKey: ['/api/contacts/status-counts'] });
      queryClient.invalidateQueries({ queryKey: ['/api/estimates'] }); // For Follow-ups page
      
      onScheduled?.(data.lead);
      handleClose();
    },
    onError: (error: any) => {
      toast({
        title: "Scheduling Failed",
        description: error.message || "Failed to schedule lead in Housecall Pro",
        variant: "destructive",
      });
    },
  });

  // Determine the current step based on status
  useEffect(() => {
    if (!isOpen) return;
    
    if (statusLoading) {
      setStep('check');
    } else if (statusError || !housecallProStatus?.configured || !housecallProStatus?.connected) {
      setStep('configure');
    } else {
      setStep('schedule');
    }
  }, [isOpen, statusLoading, statusError, housecallProStatus]);

  const handleClose = () => {
    form.reset();
    setStep('check');
    onClose();
  };

  const onSubmit = (data: ScheduleFormValues) => {
    scheduleMutation.mutate(data);
  };

  const renderCheckStep = () => (
    <div className="space-y-4">
      <div className="text-center">
        <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-muted flex items-center justify-center">
          {statusLoading ? (
            <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          ) : (
            <CheckCircle2 className="w-8 h-8 text-muted-foreground" />
          )}
        </div>
        <h3 className="text-lg font-medium mb-2">Checking Housecall Pro Integration</h3>
        <p className="text-sm text-muted-foreground">
          Please wait while we verify your Housecall Pro connection...
        </p>
      </div>
    </div>
  );

  const renderConfigureStep = () => (
    <div className="space-y-4">
      <Alert>
        <AlertCircle className="h-4 w-4" />
        <AlertDescription>
          {!housecallProStatus?.configured 
            ? "Housecall Pro is not configured for your account."
            : "Unable to connect to Housecall Pro. Please check your API key."
          }
        </AlertDescription>
      </Alert>
      
      <div className="text-center">
        <h3 className="text-lg font-medium mb-2">Housecall Pro Setup Required</h3>
        <p className="text-sm text-muted-foreground mb-4">
          To schedule leads directly in Housecall Pro, you need to configure your API credentials.
        </p>
        
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Setup Instructions</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="text-left space-y-2">
              <p><strong>1.</strong> Log in to your Housecall Pro account</p>
              <p><strong>2.</strong> Go to App Store → API Key Management</p>
              <p><strong>3.</strong> Generate a new API key</p>
              <p><strong>4.</strong> Contact your admin to add the API key to this CRM</p>
            </div>
            
            {housecallProStatus?.error && (
              <Alert className="mt-4">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>
                  <strong>Error:</strong> {housecallProStatus.error}
                </AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );

  const renderScheduleStep = () => (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
        {/* Lead Information Summary */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <User className="w-4 h-4" />
              Lead Information
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Name:</span>
              <span className="font-medium">{lead?.name}</span>
            </div>
            {lead?.email && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Email:</span>
                <span>{lead.email}</span>
              </div>
            )}
            {lead?.phone && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Phone:</span>
                <span>{lead.phone}</span>
              </div>
            )}
            {lead?.address && (
              <div className="flex justify-between items-start">
                <span className="text-muted-foreground">Address:</span>
                <span className="text-right max-w-[200px]">{lead.address}</span>
              </div>
            )}
            {lead?.value && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Est. Value:</span>
                <span className="font-medium">${parseFloat(lead.value).toLocaleString()}</span>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Employee Selection */}
        <FormField
          control={form.control}
          name="employeeId"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Assign to Estimator</FormLabel>
              <Select onValueChange={field.onChange} defaultValue={field.value}>
                <FormControl>
                  <SelectTrigger data-testid="select-estimator">
                    <SelectValue placeholder="Select an estimator" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {employeesLoading ? (
                    <div className="p-2">
                      <Skeleton className="h-4 w-full" />
                    </div>
                  ) : estimators.map((employee) => (
                    <SelectItem key={employee.id} value={employee.id}>
                      <div className="flex items-center gap-2">
                        <span>{employee.first_name} {employee.last_name}</span>
                        <Badge variant="outline" className="text-xs">
                          {employee.role}
                        </Badge>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />

        {/* Date Selection */}
        <FormField
          control={form.control}
          name="date"
          render={({ field }) => (
            <FormItem className="flex flex-col">
              <FormLabel>Date</FormLabel>
              <Popover>
                <PopoverTrigger asChild>
                  <FormControl>
                    <Button
                      variant="outline"
                      className={cn(
                        "w-full pl-3 text-left font-normal",
                        !field.value && "text-muted-foreground"
                      )}
                      data-testid="button-date-picker"
                    >
                      {field.value ? (
                        format(field.value, "PPP")
                      ) : (
                        <span>Pick a date</span>
                      )}
                      <CalendarIcon className="ml-auto h-4 w-4 opacity-50" />
                    </Button>
                  </FormControl>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    selected={field.value}
                    onSelect={field.onChange}
                    disabled={(date) => date < new Date()}
                    initialFocus
                  />
                </PopoverContent>
              </Popover>
              <FormMessage />
            </FormItem>
          )}
        />

        {/* Available Time Slots */}
        <FormField
          control={form.control}
          name="timeSlot"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Available Time Slots</FormLabel>
              {!selectedDate && (
                <p className="text-sm text-muted-foreground">Please select a date first</p>
              )}
              {selectedDate && !selectedEmployeeId && (
                <p className="text-sm text-muted-foreground">Please select an estimator first</p>
              )}
              {selectedDate && selectedEmployeeId && availabilityLoading && (
                <div className="space-y-2">
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-10 w-full" />
                </div>
              )}
              {selectedDate && selectedEmployeeId && !availabilityLoading && (
                <div className="space-y-2">
                  {availabilityError ? (
                    <Alert variant="destructive">
                      <AlertCircle className="h-4 w-4" />
                      <AlertDescription>
                        Failed to load availability. Please try again or contact support.
                      </AlertDescription>
                    </Alert>
                  ) : availableSlots.length === 0 ? (
                    <Alert>
                      <AlertCircle className="h-4 w-4" />
                      <AlertDescription>
                        No available time slots for the selected date. Please choose a different date or estimator.
                      </AlertDescription>
                    </Alert>
                  ) : (
                    <div className="grid gap-2">
                      {availableSlots.map((slot, index) => {
                        const slotValue = `${slot.start_time}-${slot.end_time}`;
                        const isSelected = field.value === slotValue;
                        return (
                          <Button
                            key={index}
                            type="button"
                            variant={isSelected ? "default" : "outline"}
                            className="justify-between h-auto p-3"
                            onClick={() => field.onChange(slotValue)}
                            data-testid={`button-time-slot-${index}`}
                          >
                            <div className="flex items-center gap-2">
                              <Clock className="w-4 h-4" />
                              <span>
                                {slot.start_time} - {slot.end_time}
                              </span>
                            </div>
                            <Badge variant="secondary" className="ml-2">
                              {Math.floor(slot.duration_minutes / 60)}h {slot.duration_minutes % 60}m
                            </Badge>
                          </Button>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
              <FormMessage />
            </FormItem>
          )}
        />

        {/* Description */}
        <FormField
          control={form.control}
          name="description"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Description (Optional)</FormLabel>
              <FormControl>
                <Textarea
                  placeholder="Add any additional notes for the estimate..."
                  className="min-h-[80px]"
                  {...field}
                  data-testid="textarea-description"
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={handleClose}
            data-testid="button-cancel-schedule"
          >
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={scheduleMutation.isPending}
            data-testid="button-confirm-schedule"
          >
            {scheduleMutation.isPending ? (
              <>
                <div className="w-4 h-4 mr-2 border-2 border-white border-t-transparent rounded-full animate-spin" />
                Scheduling...
              </>
            ) : (
              <>
                <Calendar className="w-4 h-4 mr-2" />
                Schedule in Housecall Pro
              </>
            )}
          </Button>
        </DialogFooter>
      </form>
    </Form>
  );

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-[500px]" data-testid="dialog-schedule-lead">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CalendarIcon className="w-5 h-5" />
            Schedule Lead in Housecall Pro
          </DialogTitle>
        </DialogHeader>
        
        <div className="py-4">
          {step === 'check' && renderCheckStep()}
          {step === 'configure' && renderConfigureStep()}
          {step === 'schedule' && renderScheduleStep()}
        </div>
        
        {step === 'configure' && (
          <DialogFooter>
            <Button variant="outline" onClick={handleClose} data-testid="button-close-setup">
              Close
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}