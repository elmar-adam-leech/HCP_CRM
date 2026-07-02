import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Calendar, Copy, ExternalLink, Code, Info } from "lucide-react";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useCurrentUser, isStrictAdmin } from "@/hooks/useCurrentUser";

interface BookingSlugData {
  bookingSlug: string | null;
  bookingUrl: string | null;
  bookingRedirectUrl: string | null;
  timezone: string | null;
  appointmentDurationMinutes: number | null;
  appointmentBufferMinutes: number | null;
}

const TIMEZONES = [
  { label: "Eastern Time (ET)", value: "America/New_York" },
  { label: "Central Time (CT)", value: "America/Chicago" },
  { label: "Mountain Time (MT)", value: "America/Denver" },
  { label: "Pacific Time (PT)", value: "America/Los_Angeles" },
  { label: "Alaska Time (AKT)", value: "America/Anchorage" },
  { label: "Hawaii Time (HT)", value: "Pacific/Honolulu" },
  { label: "Atlantic Time (AT)", value: "America/Halifax" },
  { label: "Arizona (no DST)", value: "America/Phoenix" },
  { label: "London (GMT/BST)", value: "Europe/London" },
  { label: "Central European (CET/CEST)", value: "Europe/Berlin" },
  { label: "Eastern European (EET/EEST)", value: "Europe/Athens" },
  { label: "India (IST)", value: "Asia/Kolkata" },
  { label: "China (CST)", value: "Asia/Shanghai" },
  { label: "Japan (JST)", value: "Asia/Tokyo" },
  { label: "Australia Eastern (AEST/AEDT)", value: "Australia/Sydney" },
  { label: "New Zealand (NZST/NZDT)", value: "Pacific/Auckland" },
  { label: "UTC", value: "UTC" },
];

function getBrowserTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function isKnownTimezone(tz: string): boolean {
  return TIMEZONES.some(t => t.value === tz);
}

export function BookingPageCard() {
  const { toast } = useToast();
  const { data: currentUser } = useCurrentUser();
  const isAdmin = isStrictAdmin(currentUser?.user?.role);

  const { data: bookingSlugData } = useQuery<BookingSlugData>({
    queryKey: ['/api/booking-slug'],
    enabled: isAdmin,
  });

  const [bookingSlugInput, setBookingSlugInput] = useState<string | undefined>(undefined);
  const [redirectUrlInput, setRedirectUrlInput] = useState<string | undefined>(undefined);
  const [timezoneInput, setTimezoneInput] = useState<string | undefined>(undefined);
  const [durationInput, setDurationInput] = useState<string | undefined>(undefined);
  const [bufferInput, setBufferInput] = useState<string | undefined>(undefined);

  const browserTz = getBrowserTimezone();
  const effectiveBookingSlug = bookingSlugInput ?? bookingSlugData?.bookingSlug ?? '';
  const effectiveRedirectUrl = redirectUrlInput ?? bookingSlugData?.bookingRedirectUrl ?? '';
  const effectiveTimezone = timezoneInput ?? bookingSlugData?.timezone ?? browserTz;
  const effectiveDuration = durationInput ?? String(bookingSlugData?.appointmentDurationMinutes ?? 60);
  const effectiveBuffer = bufferInput ?? String(bookingSlugData?.appointmentBufferMinutes ?? 30);

  useEffect(() => {
    if (bookingSlugData?.timezone) {
      setTimezoneInput(bookingSlugData.timezone);
    }
  }, [bookingSlugData?.timezone]);

  const saveBookingSettingsMutation = useMutation({
    mutationFn: async ({ bookingSlug, bookingRedirectUrl, timezone, appointmentDurationMinutes, appointmentBufferMinutes }: { bookingSlug: string; bookingRedirectUrl: string; timezone: string; appointmentDurationMinutes: number; appointmentBufferMinutes: number }) => {
      const response = await apiRequest('POST', '/api/booking-slug', {
        bookingSlug: bookingSlug.trim().toLowerCase() || null,
        bookingRedirectUrl: bookingRedirectUrl.trim() || null,
        timezone,
        appointmentDurationMinutes,
        appointmentBufferMinutes,
      });
      return response.json();
    },
    onSuccess: (data) => {
      setBookingSlugInput(data.bookingSlug || '');
      setRedirectUrlInput(data.bookingRedirectUrl || '');
      if (data.timezone) setTimezoneInput(data.timezone);
      if (data.appointmentDurationMinutes != null) setDurationInput(String(data.appointmentDurationMinutes));
      if (data.appointmentBufferMinutes != null) setBufferInput(String(data.appointmentBufferMinutes));
      toast({
        title: "Booking Settings Updated",
        description: data.bookingUrl ? "Your public booking page settings have been saved." : "Public booking page has been disabled.",
      });
      queryClient.invalidateQueries({ queryKey: ['/api/booking-slug'] });
    },
    onError: (error: any) => {
      toast({ title: "Error", description: error.message || "Failed to save booking settings.", variant: "destructive" });
    },
  });

  if (!isAdmin) return null;

  const embedCode = (bookingSlugData?.bookingUrl && bookingSlugData?.bookingSlug)
    ? `<!-- Add this where you want the booking widget -->\n<div id="booking-widget"></div>\n<script>\n  window.BookingWidgetConfig = {\n    slug: "${bookingSlugData.bookingSlug}",\n    baseUrl: "${new URL(bookingSlugData.bookingUrl).origin}"\n  };\n</script>\n<script src="${new URL(bookingSlugData.bookingUrl).origin}/booking-widget.js"></script>`
    : null;

  const unknownTz = !isKnownTimezone(effectiveTimezone);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Calendar className="h-5 w-5" />Public Booking Page</CardTitle>
        <CardDescription>Allow leads to self-schedule appointments through a public booking page</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="booking-slug">Booking URL Slug</Label>
            <div className="flex gap-2">
              <div className="flex-1 flex items-center gap-2">
                <span className="text-sm text-muted-foreground whitespace-nowrap">/book/</span>
                <Input
                  id="booking-slug"
                  placeholder="your-company-name"
                  value={effectiveBookingSlug}
                  onChange={(e) => setBookingSlugInput(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                  data-testid="input-booking-slug"
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">Use lowercase letters, numbers, and hyphens only (3-50 characters)</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="booking-redirect-url">Post-Booking Redirect URL</Label>
            <Input
              id="booking-redirect-url"
              placeholder="https://example.com/thank-you"
              value={effectiveRedirectUrl}
              onChange={(e) => setRedirectUrlInput(e.target.value)}
              data-testid="input-booking-redirect-url"
            />
            <p className="text-xs text-muted-foreground">
              If set, visitors will be sent to this page after successfully booking. Leave blank to show the default confirmation screen.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="booking-timezone">Scheduling Timezone</Label>
            <Select
              value={effectiveTimezone}
              onValueChange={(val) => setTimezoneInput(val)}
            >
              <SelectTrigger id="booking-timezone" data-testid="select-booking-timezone">
                <SelectValue placeholder="Select timezone" />
              </SelectTrigger>
              <SelectContent>
                {unknownTz && (
                  <SelectItem value={effectiveTimezone}>{effectiveTimezone}</SelectItem>
                )}
                {TIMEZONES.map(tz => (
                  <SelectItem key={tz.value} value={tz.value}>{tz.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Available time slots on the booking page are generated in this timezone.
              {!bookingSlugData?.timezone && ` Defaulting to your browser timezone (${browserTz}).`}
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="appointment-duration">Appointment Length (minutes)</Label>
              <Input
                id="appointment-duration"
                type="number"
                min={5}
                max={480}
                step={5}
                value={effectiveDuration}
                onChange={(e) => setDurationInput(e.target.value)}
                data-testid="input-appointment-duration"
              />
              <p className="text-xs text-muted-foreground">How long each appointment slot lasts.</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="appointment-buffer">Buffer Between Appointments (minutes)</Label>
              <Input
                id="appointment-buffer"
                type="number"
                min={0}
                max={240}
                step={5}
                value={effectiveBuffer}
                onChange={(e) => setBufferInput(e.target.value)}
                data-testid="input-appointment-buffer"
              />
              <p className="text-xs text-muted-foreground">Extra time reserved after each appointment before the next can be booked.</p>
            </div>
          </div>

          <Button
            onClick={() => saveBookingSettingsMutation.mutate({ bookingSlug: effectiveBookingSlug, bookingRedirectUrl: effectiveRedirectUrl, timezone: effectiveTimezone, appointmentDurationMinutes: Number(effectiveDuration), appointmentBufferMinutes: Number(effectiveBuffer) })}
            disabled={saveBookingSettingsMutation.isPending}
            data-testid="button-save-booking-slug"
          >
            {saveBookingSettingsMutation.isPending ? "Saving..." : "Save Booking Settings"}
          </Button>

          {bookingSlugData?.bookingUrl && (
            <div className="space-y-2">
              <Label>Your Public Booking URL</Label>
              <div className="flex items-center gap-2 p-3 bg-muted rounded-md">
                <a
                  href={bookingSlugData.bookingUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-primary hover:underline flex-1 truncate"
                  data-testid="link-booking-url"
                >
                  {bookingSlugData.bookingUrl}
                </a>
                <Button size="icon" variant="ghost" onClick={() => { navigator.clipboard.writeText(bookingSlugData.bookingUrl || ''); toast({ title: "Copied", description: "Booking URL copied to clipboard" }); }} data-testid="button-copy-booking-url">
                  <Copy className="h-4 w-4" />
                </Button>
                <Button size="icon" variant="ghost" onClick={() => window.open(bookingSlugData.bookingUrl || '', '_blank')} data-testid="button-open-booking-url">
                  <ExternalLink className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}

          {embedCode && (
            <div className="space-y-2">
              <Label className="flex items-center gap-2"><Code className="h-4 w-4" />Embed on Your Website</Label>
              <div className="p-3 bg-muted rounded-md">
                <pre className="text-xs overflow-x-auto whitespace-pre-wrap break-all text-muted-foreground">{embedCode}</pre>
                <Button variant="outline" size="sm" className="mt-2" onClick={() => { navigator.clipboard.writeText(embedCode); toast({ title: "Copied", description: "Embed code copied to clipboard" }); }} data-testid="button-copy-embed-code">
                  <Copy className="h-4 w-4 mr-2" />Copy Embed Code
                </Button>
              </div>
            </div>
          )}

          <Alert>
            <Info className="h-4 w-4" />
            <AlertDescription>
              Share this link with leads to allow them to schedule appointments directly. They'll see available time slots based on your team's calendar.
            </AlertDescription>
          </Alert>
        </div>
      </CardContent>
    </Card>
  );
}
