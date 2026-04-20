import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { StatusOptions } from './shared-fields';

interface UpdateEntityNodeFormProps {
  formData: Record<string, unknown>;
  handleChange: (field: string, value: unknown) => void;
  setFormData: (updater: (prev: Record<string, unknown>) => Record<string, unknown>) => void;
  terminology: { leadLabel?: string; estimateLabel?: string; jobLabel?: string } | undefined;
}

export function UpdateEntityNodeForm({ formData, handleChange, setFormData, terminology }: UpdateEntityNodeFormProps) {
  const entityType = String(formData.entityType || 'lead');

  function getSelectedStatus(): string {
    const updates = formData.updates as Record<string, unknown> | undefined;
    if (!updates) return '';
    if (updates.aged === true) return 'aged';
    return String(updates.status || '');
  }

  function handleStatusChange(value: string) {
    if (entityType === 'lead' && value === 'aged') {
      setFormData(prev => ({ ...prev, updates: { aged: true } }));
    } else {
      setFormData(prev => ({ ...prev, updates: { status: value } }));
    }
  }

  function handleEntityTypeChange(value: string) {
    handleChange('entityType', value);
    setFormData(prev => ({ ...prev, entityType: value, updates: {} }));
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="entityType">Entity Type</Label>
        <Select value={entityType} onValueChange={handleEntityTypeChange}>
          <SelectTrigger id="entityType" data-testid="select-update-entity-type"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="lead">{terminology?.leadLabel || 'Lead'}</SelectItem>
            <SelectItem value="estimate">{terminology?.estimateLabel || 'Estimate'}</SelectItem>
            <SelectItem value="job">{terminology?.jobLabel || 'Job'}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <Label htmlFor="updateStatus">New Status</Label>
        <Select value={getSelectedStatus()} onValueChange={handleStatusChange}>
          <SelectTrigger id="updateStatus" data-testid="select-update-entity-status"><SelectValue placeholder="Select status" /></SelectTrigger>
          <SelectContent>
            <StatusOptions entityType={entityType} />
          </SelectContent>
        </Select>
      </div>
      {getSelectedStatus() && (
        <div className="p-3 bg-muted rounded-md">
          <p className="text-sm font-medium mb-1">Preview:</p>
          <code className="text-sm">Set {entityType} status to "{getSelectedStatus()}"</code>
        </div>
      )}
    </div>
  );
}
