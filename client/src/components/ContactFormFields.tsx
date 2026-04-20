import { Control } from "react-hook-form";
import { FormField, FormItem, FormLabel, FormControl, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { AddressAutocomplete } from "@/components/ui/AddressAutocomplete";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { CalendarIcon } from "lucide-react";
import { format } from "date-fns";
import { cn } from "@/lib/utils";

interface ContactFormFieldsProps {
  control: Control<any>;
  showUTMFields?: boolean;
  showFollowUpDate?: boolean;
  testIdPrefix?: string;
}

export function ContactFormFields({ 
  control, 
  showUTMFields = false,
  showFollowUpDate = false,
  testIdPrefix = "lead"
}: ContactFormFieldsProps) {
  return (
    <>
      {/* Core Contact Information */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <FormField
          control={control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Name *</FormLabel>
              <FormControl>
                <Input placeholder="Enter name" {...field} data-testid={`input-${testIdPrefix}-name`} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        
        <FormField
          control={control}
          name="email"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Email</FormLabel>
              <FormControl>
                <Input type="email" placeholder="Enter email address" {...field} data-testid={`input-${testIdPrefix}-email`} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        
        <FormField
          control={control}
          name="phone"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Phone</FormLabel>
              <FormControl>
                <Input placeholder="Enter phone number" {...field} data-testid={`input-${testIdPrefix}-phone`} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        
        <FormField
          control={control}
          name="source"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Source</FormLabel>
              <FormControl>
                <Input placeholder="e.g., Website, Referral" {...field} data-testid={`input-${testIdPrefix}-source`} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>
      
      <FormField
        control={control}
        name="address"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Address</FormLabel>
            <FormControl>
              <AddressAutocomplete
                value={field.value || ''}
                onChange={field.onChange}
                onAddressSelect={(formatted) => field.onChange(formatted)}
                endpoint="/api/places"
                placeholder="Enter full address"
                data-testid={`input-${testIdPrefix}-address`}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
      
      {showFollowUpDate && (
        <FormField
          control={control}
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
                      data-testid={`button-${testIdPrefix}-follow-up-date`}
                    >
                      <CalendarIcon className="mr-2 h-4 w-4" />
                      {field.value ? format(field.value, "PPP") : "Pick a date"}
                    </Button>
                  </FormControl>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    selected={field.value}
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
      )}
      
      {/* UTM Tracking Information Section */}
      {showUTMFields && (
        <div className="border-t pt-4 mt-6">
          <h3 className="text-sm font-medium mb-4">Tracking Information (Optional)</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <FormField
              control={control}
              name="pageUrl"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Page URL</FormLabel>
                  <FormControl>
                    <Input placeholder="https://yoursite.com/landing-page" {...field} data-testid={`input-${testIdPrefix}-page-url`} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            
            <FormField
              control={control}
              name="utmSource"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>UTM Source</FormLabel>
                  <FormControl>
                    <Input placeholder="e.g., google, facebook" {...field} data-testid={`input-${testIdPrefix}-utm-source`} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            
            <FormField
              control={control}
              name="utmMedium"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>UTM Medium</FormLabel>
                  <FormControl>
                    <Input placeholder="e.g., cpc, email, social" {...field} data-testid={`input-${testIdPrefix}-utm-medium`} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            
            <FormField
              control={control}
              name="utmCampaign"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>UTM Campaign</FormLabel>
                  <FormControl>
                    <Input placeholder="e.g., summer_sale_2024" {...field} data-testid={`input-${testIdPrefix}-utm-campaign`} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            
            <FormField
              control={control}
              name="utmTerm"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>UTM Term</FormLabel>
                  <FormControl>
                    <Input placeholder="e.g., hvac repair" {...field} data-testid={`input-${testIdPrefix}-utm-term`} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            
            <FormField
              control={control}
              name="utmContent"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>UTM Content</FormLabel>
                  <FormControl>
                    <Input placeholder="e.g., banner_ad_1" {...field} data-testid={`input-${testIdPrefix}-utm-content`} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        </div>
      )}
      
      <FormField
        control={control}
        name="notes"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Notes</FormLabel>
            <FormControl>
              <Textarea 
                placeholder="Enter any additional notes..." 
                className="min-h-[80px]" 
                {...field} 
                data-testid={`textarea-${testIdPrefix}-notes`}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
    </>
  );
}
