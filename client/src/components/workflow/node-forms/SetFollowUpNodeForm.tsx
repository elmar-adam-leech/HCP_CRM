import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';

interface SetFollowUpNodeFormProps {
  formData: Record<string, unknown>;
  handleChange: (field: string, value: unknown) => void;
  entityType?: string;
}

export function SetFollowUpNodeForm({ formData, handleChange, entityType }: SetFollowUpNodeFormProps) {
  const days = Number(formData.offsetDays ?? 1);

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="offsetDays">Days until follow-up</Label>
        <Input
          id="offsetDays"
          type="number"
          min={1}
          max={365}
          value={days}
          onChange={(e) => handleChange('offsetDays', Math.max(1, parseInt(e.target.value) || 1))}
          data-testid="input-follow-up-days"
        />
        <p className="text-xs text-muted-foreground">
          The follow-up will be scheduled {days === 1 ? '1 day' : `${days} days`} from when this workflow runs, set to 9:00 AM.
        </p>
      </div>
      <div className="p-3 bg-muted rounded-md space-y-1">
        <p className="text-xs text-muted-foreground">
          <strong>Applies to:</strong> the {entityType || 'lead'} from this workflow&apos;s trigger.
        </p>
        <p className="text-xs text-muted-foreground">
          Works with both lead and estimate triggers.
        </p>
      </div>
    </div>
  );
}
