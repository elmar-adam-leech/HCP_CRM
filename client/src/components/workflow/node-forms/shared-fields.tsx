import { type RefObject } from 'react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import VariablePicker from '../VariablePicker';

export function insertVariableAtCursor(
  fieldName: string,
  variable: string,
  ref: RefObject<HTMLInputElement | HTMLTextAreaElement>,
  currentValue: string,
  onChange: (field: string, value: unknown) => void
) {
  if (!ref.current) {
    onChange(fieldName, currentValue + variable);
    return;
  }
  const input = ref.current;
  const start = input.selectionStart || 0;
  const end = input.selectionEnd || 0;
  const newValue = currentValue.slice(0, start) + variable + currentValue.slice(end);
  onChange(fieldName, newValue);
  setTimeout(() => {
    input.focus();
    input.setSelectionRange(start + variable.length, start + variable.length);
  }, 0);
}

export function StatusOptions({ entityType }: { entityType?: string }) {
  if (entityType === 'lead') return (<>
    <SelectItem value="contacted">Contacted</SelectItem>
    <SelectItem value="scheduled">Scheduled</SelectItem>
    <SelectItem value="disqualified">Disqualified</SelectItem>
    <SelectItem value="lost">Lost</SelectItem>
    <SelectItem value="aged">Aged</SelectItem>
  </>);
  if (entityType === 'estimate') return (<>
    <SelectItem value="sent">Sent</SelectItem>
    <SelectItem value="viewed">Viewed</SelectItem>
    <SelectItem value="accepted">Accepted</SelectItem>
    <SelectItem value="rejected">Rejected</SelectItem>
  </>);
  if (entityType === 'job') return (<>
    <SelectItem value="in_progress">In Progress</SelectItem>
    <SelectItem value="completed">Completed</SelectItem>
  </>);
  return null;
}

export type VariableInputFieldProps = {
  label: string;
  fieldName: string;
  inputRef: RefObject<HTMLInputElement>;
  entityType: "lead" | "estimate" | "job" | "customer";
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onVariableSelect: (variable: string) => void;
  placeholder?: string;
  testId?: string;
};

export function VariableInputField({ label, fieldName, inputRef, entityType, value, onChange, onVariableSelect, placeholder, testId }: VariableInputFieldProps) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label htmlFor={fieldName}>{label}</Label>
        <VariablePicker entityType={entityType} onSelect={onVariableSelect} />
      </div>
      <Input ref={inputRef} id={fieldName} value={value} onChange={onChange} placeholder={placeholder} data-testid={testId} />
    </div>
  );
}

export type VariableTextareaFieldProps = {
  label: string;
  fieldName: string;
  textareaRef: RefObject<HTMLTextAreaElement>;
  entityType: "lead" | "estimate" | "job" | "customer";
  value: string;
  onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  onVariableSelect: (variable: string) => void;
  placeholder?: string;
  testId?: string;
  rows?: number;
};

export function VariableTextareaField({ label, fieldName, textareaRef, entityType, value, onChange, onVariableSelect, placeholder, testId, rows = 3 }: VariableTextareaFieldProps) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label htmlFor={fieldName}>{label}</Label>
        <VariablePicker entityType={entityType} onSelect={onVariableSelect} />
      </div>
      <Textarea ref={textareaRef} id={fieldName} value={value} onChange={onChange} placeholder={placeholder} rows={rows} data-testid={testId} />
    </div>
  );
}

export type AfterSendingSectionProps = {
  entityType: string | undefined;
  updateStatus: string | undefined;
  onStatusChange: (value: string) => void;
  testId: string;
};

export function AfterSendingSection({ entityType, updateStatus, onStatusChange, testId }: AfterSendingSectionProps) {
  return (
    <div className="space-y-3 pt-3 border-t">
      <div className="text-sm font-medium">After Sending (Optional)</div>
      {entityType ? (
        <div className="space-y-2">
          <Label htmlFor={`${testId}-status`}>Update Status</Label>
          <Select value={updateStatus || undefined} onValueChange={onStatusChange}>
            <SelectTrigger id={`${testId}-status`} data-testid={testId}>
              <SelectValue placeholder="No change" />
            </SelectTrigger>
            <SelectContent>
              <StatusOptions entityType={entityType} />
            </SelectContent>
          </Select>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Configure the trigger's entity type to enable status updates</p>
      )}
    </div>
  );
}
