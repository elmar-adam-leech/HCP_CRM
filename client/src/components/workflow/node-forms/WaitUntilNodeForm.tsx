import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';

interface WaitUntilNodeFormProps {
  formData: Record<string, unknown>;
  handleChange: (field: string, value: unknown) => void;
}

export function WaitUntilNodeForm({ formData, handleChange }: WaitUntilNodeFormProps) {
  return (
    <div className="space-y-2">
      <Label htmlFor="dateTime">Date/Time</Label>
      <Input id="dateTime" type="datetime-local" value={String(formData.dateTime || '')} onChange={(e) => handleChange('dateTime', e.target.value)} data-testid="input-wait-datetime" />
    </div>
  );
}
