import { useState, useEffect, useMemo, useRef, lazy, Suspense } from "react";
import { useParams, useSearch } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { format, startOfDay } from "date-fns";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Calendar as CalendarIcon, Clock, User, Mail, Phone, MapPin, CheckCircle, Loader2, AlertCircle } from "lucide-react";
import { AddressAutocomplete, AddressComponents, AddressAutocompleteRef } from "@/components/ui/AddressAutocomplete";
import { useToast } from "@/hooks/use-toast";
import { buildBrandColorCss } from "@shared/brand-color";

const US_STATES = /\b(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)\b/;

function getMissingAddressFields(raw: string, components: AddressComponents | null): string[] {
  const missing: string[] = [];
  if (components) {
    if (!components.street) missing.push("street address");
    if (!components.city) missing.push("city");
    if (!components.state) missing.push("state");
    if (!components.zip) missing.push("ZIP");
  } else {
    if (!/^\d+\s+\w/.test(raw.trim())) missing.push("street address");
    if (!/\b\d{5}\b/.test(raw)) missing.push("ZIP");
    if (!US_STATES.test(raw)) missing.push("state");
    const parts = raw.split(",").map((s) => s.trim());
    const hasCity = parts.some((p) => p.length > 0 && /^[a-zA-Z\s]+$/.test(p) && !US_STATES.test(p) && !/^\d{5}$/.test(p));
    if (!hasCity) missing.push("city");
  }
  return missing;
}

function formatMissingFieldsMessage(missing: string[]): string {
  if (missing.length === 0) return "";
  if (missing.length === 1) return `please add your ${missing[0]}.`;
  if (missing.length === 2) return `please add your ${missing[0]} and ${missing[1]}.`;
  const last = missing[missing.length - 1];
  const rest = missing.slice(0, -1).join(", ");
  return `please add your ${rest}, and ${last}.`;
}

// Lazy-load the Calendar (react-day-picker) so it doesn't block the initial
// paint. It's below the fold on mobile and can load after the form is visible.
const Calendar = lazy(() =>
  import("@/components/ui/calendar").then((m) => ({ default: m.Calendar }))
);

interface ContractorInfo {
  name: string;
  bookingSlug: string;
  bookingRedirectUrl: string | null;
  logoUrl: string | null;
  brandColor: string | null;
}

interface TimeSlot {
  start: string;
  end: string;
  available: boolean;
}

const bookingFormSchema = z.object({
  name: z.string().min(2, "Name is required"),
  email: z.string().email("Valid email is required").or(z.string().length(0)),
  phone: z.string().min(10, "Valid phone number is required").or(z.string().length(0)),
  address: z.string().min(5, "Address is required"),
  date: z.date({ required_error: "Please select a date" }),
  timeSlot: z.string().min(1, "Please select a time slot"),
  notes: z.string().optional(),
}).refine((data) => data.email || data.phone, {
  message: "Email or phone number is required",
  path: ["email"],
});

type BookingFormValues = z.infer<typeof bookingFormSchema>;

interface PrefillData {
  name: string;
  email?: string;
  phone?: string;
  address?: string;
}

export default function PublicBooking() {
  const { slug } = useParams();
  const searchString = useSearch();
  const urlParams = useMemo(() => new URLSearchParams(searchString), [searchString]);
  const isEmbedded = urlParams.get('embed') === 'true';
  // Support short code (?c=<code>) only — legacy ?contact= / ?contactId= UUID
  // params are no longer accepted (raw UUIDs are not proof of identity).
  const bookingCode = urlParams.get('c');
  const [bookingComplete, setBookingComplete] = useState(false);
  const [bookingWarning, setBookingWarning] = useState<{ message: string; notesEcho?: string } | null>(null);
  const [bookingDetails, setBookingDetails] = useState<{ startTime: string } | null>(null);
  const [addressComponents, setAddressComponents] = useState<AddressComponents | null>(null);
  const addressAutocompleteRef = useRef<AddressAutocompleteRef>(null);
  const { toast } = useToast();

  const { data: contractorData, isLoading: contractorLoading, error: contractorError } = useQuery<{ contractor: ContractorInfo }>({
    queryKey: ['/api/public/book', slug],
    queryFn: async () => {
      const response = await fetch(`/api/public/book/${slug}`);
      if (!response.ok) {
        throw new Error("Booking page not found");
      }
      return response.json();
    },
    enabled: !!slug,
  });

  // Update document title and description when contractor info loads
  useEffect(() => {
    const name = contractorData?.contractor?.name;
    if (name) {
      document.title = `Book an Appointment - ${name}`;
      const desc = document.querySelector('meta[name="description"]');
      if (desc) desc.setAttribute('content', `Schedule a free estimate with ${name}. Pick a date and time that works for you.`);
    }
  }, [contractorData]);

  // Apply the contractor's brand color by injecting a <style> tag that
  // overrides the design-system primary/ring/sidebar-primary CSS variables.
  // The SSR render already inlines this style for the very first paint;
  // this effect keeps the theme in sync if the contractor data changes
  // (e.g. SPA navigation) and is a no-op when no brand color is set.
  useEffect(() => {
    const css = buildBrandColorCss(contractorData?.contractor?.brandColor ?? null);
    if (typeof document === 'undefined') return;
    const STYLE_ID = '__brand_color__';
    let styleEl = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
    if (!css) {
      if (styleEl) styleEl.remove();
      return;
    }
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = STYLE_ID;
      document.head.appendChild(styleEl);
    }
    if (styleEl.textContent !== css) styleEl.textContent = css;
  }, [contractorData]);

  // Pre-warm the server-side availability cache for the next 7 days as soon
  // as the booking page mounts.  This is a fire-and-forget POST; errors are
  // silently ignored so a warm-up failure never breaks the page.
  useEffect(() => {
    if (!slug || !contractorData) return;
    fetch(`/api/public/book/${slug}/warm-cache`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ days: 7 }),
    }).catch(() => {});
  }, [slug, contractorData]);

  // Redirect to the contractor's post-booking URL after a short delay, if configured.
  // Only https: URLs are permitted to prevent javascript:/data: XSS via stored redirect.
  useEffect(() => {
    if (!bookingComplete) return;
    const redirectUrl = contractorData?.contractor?.bookingRedirectUrl;
    if (!redirectUrl) return;
    try {
      const parsed = new URL(redirectUrl);
      if (parsed.protocol !== 'https:') return;
    } catch {
      return;
    }
    if (isEmbedded && window.top) {
      window.top.location.href = redirectUrl;
    } else {
      window.location.href = redirectUrl;
    }
  }, [bookingComplete, contractorData, isEmbedded]);

  // Fetch contact data for prefilling if a booking code is present in the URL
  const { data: prefillData } = useQuery<{ prefill: PrefillData }>({
    queryKey: ['/api/public/book', slug, 'contact', bookingCode],
    queryFn: async () => {
      const response = await fetch(`/api/public/book/${slug}/contact?c=${encodeURIComponent(bookingCode!)}`);
      if (!response.ok) {
        return { prefill: null };
      }
      return response.json();
    },
    enabled: !!slug && !!bookingCode,
  });

  const form = useForm<BookingFormValues>({
    resolver: zodResolver(bookingFormSchema),
    defaultValues: {
      name: "",
      email: "",
      phone: "",
      address: "",
      notes: "",
    },
  });

  const selectedDate = form.watch('date');

  // Format the selected date as a plain YYYY-MM-DD string.
  // Sending a calendar-date (not a UTC midnight timestamp) lets the server
  // generate slots for exactly that day in the contractor's timezone,
  // regardless of what UTC offset the user's browser happens to be in.
  const selectedDateStr = selectedDate ? format(selectedDate, 'yyyy-MM-dd') : undefined;

  const { data: availabilityData, isLoading: slotsLoading } = useQuery<{ slots: TimeSlot[] }>({
    queryKey: ['/api/public/book', slug, 'availability', selectedDateStr],
    queryFn: async () => {
      const response = await fetch(`/api/public/book/${slug}/availability?date=${selectedDateStr}`);
      if (!response.ok) {
        throw new Error("Failed to load availability");
      }
      return response.json();
    },
    enabled: !!slug && !!selectedDate,
    staleTime: 0,
  });

  const availableSlots = (availabilityData?.slots || [])
    .filter(slot => slot.available)
    .map(slot => {
      const start = new Date(slot.start);
      const end = new Date(slot.end);
      return {
        value: slot.start,
        label: `${format(start, 'h:mm a')} - ${format(end, 'h:mm a')}`,
      };
    });

  useEffect(() => {
    form.setValue('timeSlot', '');
  }, [selectedDate, form]);

  // Prefill form when contact data is loaded
  useEffect(() => {
    if (prefillData?.prefill) {
      const { name, email, phone, address } = prefillData.prefill;
      if (name) form.setValue('name', name);
      if (email) form.setValue('email', email);
      if (phone) form.setValue('phone', phone);
      if (address) form.setValue('address', address);
    }
  }, [prefillData, form]);

  const bookingMutation = useMutation({
    mutationFn: async (
      data: BookingFormValues & {
        resolvedAddress?: string;
        resolvedComponents?: AddressComponents | null;
      },
    ) => {
      const submittedAddress = data.resolvedAddress ?? data.address;
      const submittedComponents = data.resolvedComponents ?? addressComponents;
      const response = await fetch(`/api/public/book/${slug}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: data.name,
          email: data.email || undefined,
          phone: data.phone || undefined,
          address: submittedAddress || undefined,
          customerAddressComponents: submittedComponents || undefined,
          startTime: data.timeSlot,
          notes: data.notes,
          source: 'public_booking',
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          // Pass the short booking code so the backend can verify the caller
          // controls the pre-populated contact record.
          bookingCode: bookingCode || undefined,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || "Failed to book appointment");
      }

      return response.json();
    },
    onSuccess: (data) => {
      setBookingDetails({ startTime: form.getValues('timeSlot') });
      // Surface server-reported soft warnings (e.g. notes not attached).
      const warning = (data as { warning?: { message?: string; notesEcho?: string } } | undefined)?.warning;
      if (warning?.message) {
        setBookingWarning({ message: warning.message, notesEcho: warning.notesEcho });
      } else {
        setBookingWarning(null);
      }
      setBookingComplete(true);
    },
    onError: (error: Error) => {
      toast({
        variant: "destructive",
        title: "Booking failed",
        description: error.message || "Unable to submit your booking. Please try again.",
      });
    },
  });

  const onSubmit = async (data: BookingFormValues) => {
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
    bookingMutation.mutate({ ...data, resolvedAddress, resolvedComponents });
  };

  if (contractorError) {
    return (
      <div className={`flex items-center justify-center bg-background p-4 ${isEmbedded ? 'min-h-[400px]' : 'min-h-screen'}`}>
        <Card className="max-w-md w-full">
          <CardContent className="pt-6 text-center">
            <AlertCircle className="h-12 w-12 mx-auto text-destructive mb-4" />
            <h2 className="text-xl font-semibold mb-2">Booking Page Not Found</h2>
            <p className="text-muted-foreground">
              This booking link is invalid or the company hasn't set up their booking page yet.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (bookingComplete && bookingDetails) {
    const appointmentDate = new Date(bookingDetails.startTime);
    const hasRedirect = !!contractorData?.contractor?.bookingRedirectUrl;
    return (
      <div className={`flex items-center justify-center bg-background p-4 ${isEmbedded ? 'min-h-[400px]' : 'min-h-screen'}`}>
        <Card className="max-w-md w-full">
          <CardContent className="pt-6 text-center">
            <CheckCircle className="h-16 w-16 mx-auto text-green-500 mb-4" />
            <h2 className="text-2xl font-semibold mb-2">Appointment Booked!</h2>
            <p className="text-muted-foreground mb-4">
              Your appointment with {contractorData?.contractor.name} has been confirmed.
            </p>
            <div className="bg-muted rounded-lg p-4 text-left">
              <div className="flex items-center gap-2 mb-2">
                <CalendarIcon className="h-4 w-4 text-muted-foreground" />
                <span className="font-medium">{format(appointmentDate, 'EEEE, MMMM d, yyyy')}</span>
              </div>
              <div className="flex items-center gap-2">
                <Clock className="h-4 w-4 text-muted-foreground" />
                <span className="font-medium">{format(appointmentDate, 'h:mm a')}</span>
              </div>
            </div>
            {bookingWarning && (
              <div
                className="mt-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-left text-sm text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-100"
                data-testid="banner-booking-warning"
              >
                <div className="flex items-start gap-2">
                  <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
                  <div className="space-y-2">
                    <p className="font-medium">{bookingWarning.message}</p>
                    {bookingWarning.notesEcho && (
                      <div>
                        <p className="text-xs uppercase tracking-wide opacity-70 mb-1">Notes you entered</p>
                        <p className="whitespace-pre-wrap break-words text-sm">{bookingWarning.notesEcho}</p>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
            {!hasRedirect && (
              <p className="text-sm text-muted-foreground mt-4">
                You'll receive a confirmation shortly. If you need to make changes, please contact us directly.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <main className={`bg-background px-4 ${isEmbedded ? 'py-4' : 'min-h-screen py-8'}`}>
      <div className="max-w-2xl mx-auto">
        <Card>
          <CardHeader className="text-center">
            {/* Reserve a fixed-height slot for the logo so missing/loading logos
                don't shift layout when the image resolves. */}
            <div className="flex items-center justify-center min-h-[64px] mb-2">
              {contractorData?.contractor.logoUrl ? (
                <img
                  src={contractorData.contractor.logoUrl}
                  alt={`${contractorData.contractor.name} logo`}
                  className="max-h-16 max-w-[200px] object-contain"
                  data-testid="img-contractor-logo"
                />
              ) : null}
            </div>
            <CardTitle className="text-2xl flex items-center justify-center gap-2">
              <CalendarIcon className="h-6 w-6" />
              Schedule an Appointment
            </CardTitle>
            {/* Reserve a fixed height so that loading → contractor name doesn't shift layout */}
            <CardDescription className="text-lg min-h-[28px]">
              {contractorLoading
                ? <Skeleton className="h-5 w-48 mx-auto" />
                : `Book a free estimate with ${contractorData?.contractor.name}`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
                <div className="space-y-4">
                  <h3 className="font-medium flex items-center gap-2">
                    <User className="h-4 w-4" />
                    Your Information
                  </h3>
                  
                  <FormField
                    control={form.control}
                    name="name"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Full Name *</FormLabel>
                        <FormControl>
                          <Input placeholder="John Smith" {...field} data-testid="input-name" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <FormField
                      control={form.control}
                      name="email"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="flex items-center gap-1">
                            <Mail className="h-3 w-3" />
                            Email
                          </FormLabel>
                          <FormControl>
                            <Input type="email" placeholder="john@example.com" {...field} data-testid="input-email" />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    <FormField
                      control={form.control}
                      name="phone"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="flex items-center gap-1">
                            <Phone className="h-3 w-3" />
                            Phone
                          </FormLabel>
                          <FormControl>
                            <Input type="tel" placeholder="(555) 123-4567" {...field} data-testid="input-phone" />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>

                  <FormField
                    control={form.control}
                    name="address"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="flex items-center gap-1">
                          <MapPin className="h-3 w-3" />
                          Address *
                        </FormLabel>
                        <FormControl>
                          <AddressAutocomplete
                            ref={addressAutocompleteRef}
                            endpoint="/api/public/places"
                            credentials="omit"
                            value={field.value || ''}
                            onChange={(val) => {
                              field.onChange(val);
                              setAddressComponents(null);
                            }}
                            onAddressSelect={(formatted, components) => {
                              field.onChange(formatted);
                              setAddressComponents(components);
                            }}
                            placeholder="123 Main St, City, State"
                            data-testid="input-address"
                          />
                        </FormControl>
                        {(() => {
                          const raw = field.value || '';
                          if (!raw) return null;
                          const missing = getMissingAddressFields(raw, addressComponents);
                          if (missing.length === 0) return null;
                          const msg = formatMissingFieldsMessage(missing);
                          return (
                            <p className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
                              <AlertCircle className="h-3 w-3 shrink-0" />
                              A complete address is recommended — {msg}
                            </p>
                          );
                        })()}
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <Separator />

                <div className="space-y-4">
                  <h3 className="font-medium flex items-center gap-2">
                    <Clock className="h-4 w-4" />
                    Select Date & Time
                  </h3>

                  <FormField
                    control={form.control}
                    name="date"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Date</FormLabel>
                        <FormControl>
                          {/* Fixed height so the calendar doesn't shift surrounding content */}
                          <div className="border rounded-md p-3 flex justify-center min-h-[300px] items-start">
                            <Suspense fallback={<Skeleton className="w-[280px] h-[270px] rounded-md" />}>
                              <Calendar
                                mode="single"
                                selected={field.value}
                                onSelect={field.onChange}
                                disabled={(date) => date < new Date() || date < startOfDay(new Date())}
                                className="rounded-md"
                                data-testid="calendar-booking"
                              />
                            </Suspense>
                          </div>
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  {/*
                    Always render the time-slot section with a fixed min-height.
                    Hiding it entirely when no date is selected causes CLS when it appears.
                  */}
                  <FormField
                    control={form.control}
                    name="timeSlot"
                    render={({ field }) => (
                      <FormItem className="min-h-[72px]">
                        {selectedDate && (
                          <>
                            <FormLabel>Available Times for {format(selectedDate, 'MMMM d, yyyy')}</FormLabel>
                            <FormControl>
                              {slotsLoading ? (
                                <div className="flex items-center gap-2 p-3 border rounded-md h-10">
                                  <Loader2 className="h-4 w-4 animate-spin" />
                                  <span className="text-muted-foreground">Loading available times...</span>
                                </div>
                              ) : availableSlots.length === 0 ? (
                                <div className="p-4 border rounded-md text-center text-muted-foreground">
                                  No available times on this date. Please select another day.
                                </div>
                              ) : (
                                <Select onValueChange={field.onChange} value={field.value}>
                                  <SelectTrigger data-testid="select-time">
                                    <SelectValue placeholder="Choose a time slot" />
                                  </SelectTrigger>
                                  <SelectContent className="max-h-[300px]">
                                    {availableSlots.map((slot) => (
                                      <SelectItem key={slot.value} value={slot.value}>
                                        {slot.label}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              )}
                            </FormControl>
                            <FormMessage />
                          </>
                        )}
                      </FormItem>
                    )}
                  />
                </div>

                <Separator />

                <FormField
                  control={form.control}
                  name="notes"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Additional Notes (Optional)</FormLabel>
                      <FormControl>
                        <Textarea
                          placeholder="Tell us about your project or any specific requirements..."
                          className="resize-none"
                          rows={3}
                          {...field}
                          data-testid="textarea-notes"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {bookingMutation.isError && (
                  <div className="p-3 rounded-md bg-destructive/10 text-destructive text-sm flex items-center gap-2">
                    <AlertCircle className="h-4 w-4" />
                    {bookingMutation.error?.message || "Failed to book appointment. Please try again."}
                  </div>
                )}

                <Button
                  type="submit"
                  className="w-full"
                  size="lg"
                  disabled={bookingMutation.isPending || contractorLoading || !contractorData}
                  data-testid="button-submit-booking"
                >
                  {bookingMutation.isPending ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin mr-2" />
                      Booking...
                    </>
                  ) : (
                    "Book Appointment"
                  )}
                </Button>

                <p className="text-xs text-center text-muted-foreground">
                  By booking, you agree to be contacted regarding your appointment.
                </p>
              </form>
            </Form>
          </CardContent>
        </Card>
        <footer className="mt-8 text-center text-xs text-muted-foreground space-x-4">
          <span>&copy; {new Date().getFullYear()} All rights reserved.</span>
          <a href={`/privacy/${slug}`} className="hover:underline">Privacy Policy</a>
          <a href="/terms" className="hover:underline">Terms of Service</a>
        </footer>
      </div>
    </main>
  );
}
