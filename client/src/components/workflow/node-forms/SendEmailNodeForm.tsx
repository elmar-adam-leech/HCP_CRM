import { useRef } from 'react';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { VariableInputField, VariableTextareaField, AfterSendingSection, insertVariableAtCursor } from './shared-fields';

interface SendEmailNodeFormProps {
  formData: Record<string, unknown>;
  handleChange: (field: string, value: unknown) => void;
  entityType: "lead" | "estimate" | "job" | "customer";
  isAdmin: boolean;
  gmailUsers: Array<{ id: string; name: string; email: string }>;
}

export function SendEmailNodeForm({ formData, handleChange, entityType, isAdmin, gmailUsers }: SendEmailNodeFormProps) {
  const emailToRef = useRef<HTMLInputElement>(null);
  const subjectRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  return (
    <>
      <VariableInputField label="To (Email)" fieldName="to" inputRef={emailToRef} entityType={entityType} value={String(formData.to || '')} onChange={(e) => handleChange('to', e.target.value)} onVariableSelect={(v) => insertVariableAtCursor('to', v, emailToRef, String(formData.to || ''), handleChange)} placeholder="email@example.com or {{lead.emails}}" testId="input-email-to" />
      <VariableInputField label="Subject" fieldName="subject" inputRef={subjectRef} entityType={entityType} value={String(formData.subject || '')} onChange={(e) => handleChange('subject', e.target.value)} onVariableSelect={(v) => insertVariableAtCursor('subject', v, subjectRef, String(formData.subject || ''), handleChange)} placeholder="Email subject (use Insert Variable button)" testId="input-email-subject" />
      <VariableTextareaField label="Body" fieldName="body" textareaRef={bodyRef} entityType={entityType} value={String(formData.body || '')} onChange={(e) => handleChange('body', e.target.value)} onVariableSelect={(v) => insertVariableAtCursor('body', v, bodyRef, String(formData.body || ''), handleChange)} placeholder="Email body content (use Insert Variable button)" rows={4} testId="input-email-body" />

      {isAdmin && (
        <div className="space-y-3 pt-3 border-t">
          <div className="text-sm font-medium">Advanced (Admin Only)</div>
          <div className="space-y-2">
            <Label htmlFor="fromEmail">From Email (Optional)</Label>
            <Select value={(formData.fromEmail as string | undefined) || undefined} onValueChange={(value) => handleChange('fromEmail', value === 'default' ? undefined : value)}>
              <SelectTrigger id="fromEmail" data-testid="select-email-from"><SelectValue placeholder="Use workflow creator's Gmail" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="default">Use workflow creator's Gmail</SelectItem>
                {gmailUsers.map((user) => <SelectItem key={user.id} value={user.email}>{user.name} ({user.email})</SelectItem>)}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">By default, emails are sent from the workflow creator's connected Gmail account</p>
          </div>
        </div>
      )}

      <AfterSendingSection entityType={formData.entityType ? String(formData.entityType) : undefined} updateStatus={formData.updateStatus as string | undefined} onStatusChange={(value) => handleChange('updateStatus', value)} testId="select-email-update-status" />
    </>
  );
}
