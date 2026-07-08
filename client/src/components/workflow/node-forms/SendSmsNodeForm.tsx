import { useRef } from 'react';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { VariableInputField, VariableTextareaField, AfterSendingSection, insertVariableAtCursor } from './shared-fields';

interface SendSmsNodeFormProps {
  formData: Record<string, unknown>;
  handleChange: (field: string, value: unknown) => void;
  entityType: "lead" | "estimate" | "job" | "customer";
  isAdmin: boolean;
  phoneNumbers: Array<{ id: string; phoneNumber: string; displayName?: string | null }>;
}

export function SendSmsNodeForm({ formData, handleChange, entityType, isAdmin, phoneNumbers }: SendSmsNodeFormProps) {
  const smsToRef = useRef<HTMLInputElement>(null);
  const messageRef = useRef<HTMLTextAreaElement>(null);

  return (
    <>
      <VariableInputField label="To (Phone Number)" fieldName="to" inputRef={smsToRef} entityType={entityType} value={String(formData.to || '')} onChange={(e) => handleChange('to', e.target.value)} onVariableSelect={(v) => insertVariableAtCursor('to', v, smsToRef, String(formData.to || ''), handleChange)} placeholder="(555) 123-4567 or {{lead.phones}}" testId="input-sms-to" />
      <VariableTextareaField label="Message" fieldName="message" textareaRef={messageRef} entityType={entityType} value={String(formData.message || '')} onChange={(e) => handleChange('message', e.target.value)} onVariableSelect={(v) => insertVariableAtCursor('message', v, messageRef, String(formData.message || ''), handleChange)} placeholder="SMS message content (use Insert Variable button)" rows={3} testId="input-sms-message" />

      <div className="flex items-start gap-2 rounded-md border p-3">
        <Checkbox
          id="isSchedulingIntent"
          checked={formData.isSchedulingIntent === true}
          onCheckedChange={(v) => handleChange('isSchedulingIntent', v === true)}
          data-testid="checkbox-sms-scheduling-intent"
        />
        <div className="grid gap-1 leading-none">
          <Label htmlFor="isSchedulingIntent" className="cursor-pointer">Scheduling intent</Label>
          <p className="text-xs text-muted-foreground">If your AI scheduling agent is enabled, it will reply to inbound responses to this SMS and try to book the appointment.</p>
        </div>
      </div>

      {isAdmin && (
        <div className="space-y-3 pt-3 border-t">
          <div className="text-sm font-medium">Advanced (Admin Only)</div>
          <div className="space-y-2">
            <Label htmlFor="fromNumber">From Phone Number (Optional)</Label>
            <Select value={(formData.fromNumber as string | undefined) || undefined} onValueChange={(value) => handleChange('fromNumber', value === 'default' ? undefined : value)}>
              <SelectTrigger id="fromNumber" data-testid="select-sms-from"><SelectValue placeholder="Use workflow creator's default" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="default">Use workflow creator's default</SelectItem>
                {phoneNumbers.map((phone) => <SelectItem key={phone.id} value={phone.phoneNumber}>{phone.displayName || phone.phoneNumber} ({phone.phoneNumber})</SelectItem>)}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">By default, SMS messages use the workflow creator's default phone number</p>
          </div>
        </div>
      )}

      <AfterSendingSection entityType={formData.entityType ? String(formData.entityType) : undefined} updateStatus={formData.updateStatus as string | undefined} onStatusChange={(value) => handleChange('updateStatus', value)} testId="select-sms-update-status" />
    </>
  );
}
