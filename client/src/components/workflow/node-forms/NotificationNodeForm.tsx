import { useRef } from 'react';
import { VariableInputField, VariableTextareaField, insertVariableAtCursor } from './shared-fields';

interface NotificationNodeFormProps {
  formData: Record<string, unknown>;
  handleChange: (field: string, value: unknown) => void;
  entityType: "lead" | "estimate" | "job" | "customer";
}

export function NotificationNodeForm({ formData, handleChange, entityType }: NotificationNodeFormProps) {
  const notificationTitleRef = useRef<HTMLInputElement>(null);
  const notificationMessageRef = useRef<HTMLTextAreaElement>(null);

  return (
    <>
      <VariableInputField label="Notification Title" fieldName="title" inputRef={notificationTitleRef} entityType={entityType} value={String(formData.title || '')} onChange={(e) => handleChange('title', e.target.value)} onVariableSelect={(v) => insertVariableAtCursor('title', v, notificationTitleRef, String(formData.title || ''), handleChange)} placeholder="Important update" testId="input-notification-title" />
      <VariableTextareaField label="Message" fieldName="message" textareaRef={notificationMessageRef} entityType={entityType} value={String(formData.message || '')} onChange={(e) => handleChange('message', e.target.value)} onVariableSelect={(v) => insertVariableAtCursor('message', v, notificationMessageRef, String(formData.message || ''), handleChange)} placeholder="Notification message" rows={3} testId="input-notification-message" />
    </>
  );
}
