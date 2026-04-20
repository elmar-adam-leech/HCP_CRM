import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

interface DelayNodeFormProps {
  formData: Record<string, unknown>;
  handleChange: (field: string, value: unknown) => void;
}

function parseDuration(duration: string) {
  if (!duration) return { value: '1', unit: 'm' };

  const toSeconds = (val: number, unit: string): number => {
    const m: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400, second: 1, minute: 60, hour: 3600, day: 86400 };
    return val * (m[unit] || 60);
  };

  const fromSeconds = (total: number): { value: string; unit: string } => {
    if (total >= 86400 && total % 86400 === 0) return { value: String(total / 86400), unit: 'd' };
    if (total >= 3600 && total % 3600 === 0) return { value: String(total / 3600), unit: 'h' };
    if (total >= 60 && total % 60 === 0) return { value: String(total / 60), unit: 'm' };
    return { value: String(total), unit: 's' };
  };

  const shortMatch = duration.match(/^(\d+)([smhd])$/);
  if (shortMatch) return { value: shortMatch[1], unit: shortMatch[2] };

  const singleLong = duration.match(/^(\d+)\s*(second|minute|hour|day)s?$/i);
  if (singleLong) {
    const unitMap: Record<string, string> = { second: 's', minute: 'm', hour: 'h', day: 'd' };
    return { value: singleLong[1], unit: unitMap[singleLong[2].toLowerCase()] || 'm' };
  }

  let totalSeconds = 0;
  const multiPart = /(\d+)\s*(second|minute|hour|day)s?/gi;
  let match;
  while ((match = multiPart.exec(duration)) !== null) {
    totalSeconds += toSeconds(parseInt(match[1]), match[2].toLowerCase());
  }
  if (totalSeconds > 0) return fromSeconds(totalSeconds);

  return { value: '1', unit: 'm' };
}

export function DelayNodeForm({ formData, handleChange }: DelayNodeFormProps) {
  const { value: durationValue, unit: durationUnit } = parseDuration(String(formData.duration || ''));
  const handleDurationChange = (newValue: string, newUnit: string) => {
    handleChange('duration', `${newValue}${newUnit}`);
  };

  return (
    <div className="space-y-3">
      <Label>Duration</Label>
      <div className="flex gap-2">
        <div className="flex-1">
          <Input type="number" min="1" value={durationValue} onChange={(e) => handleDurationChange(e.target.value, durationUnit)} placeholder="1" data-testid="input-delay-value" />
        </div>
        <div className="w-32">
          <Select value={durationUnit} onValueChange={(value) => handleDurationChange(durationValue, value)}>
            <SelectTrigger data-testid="select-delay-unit"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="s">Seconds</SelectItem>
              <SelectItem value="m">Minutes</SelectItem>
              <SelectItem value="h">Hours</SelectItem>
              <SelectItem value="d">Days</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>
  );
}
