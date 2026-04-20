import { UseFormReturn } from "react-hook-form";
import { z } from "zod";
import { insertContactSchema } from "@shared/schema";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AddressAutocomplete, AddressComponents } from "@/components/ui/AddressAutocomplete";
import { Textarea } from "@/components/ui/textarea";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { TagManager } from "@/components/TagManager";
import { CalendarIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { format } from "date-fns";

export const contactFormSchema = insertContactSchema
  .omit({ contractorId: true, emails: true, phones: true, type: true })
  .extend({
    email: z.string().optional(),
    phone: z.string().optional(),
  });

export type ContactFormValues = z.infer<typeof contactFormSchema>;

export const CONTACT_FORM_DEFAULTS: ContactFormValues = {
  name: "",
  email: "",
  phone: "",
  address: "",
  street: "",
  city: "",
  state: "",
  zip: "",
  source: "",
  notes: "",
  tags: [],
  followUpDate: undefined,
  utmSource: "",
  utmMedium: "",
  utmCampaign: "",
  utmTerm: "",
  utmContent: "",
  pageUrl: "",
};

interface LeadFormProps {
  form: UseFormReturn<ContactFormValues>;
  onSubmit: (values: ContactFormValues) => void;
  onCancel: () => void;
  isPending: boolean;
  submitLabel?: string;
}

export function LeadForm({ form, onSubmit, onCancel, isPending, submitLabel = "Save" }: LeadFormProps) {
  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <FormField
            control={form.control}
            name="name"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Name *</FormLabel>
                <FormControl>
                  <Input placeholder="Enter lead name" {...field} data-testid="input-lead-name" />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="email"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Email</FormLabel>
                <FormControl>
                  <Input type="email" placeholder="Enter email address" {...field} data-testid="input-lead-email" />
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
                <FormLabel>Phone</FormLabel>
                <FormControl>
                  <Input placeholder="Enter phone number" {...field} data-testid="input-lead-phone" />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="source"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Source</FormLabel>
                <FormControl>
                  <Input placeholder="e.g., Website, Referral" {...field} value={field.value ?? ""} data-testid="input-lead-source" />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <FormField
          control={form.control}
          name="street"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Street</FormLabel>
              <FormControl>
                <AddressAutocomplete
                  value={field.value ?? ""}
                  onChange={field.onChange}
                  onAddressSelect={(_formatted: string, components: AddressComponents) => {
                    field.onChange(components.street || _formatted);
                    form.setValue("city", components.city);
                    form.setValue("state", components.state);
                    form.setValue("zip", components.zip);
                  }}
                  endpoint="/api/places"
                  placeholder="123 Main St"
                  data-testid="input-lead-street"
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <FormField
            control={form.control}
            name="city"
            render={({ field }) => (
              <FormItem>
                <FormLabel>City</FormLabel>
                <FormControl>
                  <Input placeholder="City" {...field} value={field.value ?? ""} data-testid="input-lead-city" />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="state"
            render={({ field }) => (
              <FormItem>
                <FormLabel>State</FormLabel>
                <FormControl>
                  <Input placeholder="State" {...field} value={field.value ?? ""} data-testid="input-lead-state" />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="zip"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Zip</FormLabel>
                <FormControl>
                  <Input placeholder="Zip Code" {...field} value={field.value ?? ""} data-testid="input-lead-zip" />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <FormField
          control={form.control}
          name="followUpDate"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Follow-up Date</FormLabel>
              <Popover>
                <PopoverTrigger asChild>
                  <FormControl>
                    <Button
                      variant="outline"
                      className={cn(
                        "w-full justify-start text-left font-normal",
                        !field.value && "text-muted-foreground"
                      )}
                      data-testid="button-follow-up-date"
                    >
                      <CalendarIcon className="mr-2 h-4 w-4" />
                      {field.value ? format(field.value, "PPP") : "Pick a date"}
                    </Button>
                  </FormControl>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    selected={field.value ?? undefined}
                    onSelect={field.onChange}
                    disabled={(date) => date < new Date("1900-01-01")}
                    initialFocus
                  />
                </PopoverContent>
              </Popover>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="border-t pt-4 mt-6">
          <h3 className="text-sm font-medium mb-4">Tracking Information (Optional)</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <FormField
              control={form.control}
              name="pageUrl"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Page URL</FormLabel>
                  <FormControl>
                    <Input placeholder="https://yoursite.com/landing-page" {...field} value={field.value ?? ""} data-testid="input-lead-page-url" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="utmSource"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>UTM Source</FormLabel>
                  <FormControl>
                    <Input placeholder="e.g., google, facebook" {...field} value={field.value ?? ""} data-testid="input-lead-utm-source" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="utmMedium"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>UTM Medium</FormLabel>
                  <FormControl>
                    <Input placeholder="e.g., cpc, email, social" {...field} value={field.value ?? ""} data-testid="input-lead-utm-medium" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="utmCampaign"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>UTM Campaign</FormLabel>
                  <FormControl>
                    <Input placeholder="e.g., summer_sale_2024" {...field} value={field.value ?? ""} data-testid="input-lead-utm-campaign" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="utmTerm"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>UTM Term</FormLabel>
                  <FormControl>
                    <Input placeholder="e.g., hvac repair" {...field} value={field.value ?? ""} data-testid="input-lead-utm-term" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="utmContent"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>UTM Content</FormLabel>
                  <FormControl>
                    <Input placeholder="e.g., banner_ad_1" {...field} value={field.value ?? ""} data-testid="input-lead-utm-content" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        </div>

        <FormField
          control={form.control}
          name="notes"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Notes</FormLabel>
              <FormControl>
                <Textarea
                  placeholder="Enter any additional notes..."
                  className="min-h-[80px]"
                  {...field}
                  value={field.value ?? ""}
                  data-testid="textarea-lead-notes"
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="tags"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Tags</FormLabel>
              <FormControl>
                <TagManager
                  tags={field.value || []}
                  onChange={field.onChange}
                  placeholder="Add tag..."
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={onCancel}
            data-testid="button-cancel-lead"
          >
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={isPending}
            data-testid="button-submit-lead"
          >
            {isPending ? "Saving..." : submitLabel}
          </Button>
        </div>
      </form>
    </Form>
  );
}
