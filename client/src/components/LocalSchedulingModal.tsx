import { useState, useEffect, useRef } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { format } from "date-fns";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Calendar } from "@/components/ui/calendar";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Calendar as CalendarIcon, Clock, User, MapPin, Phone, Mail, Loader2 } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { formatDateScheduling } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { AddressAutocomplete, AddressComponents, AddressAutocompleteRef } from "@/components/ui/AddressAutocomplete";
import { DaySchedulePanel } from "@/components/DaySchedulePanel";
import type { SchedulingLead } from "@/hooks/useCommunicationActions";

interface Salesperson {
  userId: string;
  name: string;
  email: string;
  housecallProUserId: string | null;
  lastAssignmentAt: string | null;
  calendarColor: string | null;
  isSalesperson: boolean;
  workingDays: number[];
  workingHoursStart: string;
  workingHoursEnd: string;
  hasCustomSchedule: boolean;
}

interface AvailabilitySlot {
  start: string;
  end: string;
  conflict: boolean;
}

interface AvailabilityResponse {
  date: string;
  slotDurationMinutes: number;
  bufferMinutes: number;
  slots: AvailabilitySlot[];
}


interface LocalSchedulingModalProps {
  lead: SchedulingLead | null;
  isOpen: boolean;
  onClose: () => void;
  onScheduled?: (lead: SchedulingLead) => void;
}

const scheduleFormSchema = z.object({
  salespersonId: z.string().min(1, "Please select a salesperson"),
  date: z.date({ required_error: "Please select a date" }),
  timeSlot: z.string().min(1, "Please select a time slot"),
  address: z
    .string()
    .min(1, "Service address is required")
    .refine(
      (s) => /^\s*\d+\s+\S+/.test(s.trim()) || s.split(',').map(p => p.trim()).filter(Boolean).length >= 3,
      "Please enter a full street address (number + street)"
    ),
  notes: z.string().optional(),
});

type ScheduleFormValues = z.infer<typeof scheduleFormSchema>;

export function LocalSchedulingModal({ lead, isOpen, onClose, onScheduled }: LocalSchedulingModalProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [selectedSalesperson, setSelectedSalesperson] = useState<Salesperson | null>(null);
  const [addressComponents, setAddressComponents] = useState<AddressComponents | null>(null);
  const addressAutocompleteRef = useRef<AddressAutocompleteRef>(null);

  const { data: allTeamMembers = [], isLoading: salespeopleLoading } = useQuery<Salesperson[]>({
    queryKey: ['/api/scheduling/salespeople'],
    enabled: isOpen,
  });

  const salespeople = allTeamMembers.filter(member => member.isSalesperson);

  const form = useForm<ScheduleFormValues>({
    resolver: zodResolver(scheduleFormSchema),
    defaultValues: {
      notes: "",
    },
  });

  const selectedDate = form.watch('date');
  const selectedSalespersonId = form.watch('salespersonId');

  useEffect(() => {
    const salesperson = salespeople.find(s => s.userId === selectedSalespersonId);
    setSelectedSalesperson(salesperson || null);
  }, [selectedSalespersonId, salespeople]);

  useEffect(() => {
    form.setValue('timeSlot', '');
  }, [selectedDate, selectedSalespersonId, form]);

  const formattedDate = selectedDate ? format(selectedDate, 'yyyy-MM-dd') : '';

  // Task #859: internal flexible scheduling. Fetch EVERY candidate time across
  // the selected salesperson's working window (not just free gaps), each flagged
  // with `conflict` so we can show an inline "Booked" badge while keeping the
  // time selectable. Requires both a date and a salesperson.
  const { data: availabilityData, isLoading: slotsLoading } = useQuery<AvailabilityResponse>({
    queryKey: ['/api/scheduling/day-slots', formattedDate, selectedSalespersonId],
    queryFn: async () => {
      if (!formattedDate || !selectedSalespersonId) throw new Error('Missing date or salesperson');
      const params = new URLSearchParams({
        date: formattedDate,
        salespersonId: selectedSalespersonId,
      });
      const resp = await apiRequest('GET', `/api/scheduling/day-slots?${params.toString()}`);
      return resp.json();
    },
    enabled: isOpen && !!formattedDate && !!selectedSalespersonId,
    staleTime: 30000,
  });

  const availableSlots = (() => {
    if (!availabilityData?.slots) return [];
    return availabilityData.slots
      .map(slot => {
        const startDate = new Date(slot.start);
        const endDate = new Date(slot.end);
        const startHr = startDate.getHours().toString().padStart(2, '0');
        const startMin = startDate.getMinutes().toString().padStart(2, '0');
        const endHr = endDate.getHours().toString().padStart(2, '0');
        const endMin = endDate.getMinutes().toString().padStart(2, '0');
        const timeValue = `${startHr}:${startMin}`;
        return {
          value: timeValue,
          label: `${startHr}:${startMin} - ${endHr}:${endMin}`,
          isoStart: slot.start,
          conflict: slot.conflict,
        };
      });
  })();

  const scheduleMutation = useMutation({
    mutationFn: async (
      data: ScheduleFormValues & {
        resolvedAddress?: string;
        resolvedComponents?: AddressComponents | null;
      },
    ) => {
      const salesperson = salespeople.find(s => s.userId === data.salespersonId);

      const scheduledDate = format(data.date, 'yyyy-MM-dd');
      const [hour, minute = 0] = data.timeSlot.split(':').map(Number);
      const startDateTime = new Date(data.date);
      startDateTime.setHours(hour, minute, 0, 0);

      const submittedAddress = data.resolvedAddress ?? data.address;
      const submittedComponents = data.resolvedComponents ?? addressComponents;

      const bookingPayload: Record<string, any> = {
        startTime: startDateTime.toISOString(),
        title: `Estimate Appointment - ${lead?.name || 'Lead'}`,
        customerName: lead?.name || 'Unknown',
        customerEmail: lead?.email,
        customerPhone: lead?.phone,
        customerAddress: submittedAddress,
        notes: data.notes,
        contactId: lead?.id,
        salespersonId: data.salespersonId,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      };

      if (submittedComponents) {
        bookingPayload.customerAddressComponents = submittedComponents;
      }

      if (salesperson?.housecallProUserId) {
        bookingPayload.housecallProEmployeeId = salesperson.housecallProUserId;
      }

      const bookingResponse = await apiRequest('POST', '/api/scheduling/book', bookingPayload);
      const bookingResult: { scheduleError?: string } = await bookingResponse.json();

      await apiRequest('PATCH', `/api/contacts/${lead?.id}`, {
        status: 'scheduled',
        scheduledDate: `${format(data.date, 'MMM dd, yyyy')} at ${data.timeSlot}`,
        ...(submittedAddress ? { address: submittedAddress } : {}),
      });

      return {
        salespersonName: salesperson?.name,
        scheduledDate,
        scheduledTime: data.timeSlot,
        scheduleError: bookingResult.scheduleError,
      };
    },
    onSuccess: (result: { scheduleError?: string; salespersonName?: string; [key: string]: unknown }) => {
      queryClient.invalidateQueries({ queryKey: ['/api/contacts'] });
      queryClient.invalidateQueries({ queryKey: ['/api/contacts/paginated'] });
      queryClient.invalidateQueries({ queryKey: ['/api/contacts/status-counts'] });
      queryClient.invalidateQueries({ queryKey: ['/api/appointments'] });

      if (result.scheduleError) {
        toast({
          title: "Appointment Booked — HCP Scheduling Incomplete",
          description: result.scheduleError,
          variant: "destructive",
        });
      } else {
        toast({
          title: "Appointment Scheduled",
          description: `Estimate appointment scheduled with ${selectedSalesperson?.name}`,
        });
      }

      onClose();
      if (lead && onScheduled) {
        onScheduled(lead);
      }
    },
    onError: (error: any) => {
      toast({
        title: "Scheduling Failed",
        description: error.message || "Failed to schedule appointment. Please try again.",
        variant: "destructive",
      });
    },
  });

  const onSubmit = async (data: ScheduleFormValues) => {
    let resolvedAddress: string | undefined;
    let resolvedComponents: AddressComponents | null | undefined;
    try {
      const result = await addressAutocompleteRef.current?.resolvePending();
      if (result) {
        resolvedAddress = result.formatted;
        resolvedComponents = result.components;
      }
    } catch {
      // Best-effort — never block submit on resolver failures.
    }
    scheduleMutation.mutate({ ...data, resolvedAddress, resolvedComponents });
  };

  useEffect(() => {
    if (isOpen) {
      const structuredAddress = lead?.street
        ? [lead.street, lead.city, lead.state, lead.zip].filter(Boolean).join(', ')
        : '';
      form.reset({
        address: lead?.address || structuredAddress || "",
        notes: `Estimate appointment for ${lead?.name}`,
      });
      if (lead?.street) {
        setAddressComponents({
          street: lead.street,
          city: lead.city || '',
          state: lead.state || '',
          zip: lead.zip || '',
          country: 'US',
        });
      } else {
        setAddressComponents(null);
      }
    }
  }, [isOpen, lead, form]);

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto mx-4">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CalendarIcon className="h-5 w-5" />
            Schedule Estimate Appointment
          </DialogTitle>
          <DialogDescription>
            Schedule an estimate appointment for {lead?.name} with one of your sales team members.
          </DialogDescription>
        </DialogHeader>

        {lead && (
          <Card className="mb-4">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Lead Information</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-2 text-sm">
              <div className="flex items-center gap-2">
                <User className="h-4 w-4 text-muted-foreground" />
                <span className="font-medium">{lead.name}</span>
              </div>
              {lead.email && (
                <div className="flex items-center gap-2">
                  <Mail className="h-4 w-4 text-muted-foreground" />
                  <span>{lead.email}</span>
                </div>
              )}
              {lead.phone && (
                <div className="flex items-center gap-2">
                  <Phone className="h-4 w-4 text-muted-foreground" />
                  <span>{lead.phone}</span>
                </div>
              )}
              {lead.address && (
                <div className="flex items-center gap-2">
                  <MapPin className="h-4 w-4 text-muted-foreground" />
                  <span>{lead.address}</span>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
            <FormField
              control={form.control}
              name="address"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="flex items-center gap-2">
                    <MapPin className="h-4 w-4 text-muted-foreground" />
                    Service Address
                  </FormLabel>
                  <FormControl>
                    <AddressAutocomplete
                      ref={addressAutocompleteRef}
                      endpoint="/api/places"
                      value={field.value || ""}
                      onChange={(v) => {
                        field.onChange(v);
                        setAddressComponents(null);
                      }}
                      onAddressSelect={(formatted, components) => {
                        field.onChange(formatted);
                        setAddressComponents(components);
                      }}
                      placeholder="Start typing an address..."
                      data-testid="input-schedule-address"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="salespersonId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Select Salesperson</FormLabel>
                  <FormControl>
                    {salespeopleLoading ? (
                      <div className="flex items-center gap-2 p-3 border rounded-md">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        <span className="text-muted-foreground">Loading salespeople...</span>
                      </div>
                    ) : salespeople.length === 0 ? (
                      <div className="p-3 border rounded-md text-muted-foreground">
                        No salespeople configured. Go to Settings → Salespeople to add team members.
                      </div>
                    ) : (
                      <Select onValueChange={field.onChange} value={field.value}>
                        <SelectTrigger data-testid="select-salesperson">
                          <SelectValue placeholder="Choose a salesperson" />
                        </SelectTrigger>
                        <SelectContent>
                          {salespeople.map((person) => (
                            <SelectItem key={person.userId} value={person.userId}>
                              <div className="flex items-center gap-2">
                                <div>
                                  <div className="font-medium">{person.name}</div>
                                  <div className="text-xs text-muted-foreground">{person.email}</div>
                                </div>
                              </div>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {selectedSalesperson && (
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm">Salesperson Details</CardTitle>
                </CardHeader>
                <CardContent className="grid gap-2 text-sm">
                  <div className="flex items-center gap-2">
                    <Mail className="h-4 w-4 text-muted-foreground" />
                    <span>{selectedSalesperson.email}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Clock className="h-4 w-4 text-muted-foreground" />
                    <span>Working hours: {selectedSalesperson.workingHoursStart || '09:00'} - {selectedSalesperson.workingHoursEnd || '17:00'}</span>
                  </div>
                  {selectedSalesperson.housecallProUserId && (
                    <div className="flex items-center gap-2">
                      <Badge variant="outline">Housecall Pro Linked</Badge>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            <FormField
              control={form.control}
              name="date"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Select Date</FormLabel>
                  <FormControl>
                    <div className="border rounded-md p-3">
                      <Calendar
                        mode="single"
                        selected={field.value}
                        onSelect={field.onChange}
                        disabled={(date) => date < new Date() || date < new Date(new Date().setHours(0, 0, 0, 0))}
                        className="rounded-md"
                        data-testid="calendar-date-picker"
                      />
                    </div>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {selectedDate && (
              <div className="border rounded-md p-3">
                <DaySchedulePanel
                  date={selectedDate}
                  salespersonId={selectedSalespersonId || undefined}
                  showSalespersonName={!selectedSalespersonId}
                />
              </div>
            )}

            {selectedDate && (
              <FormField
                control={form.control}
                name="timeSlot"
                render={({ field }) => {
                  return (
                    <FormItem>
                      <FormLabel>Select Time</FormLabel>
                      <FormControl>
                        {slotsLoading ? (
                          <div className="flex items-center gap-2 p-3 border rounded-md">
                            <Loader2 className="h-4 w-4 animate-spin" />
                            <span className="text-muted-foreground">Loading available times...</span>
                          </div>
                        ) : !selectedSalesperson ? (
                          <div className="text-center py-4 text-muted-foreground">
                            Select a salesperson to see available times
                          </div>
                        ) : availableSlots.length > 0 ? (
                          <Select onValueChange={field.onChange} value={field.value}>
                            <SelectTrigger data-testid="select-time-slot">
                              <SelectValue placeholder="Choose a start time">
                                {field.value && (
                                  <div className="flex items-center gap-2">
                                    <Clock className="h-4 w-4" />
                                    <span>{availableSlots.find(s => s.value === field.value)?.label}</span>
                                    {availableSlots.find(s => s.value === field.value)?.conflict && (
                                      <Badge variant="secondary" className="ml-1">Booked</Badge>
                                    )}
                                  </div>
                                )}
                              </SelectValue>
                            </SelectTrigger>
                            <SelectContent className="max-h-[300px]">
                              {availableSlots.map((slot) => (
                                <SelectItem
                                  key={slot.value}
                                  value={slot.value}
                                >
                                  <div className="flex items-center justify-between gap-2 w-full">
                                    <span>{slot.label}</span>
                                    {slot.conflict && (
                                      <Badge variant="secondary" data-testid={`badge-booked-${slot.value}`}>Booked</Badge>
                                    )}
                                  </div>
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          <div className="text-center py-4 text-muted-foreground">
                            {selectedSalesperson.name} is not working on {formatDateScheduling(selectedDate)}. Pick another day.
                          </div>
                        )}
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  );
                }}
              />
            )}

            <FormField
              control={form.control}
              name="notes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Notes (Optional)</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="Add any specific notes about this appointment..."
                      className="resize-none"
                      rows={3}
                      {...field}
                      data-testid="textarea-appointment-notes"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <Separator />

            <div className="flex justify-between">
              <Button
                type="button"
                variant="outline"
                onClick={onClose}
                data-testid="button-cancel-schedule"
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={scheduleMutation.isPending}
                data-testid="button-confirm-schedule"
              >
                {scheduleMutation.isPending ? "Scheduling..." : "Schedule Appointment"}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
