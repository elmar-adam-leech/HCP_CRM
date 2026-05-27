import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Code2, Search } from "lucide-react";

interface Variable {
  key: string;
  label: string;
  type: 'string' | 'number' | 'date' | 'boolean' | 'array';
  example?: string;
}

interface VariableGroup {
  title: string;
  variables: Variable[];
}

interface VariablePickerProps {
  entityType: 'lead' | 'estimate' | 'job' | 'customer';
  onSelect: (placeholder: string) => void;
  buttonText?: string;
  buttonVariant?: "default" | "outline" | "ghost" | "secondary";
  buttonSize?: "default" | "sm" | "lg" | "icon";
}

// Contact fields shared across entities that reference contacts
const CONTACT_VARIABLES: Variable[] = [
  { key: 'contact.name', label: 'Contact Name', type: 'string', example: 'John Doe' },
  { key: 'contact.emails', label: 'Contact Email (First)', type: 'array', example: 'john@example.com' },
  { key: 'contact.emails_all', label: 'All Contact Emails', type: 'array', example: 'john@example.com, jane@example.com' },
  { key: 'contact.phones', label: 'Contact Phone (First)', type: 'array', example: '(555) 123-4567' },
  { key: 'contact.phones_all', label: 'All Contact Phones', type: 'array', example: '(555) 123-4567, (555) 987-6543' },
  { key: 'contact.address', label: 'Contact Address', type: 'string', example: '123 Main St' },
  { key: 'contact.type', label: 'Contact Type', type: 'string', example: 'lead' },
  { key: 'contact.status', label: 'Contact Status', type: 'string', example: 'new' },
  { key: 'contact.source', label: 'Contact Source', type: 'string', example: 'website' },
  { key: 'contact.notes', label: 'Contact Notes', type: 'string', example: 'Interested in HVAC' },
  { key: 'contact.tags', label: 'Contact Tags', type: 'array', example: 'VIP, repeat' },
];

// Define all available variables for each entity type
const ENTITY_VARIABLE_GROUPS: Record<string, VariableGroup[]> = {
  lead: [
    {
      title: 'Lead Fields',
      variables: [
        { key: 'id', label: 'ID', type: 'string', example: 'abc-123' },
        { key: 'name', label: 'Name', type: 'string', example: 'John Doe' },
        { key: 'emails', label: 'Email (First)', type: 'array', example: 'john@example.com' },
        { key: 'emails_all', label: 'All Emails', type: 'array', example: 'john@example.com, jane@example.com' },
        { key: 'phones', label: 'Phone (First)', type: 'array', example: '(555) 123-4567' },
        { key: 'phones_all', label: 'All Phones', type: 'array', example: '(555) 123-4567, (555) 987-6543' },
        { key: 'address', label: 'Address', type: 'string', example: '123 Main St' },
        { key: 'type', label: 'Type', type: 'string', example: 'lead' },
        { key: 'status', label: 'Status', type: 'string', example: 'new' },
        { key: 'source', label: 'Source', type: 'string', example: 'website' },
        { key: 'notes', label: 'Notes', type: 'string', example: 'Interested in HVAC installation' },
        { key: 'tags', label: 'Tags', type: 'array', example: 'VIP, repeat' },
        { key: 'followUpDate', label: 'Follow-up Date', type: 'date', example: '2025-02-01' },
        { key: 'createdAt', label: 'Created Date', type: 'date', example: '2025-01-15' },
        { key: 'booking_link', label: 'Booking Link', type: 'string', example: 'https://yoursite.com/book/my-company?c=ab12cd34' },
      ],
    },
  ],
  estimate: [
    {
      title: 'Estimate Fields',
      variables: [
        { key: 'id', label: 'ID', type: 'string', example: 'est-456' },
        { key: 'title', label: 'Title', type: 'string', example: 'HVAC Installation Quote' },
        { key: 'description', label: 'Description', type: 'string', example: 'Full system installation' },
        { key: 'amount', label: 'Amount', type: 'string', example: '5000.00' },
        { key: 'status', label: 'Status', type: 'string', example: 'sent' },
        { key: 'option_count', label: 'Option Count', type: 'number', example: '3' },
        { key: 'line_items', label: 'Line Items (rendered list)', type: 'string', example: '1 x Furnace - $2,500.00\n1 x Install - $1,500.00' },
        { key: 'validUntil', label: 'Valid Until', type: 'date', example: '2025-02-15' },
        { key: 'followUpDate', label: 'Follow-up Date', type: 'date', example: '2025-01-20' },
        { key: 'contactId', label: 'Contact ID', type: 'string', example: 'contact-789' },
        { key: 'createdAt', label: 'Created Date', type: 'date', example: '2025-01-15' },
        { key: 'booking_link', label: 'Booking Link', type: 'string', example: 'https://yoursite.com/book/my-company?c=ab12cd34' },
      ],
    },
    {
      title: 'Salesperson (when assigned)',
      variables: [
        { key: 'salesperson.name', label: 'Name', type: 'string', example: 'Alex Salesperson' },
        { key: 'salesperson.email', label: 'Email', type: 'string', example: 'alex@example.com' },
        { key: 'salesperson.phone', label: 'Phone', type: 'string', example: '(555) 555-0100' },
      ],
    },
    {
      title: 'Approved Option (option_approved trigger only)',
      variables: [
        { key: 'approved_option.name', label: 'Option Name', type: 'string', example: 'Premium Package' },
        { key: 'approved_option.option_number', label: 'Option Number', type: 'number', example: '2' },
        { key: 'approved_option.total_amount', label: 'Total Amount', type: 'number', example: '7500.00' },
      ],
    },
    {
      title: 'Contact Fields',
      variables: CONTACT_VARIABLES,
    },
  ],
  job: [
    {
      title: 'Job Fields',
      variables: [
        { key: 'id', label: 'ID', type: 'string', example: 'job-789' },
        { key: 'title', label: 'Title', type: 'string', example: 'HVAC Repair Service' },
        { key: 'type', label: 'Type', type: 'string', example: 'repair' },
        { key: 'status', label: 'Status', type: 'string', example: 'scheduled' },
        { key: 'priority', label: 'Priority', type: 'string', example: 'high' },
        { key: 'value', label: 'Value', type: 'string', example: '500.00' },
        { key: 'paid_amount', label: 'Paid Amount', type: 'number', example: '500.00' },
        { key: 'payment_method', label: 'Payment Method', type: 'string', example: 'credit_card' },
        { key: 'is_deposit', label: 'Is Deposit', type: 'boolean', example: 'true' },
        { key: 'estimatedHours', label: 'Estimated Hours', type: 'number', example: '4' },
        { key: 'scheduledDate', label: 'Scheduled Date', type: 'date', example: '2025-01-18' },
        { key: 'contactId', label: 'Contact ID', type: 'string', example: 'contact-789' },
        { key: 'estimateId', label: 'Estimate ID', type: 'string', example: 'estimate-456' },
        { key: 'createdAt', label: 'Created Date', type: 'date', example: '2025-01-15' },
        { key: 'booking_link', label: 'Booking Link', type: 'string', example: 'https://yoursite.com/book/my-company?c=ab12cd34' },
      ],
    },
    {
      title: 'Payment (payment_received / deposit_received triggers)',
      variables: [
        { key: 'payment.amount', label: 'Amount', type: 'number', example: '500.00' },
        { key: 'payment.method', label: 'Method', type: 'string', example: 'credit_card' },
        { key: 'payment.paid_at', label: 'Paid At', type: 'date', example: '2025-01-18T14:30:00Z' },
        { key: 'payment.is_deposit', label: 'Is Deposit', type: 'boolean', example: 'true' },
      ],
    },
    {
      title: 'Contact Fields',
      variables: CONTACT_VARIABLES,
    },
  ],
  customer: [
    {
      title: 'Customer Fields',
      variables: [
        { key: 'id', label: 'ID', type: 'string', example: 'cust-123' },
        { key: 'name', label: 'Name', type: 'string', example: 'Jane Smith' },
        { key: 'emails', label: 'Email (First)', type: 'array', example: 'jane@example.com' },
        { key: 'emails_all', label: 'All Emails', type: 'array', example: 'jane@example.com' },
        { key: 'phones', label: 'Phone (First)', type: 'array', example: '(555) 987-6543' },
        { key: 'phones_all', label: 'All Phones', type: 'array', example: '(555) 987-6543' },
        { key: 'address', label: 'Address', type: 'string', example: '456 Oak Ave' },
        { key: 'type', label: 'Type', type: 'string', example: 'customer' },
        { key: 'status', label: 'Status', type: 'string', example: 'active' },
        { key: 'source', label: 'Source', type: 'string', example: 'referral' },
        { key: 'notes', label: 'Notes', type: 'string', example: 'VIP customer' },
        { key: 'tags', label: 'Tags', type: 'array', example: 'VIP, repeat' },
        { key: 'createdAt', label: 'Created Date', type: 'date', example: '2025-01-15' },
      ],
    },
  ],
};

export default function VariablePicker({
  entityType,
  onSelect,
  buttonText = "Insert Variable",
  buttonVariant = "outline",
  buttonSize = "sm",
}: VariablePickerProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const variableGroups = ENTITY_VARIABLE_GROUPS[entityType] || [];

  // Filter variables based on search across all groups
  const filteredGroups = variableGroups.map(group => ({
    ...group,
    variables: group.variables.filter(
      (v) =>
        v.label.toLowerCase().includes(search.toLowerCase()) ||
        v.key.toLowerCase().includes(search.toLowerCase())
    ),
  })).filter(group => group.variables.length > 0);

  const handleInsert = (key: string) => {
    const placeholder = `{{${entityType}.${key}}}`;
    onSelect(placeholder);
    setOpen(false);
    setSearch("");
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant={buttonVariant}
          size={buttonSize}
          data-testid="button-variable-picker"
        >
          <Code2 className="w-4 h-4 mr-2" />
          {buttonText}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80" align="start">
        <div className="space-y-3">
          <div>
            <h4 className="font-medium text-sm mb-1">Insert {entityType} field</h4>
            <p className="text-xs text-muted-foreground">
              Click a field to insert it as a variable
            </p>
          </div>

          <div className="relative">
            <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search fields..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8"
              data-testid="input-search-variable"
            />
          </div>

          <ScrollArea className="h-72">
            <div className="space-y-4">
              {filteredGroups.length === 0 ? (
                <div className="text-sm text-muted-foreground text-center py-4">
                  No fields found
                </div>
              ) : (
                filteredGroups.map((group, groupIndex) => (
                  <div key={groupIndex} className="space-y-1">
                    {/* Group header - only show if there are multiple groups */}
                    {variableGroups.length > 1 && (
                      <div className="px-2 py-1.5">
                        <h5 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                          {group.title}
                        </h5>
                      </div>
                    )}
                    
                    {/* Variables in this group */}
                    {group.variables.map((variable) => (
                      <button
                        key={variable.key}
                        onClick={() => handleInsert(variable.key)}
                        className="w-full text-left px-3 py-2 rounded-md hover-elevate active-elevate-2 transition-colors"
                        data-testid={`button-variable-${variable.key}`}
                      >
                        <div className="font-medium text-sm">{variable.label}</div>
                        <div className="text-xs text-muted-foreground font-mono">
                          {`{{${entityType}.${variable.key}}}`}
                        </div>
                        {variable.example && (
                          <div className="text-xs text-muted-foreground mt-0.5">
                            Example: {variable.example}
                          </div>
                        )}
                      </button>
                    ))}
                  </div>
                ))
              )}
            </div>
          </ScrollArea>
        </div>
      </PopoverContent>
    </Popover>
  );
}
