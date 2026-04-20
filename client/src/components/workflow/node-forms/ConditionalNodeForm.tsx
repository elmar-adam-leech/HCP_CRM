import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Check, ChevronsUpDown, Info, Plus, X } from 'lucide-react';
import { cn } from '@/lib/utils';

interface ConditionalNodeFormProps {
  formData: Record<string, unknown>;
  handleChange: (field: string, value: unknown) => void;
}

type TagMatch = 'any' | 'all';

interface MultiTagValue {
  tags: string[];
  match: TagMatch;
}

function parseTagValue(raw: unknown): MultiTagValue {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    const tags = Array.isArray(obj.tags) ? (obj.tags as unknown[]).map(String).filter(Boolean) : [];
    const match: TagMatch = obj.match === 'all' ? 'all' : 'any';
    return { tags, match };
  }
  if (Array.isArray(raw)) {
    return { tags: raw.map(String).filter(Boolean), match: 'any' };
  }
  const s = String(raw ?? '').trim();
  return { tags: s ? [s] : [], match: 'any' };
}

function serializeTagValue(v: MultiTagValue): unknown {
  if (v.tags.length === 0) return '';
  if (v.tags.length === 1 && v.match === 'any') return v.tags[0];
  return { tags: v.tags, match: v.match };
}

interface TagPickerProps {
  value: MultiTagValue;
  onChange: (value: MultiTagValue) => void;
  disabled?: boolean;
}

function TagPicker({ value, onChange, disabled }: TagPickerProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  const { data: tags = [], isLoading } = useQuery<string[]>({
    queryKey: ['/api/contacts/tags'],
    enabled: open,
  });

  const trimmedSearch = search.trim();
  const matchesExisting = trimmedSearch.length > 0 && tags.some((t) => t.toLowerCase() === trimmedSearch.toLowerCase());
  const selected = value.tags;

  const toggleTag = (tag: string) => {
    const exists = selected.some((t) => t.toLowerCase() === tag.toLowerCase());
    const next = exists
      ? selected.filter((t) => t.toLowerCase() !== tag.toLowerCase())
      : [...selected, tag];
    onChange({ ...value, tags: next });
  };

  const removeTag = (tag: string) => {
    onChange({ ...value, tags: selected.filter((t) => t !== tag) });
  };

  const addNew = (tag: string) => {
    if (!tag) return;
    if (selected.some((t) => t.toLowerCase() === tag.toLowerCase())) return;
    onChange({ ...value, tags: [...selected, tag] });
  };

  return (
    <div className="space-y-2">
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {selected.map((tag) => (
            <Badge key={tag} variant="secondary" className="gap-1" data-testid={`chip-tag-${tag}`}>
              <span>{tag}</span>
              {!disabled && (
                <button
                  type="button"
                  onClick={() => removeTag(tag)}
                  className="ml-0.5 rounded-sm opacity-70 hover:opacity-100"
                  aria-label={`Remove ${tag}`}
                  data-testid={`button-remove-tag-${tag}`}
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </Badge>
          ))}
        </div>
      )}
      <Popover open={open} onOpenChange={(o) => { if (!disabled) setOpen(o); }}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            disabled={disabled}
            className="w-full justify-between font-normal"
            data-testid="button-tag-picker"
          >
            <span className={cn('truncate', selected.length === 0 && 'text-muted-foreground')}>
              {selected.length === 0 ? 'Select or create tags' : `${selected.length} selected`}
            </span>
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
          <Command shouldFilter={true}>
            <CommandInput
              placeholder="Search tags..."
              value={search}
              onValueChange={setSearch}
              data-testid="input-tag-search"
            />
            <CommandList>
              {isLoading ? (
                <div className="p-2 text-sm text-muted-foreground">Loading tags...</div>
              ) : (
                <>
                  <CommandEmpty>
                    {trimmedSearch ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="w-full justify-start"
                        onClick={() => { addNew(trimmedSearch); setSearch(''); }}
                        data-testid="button-create-tag-empty"
                      >
                        <Plus className="mr-2 h-4 w-4" />
                        Add "{trimmedSearch}"
                      </Button>
                    ) : (
                      <div className="p-2 text-sm text-muted-foreground">No tags yet.</div>
                    )}
                  </CommandEmpty>
                  {tags.length > 0 && (
                    <CommandGroup heading="Existing tags">
                      {tags.map((tag) => {
                        const isSelected = selected.some((t) => t.toLowerCase() === tag.toLowerCase());
                        return (
                          <CommandItem
                            key={tag}
                            value={tag}
                            onSelect={() => { toggleTag(tag); }}
                            data-testid={`option-tag-${tag}`}
                          >
                            <Check className={cn('mr-2 h-4 w-4', isSelected ? 'opacity-100' : 'opacity-0')} />
                            {tag}
                          </CommandItem>
                        );
                      })}
                    </CommandGroup>
                  )}
                  {trimmedSearch && !matchesExisting && (
                    <CommandGroup>
                      <CommandItem
                        value={`__create__${trimmedSearch}`}
                        onSelect={() => { addNew(trimmedSearch); setSearch(''); }}
                        data-testid="button-create-tag"
                      >
                        <Plus className="mr-2 h-4 w-4" />
                        Add "{trimmedSearch}"
                      </CommandItem>
                    </CommandGroup>
                  )}
                </>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}

export function ConditionalNodeForm({ formData, handleChange }: ConditionalNodeFormProps) {
  const conditionField = String(formData.conditionField || '');
  const conditionOperator = String(formData.conditionOperator || '');
  const isTagsField = conditionField.endsWith('.tags');
  const valueDisabled = conditionOperator === 'is_empty' || conditionOperator === 'is_not_empty';

  const tagValue = isTagsField ? parseTagValue(formData.conditionValue) : { tags: [], match: 'any' as TagMatch };
  const showMatchQualifier = isTagsField && tagValue.tags.length > 1 && !valueDisabled;

  const onTagsChange = (next: MultiTagValue) => {
    handleChange('conditionValue', serializeTagValue(next));
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label>Condition Builder</Label>
        <p className="text-sm text-muted-foreground">Build a condition to branch your workflow</p>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <div className="space-y-2">
          <Label htmlFor="conditionField" className="text-xs">Field</Label>
          <Select value={conditionField} onValueChange={(value) => handleChange('conditionField', value)}>
            <SelectTrigger id="conditionField" data-testid="select-condition-field"><SelectValue placeholder="Select field" /></SelectTrigger>
            <SelectContent>
              {formData.entityType === 'lead' && (<><SelectItem value="lead.status">Status</SelectItem><SelectItem value="lead.name">Name</SelectItem><SelectItem value="lead.email">Email</SelectItem><SelectItem value="lead.phone">Phone</SelectItem><SelectItem value="lead.source">Source</SelectItem><SelectItem value="lead.tags">Tags</SelectItem></>)}
              {formData.entityType === 'estimate' && (<><SelectItem value="estimate.status">Status</SelectItem><SelectItem value="estimate.total">Total Amount</SelectItem><SelectItem value="estimate.amount">Amount</SelectItem><SelectItem value="estimate.option_count">Option Count</SelectItem><SelectItem value="estimate.salesperson_name">Salesperson</SelectItem><SelectItem value="estimate.title">Title</SelectItem><SelectItem value="estimate.customerName">Customer Name</SelectItem></>)}
              {formData.entityType === 'job' && (<><SelectItem value="job.status">Status</SelectItem><SelectItem value="job.type">Type</SelectItem><SelectItem value="job.priority">Priority</SelectItem><SelectItem value="job.scheduledDate">Scheduled Date</SelectItem><SelectItem value="job.paid_amount">Paid Amount</SelectItem><SelectItem value="job.payment_method">Payment Method</SelectItem><SelectItem value="job.is_deposit">Is Deposit</SelectItem></>)}
              {formData.entityType === 'customer' && (<><SelectItem value="customer.status">Status</SelectItem><SelectItem value="customer.name">Name</SelectItem><SelectItem value="customer.email">Email</SelectItem><SelectItem value="customer.tags">Tags</SelectItem></>)}
              {!formData.entityType && (<SelectItem value="custom" disabled>Set trigger entity type first</SelectItem>)}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label htmlFor="conditionOperator" className="text-xs">Operator</Label>
          <Select value={conditionOperator} onValueChange={(value) => handleChange('conditionOperator', value)}>
            <SelectTrigger id="conditionOperator" data-testid="select-condition-operator"><SelectValue placeholder="Operator" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="equals">=</SelectItem>
              <SelectItem value="not_equals">≠</SelectItem>
              <SelectItem value="greater_than">&gt;</SelectItem>
              <SelectItem value="less_than">&lt;</SelectItem>
              <SelectItem value="greater_or_equal">≥</SelectItem>
              <SelectItem value="less_or_equal">≤</SelectItem>
              <SelectItem value="contains">contains</SelectItem>
              <SelectItem value="not_contains">does not contain</SelectItem>
              <SelectItem value="starts_with">starts with</SelectItem>
              <SelectItem value="ends_with">ends with</SelectItem>
              <SelectItem value="is_empty">is empty</SelectItem>
              <SelectItem value="is_not_empty">is not empty</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label htmlFor="conditionValue" className="text-xs">Value</Label>
          {isTagsField ? (
            <TagPicker
              value={tagValue}
              onChange={onTagsChange}
              disabled={valueDisabled}
            />
          ) : (
            <Input
              id="conditionValue"
              value={String(formData.conditionValue || '')}
              onChange={(e) => handleChange('conditionValue', e.target.value)}
              placeholder="Enter value"
              data-testid="input-condition-value"
              disabled={valueDisabled}
            />
          )}
        </div>
      </div>

      {showMatchQualifier && (
        <div className="space-y-2">
          <Label htmlFor="tagMatch" className="text-xs">Match</Label>
          <Select
            value={tagValue.match}
            onValueChange={(v) => onTagsChange({ ...tagValue, match: v as TagMatch })}
          >
            <SelectTrigger id="tagMatch" className="w-48" data-testid="select-tag-match">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="any">any of</SelectItem>
              <SelectItem value="all">all of</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}

      {Boolean(conditionField) && Boolean(conditionOperator) && (() => {
        const op = conditionOperator;
        const opLabel = op === 'equals' ? '=' : op === 'not_equals' ? '!=' : op === 'greater_than' ? '>' : op === 'less_than' ? '<' : op === 'greater_or_equal' ? '>=' : op === 'less_or_equal' ? '<=' : op;
        const showValue = op !== 'is_empty' && op !== 'is_not_empty';
        let valueText: string;
        if (isTagsField && showValue) {
          if (tagValue.tags.length === 0) {
            valueText = '?';
          } else if (tagValue.tags.length === 1) {
            valueText = `"${tagValue.tags[0]}"`;
          } else {
            const join = tagValue.match === 'all' ? ' AND ' : ' OR ';
            valueText = tagValue.tags.map((t) => `"${t}"`).join(join);
          }
        } else {
          valueText = String(formData.conditionValue || '') || '?';
        }
        return (
          <div className="p-3 bg-muted rounded-md">
            <p className="text-sm font-medium mb-1">Condition Preview:</p>
            <code className="text-sm">
              {conditionField}{' '}{opLabel}{' '}{showValue ? valueText : ''}
            </code>
          </div>
        );
      })()}

      <div className="p-3 bg-blue-50 dark:bg-blue-950/20 rounded-md border border-blue-200 dark:border-blue-800">
        <p className="text-xs text-blue-900 dark:text-blue-100 font-medium mb-1"><Info className="h-3 w-3 inline-block mr-1" />How it works:</p>
        <ul className="text-xs text-blue-800 dark:text-blue-200 space-y-1 ml-4 list-disc">
          <li>Select a field from the trigger entity</li>
          <li>Choose an operator to compare</li>
          <li>Enter the value to compare against</li>
          <li>{isTagsField ? 'For tags, pick one or more tags. With multiple, choose "any of" or "all of".' : 'Connect branches to the "true" and "false" handles'}</li>
        </ul>
      </div>
    </div>
  );
}
