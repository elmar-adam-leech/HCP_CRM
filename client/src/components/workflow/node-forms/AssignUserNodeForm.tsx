import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

interface AssignUserNodeFormProps {
  formData: Record<string, unknown>;
  handleChange: (field: string, value: unknown) => void;
  isAdmin: boolean;
  teamUsers: Array<{ id: string; name: string; email: string }>;
}

export function AssignUserNodeForm({ formData, handleChange, isAdmin, teamUsers }: AssignUserNodeFormProps) {
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="userId">Assign to Team Member</Label>
        {isAdmin ? (
          <Select value={String(formData.userId || '')} onValueChange={(v) => handleChange('userId', v)}>
            <SelectTrigger id="userId" data-testid="select-assign-user"><SelectValue placeholder="Select team member" /></SelectTrigger>
            <SelectContent>
              {teamUsers.map((u) => <SelectItem key={u.id} value={u.id}>{u.name} ({u.email})</SelectItem>)}
            </SelectContent>
          </Select>
        ) : (
          <Input id="userId" value={String(formData.userId || '')} onChange={(e) => handleChange('userId', e.target.value)} placeholder="user-id" data-testid="input-assign-user" />
        )}
      </div>
      <div className="p-3 bg-muted rounded-md space-y-1">
        <p className="text-xs text-muted-foreground"><strong>Applies to:</strong> the {String(formData.entityType || 'lead')} from this workflow&apos;s trigger.</p>
        {Boolean(formData.entityType) && formData.entityType !== 'lead' && (
          <p className="text-xs text-muted-foreground">Note: direct assignment is only supported for leads. For estimates and jobs, assignment is managed through their linked lead.</p>
        )}
      </div>
    </div>
  );
}
