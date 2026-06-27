import { useEffect } from "react";
import { useMutation } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { PhoneCall } from "lucide-react";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useProviderConfig } from "@/hooks/use-provider-config";

// Allow empty (clears the setting) or a phone number with 10-15 digits,
// optionally prefixed with + and containing spaces, dashes, dots, parens.
const phoneToRingSchema = z.object({
  twilioPhoneToRing: z
    .string()
    .trim()
    .refine(
      (val) => val === "" || /^\+?[\d\s().-]{10,20}$/.test(val),
      "Enter a valid phone number, or leave blank to clear.",
    ),
});

type PhoneToRingForm = z.infer<typeof phoneToRingSchema>;

export function PhoneToRingCard() {
  const { toast } = useToast();
  const { data: me } = useCurrentUser();
  const { data: providerData } = useProviderConfig();

  const form = useForm<PhoneToRingForm>({
    resolver: zodResolver(phoneToRingSchema),
    defaultValues: { twilioPhoneToRing: "" },
  });

  // Load the current value once it's available from /api/auth/me. reset() keeps
  // the field in sync when switching active company (the value is per-membership).
  const currentValue = me?.user?.twilioPhoneToRing ?? "";
  useEffect(() => {
    form.reset({ twilioPhoneToRing: currentValue });
  }, [currentValue, form]);

  const saveMutation = useMutation({
    mutationFn: async (values: PhoneToRingForm) => {
      const response = await apiRequest("PATCH", "/api/twilio/my-phone", {
        twilioPhoneToRing: values.twilioPhoneToRing.trim(),
      });
      return response.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] });
      toast({
        title: "Phone to ring updated",
        description: data.twilioPhoneToRing
          ? "We'll ring this phone first when you place a call."
          : "Your phone to ring has been cleared.",
      });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to update", description: error.message, variant: "destructive" });
    },
  });

  // Only show when Twilio is the active calling provider — this setting only
  // affects the Twilio bridge call.
  const twilioIsCallingProvider = !!providerData?.configured?.find(
    (p) => p.providerType === "calling" && p.isActive && p.callingProvider === "twilio",
  );
  if (!twilioIsCallingProvider) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <PhoneCall className="h-5 w-5" />
          Phone to Ring
        </CardTitle>
        <CardDescription>
          When you place a call, we ring this phone first, then connect you to the customer.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit((values) => saveMutation.mutate(values))}
            className="space-y-4"
          >
            <FormField
              control={form.control}
              name="twilioPhoneToRing"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Your phone number</FormLabel>
                  <FormControl>
                    <Input
                      type="tel"
                      placeholder="(555) 123-4567"
                      autoComplete="tel"
                      data-testid="input-phone-to-ring"
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    Leave blank to clear. This number is private to your account at the current company.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <Button
              type="submit"
              disabled={saveMutation.isPending}
              data-testid="button-save-phone-to-ring"
            >
              {saveMutation.isPending ? "Saving..." : "Save"}
            </Button>
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}
