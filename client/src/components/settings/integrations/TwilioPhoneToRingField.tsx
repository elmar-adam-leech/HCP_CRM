import { useEffect } from "react";
import { useMutation } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
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
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { isValidPhoneEntry, formatPhoneAsTyped } from "@/lib/utils";

// Empty clears the setting; otherwise accept any reasonable phone entry by digit
// count (10-15 digits) rather than a brittle character-class regex.
const phoneToRingSchema = z.object({
  twilioPhoneToRing: z
    .string()
    .refine(
      isValidPhoneEntry,
      "Enter a valid phone number, or leave blank to clear.",
    ),
});

type PhoneToRingForm = z.infer<typeof phoneToRingSchema>;

/**
 * Per-rep "Phone to Ring" for the Twilio bridge call — the personal phone Twilio
 * rings first before connecting the rep to the customer. Lives inside the Twilio
 * integration card so every rep who uses Twilio calling can set their own number
 * (not just admins). Gating (Twilio active calling provider) is handled by the
 * parent card.
 */
export function TwilioPhoneToRingField() {
  const { toast } = useToast();
  const { data: me } = useCurrentUser();

  const form = useForm<PhoneToRingForm>({
    resolver: zodResolver(phoneToRingSchema),
    defaultValues: { twilioPhoneToRing: "" },
  });

  // Load the current value once available from /api/auth/me, normalized to the
  // standard display format. reset() keeps the field in sync when switching
  // active company (the value is per-membership).
  const currentValue = me?.user?.twilioPhoneToRing ?? "";
  useEffect(() => {
    form.reset({ twilioPhoneToRing: formatPhoneAsTyped(currentValue) });
  }, [currentValue, form]);

  const saveMutation = useMutation({
    mutationFn: async (values: PhoneToRingForm) => {
      const trimmed = values.twilioPhoneToRing.trim();
      const response = await apiRequest("PATCH", "/api/twilio/my-phone", {
        twilioPhoneToRing: trimmed === "" ? "" : formatPhoneAsTyped(trimmed),
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

  return (
    <div className="pt-3 border-t space-y-3">
      <div>
        <p className="text-sm font-medium">Phone to Ring</p>
        <p className="text-xs text-muted-foreground">
          When you place a call, we ring this phone first, then connect you to the customer.
        </p>
      </div>
      <Form {...form}>
        <form
          onSubmit={form.handleSubmit((values) => saveMutation.mutate(values))}
          className="space-y-3"
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
                    onChange={(e) => field.onChange(formatPhoneAsTyped(e.target.value))}
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
            size="sm"
            disabled={saveMutation.isPending}
            data-testid="button-save-phone-to-ring"
          >
            {saveMutation.isPending ? "Saving..." : "Save"}
          </Button>
        </form>
      </Form>
    </div>
  );
}
