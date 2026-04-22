import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { TagManager } from '@/components/TagManager';

interface TriggerNodeFormProps {
  formData: Record<string, unknown>;
  handleChange: (field: string, value: unknown) => void;
  terminology: { leadLabel?: string; estimateLabel?: string; jobLabel?: string } | undefined;
}

export function TriggerNodeForm({ formData, handleChange, terminology }: TriggerNodeFormProps) {
  return (
    <>
      <div className="space-y-2">
        <Label htmlFor="label">Trigger Name</Label>
        <Input id="label" value={String(formData.label || '')} onChange={(e) => handleChange('label', e.target.value)} placeholder={`When ${terminology?.leadLabel || 'Lead'} is Created`} data-testid="input-trigger-label" />
      </div>
      <div className="space-y-2">
        <Label htmlFor="triggerType">Trigger Type</Label>
        <Select value={String(formData.triggerType || 'entity_event')} onValueChange={(value) => handleChange('triggerType', value)}>
          <SelectTrigger id="triggerType" data-testid="select-trigger-type"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="entity_event">Entity Event</SelectItem>
            <SelectItem value="time_based">Time Based</SelectItem>
            <SelectItem value="manual">Manual</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {formData.triggerType === 'entity_event' && (
        <>
          <div className="space-y-2">
            <Label htmlFor="entityType">Entity</Label>
            <Select value={String(formData.entityType || 'lead')} onValueChange={(value) => handleChange('entityType', value)}>
              <SelectTrigger id="entityType" data-testid="select-trigger-entity"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="lead">{terminology?.leadLabel || 'Lead'}</SelectItem>
                <SelectItem value="estimate">{terminology?.estimateLabel || 'Estimate'}</SelectItem>
                <SelectItem value="job">{terminology?.jobLabel || 'Job'}</SelectItem>
                <SelectItem value="customer">Customer</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="eventType">Event Type</Label>
            <Select value={String(formData.eventType || 'created')} onValueChange={(value) => handleChange('eventType', value)}>
              <SelectTrigger id="eventType" data-testid="select-trigger-event"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="created">Created</SelectItem>
                <SelectItem value="updated">Updated</SelectItem>
                <SelectItem value="status_changed">Status Changed</SelectItem>
                <SelectItem value="deleted">Deleted</SelectItem>
                {formData.entityType === 'estimate' && (
                  <>
                    <SelectItem value="option_approved">Option Approved</SelectItem>
                    <SelectItem value="option_rejected">Option Rejected</SelectItem>
                    <SelectItem value="stale">Stale (No Response)</SelectItem>
                  </>
                )}
                {formData.entityType === 'job' && (
                  <>
                    <SelectItem value="payment_received">Payment Received</SelectItem>
                    <SelectItem value="deposit_received">Deposit Received</SelectItem>
                  </>
                )}
              </SelectContent>
            </Select>
          </div>
          {formData.eventType === 'stale' && (
            <div className="space-y-2">
              <Label htmlFor="staleDays">Days Without Response</Label>
              <Input
                id="staleDays"
                type="number"
                min="1"
                value={String(formData.staleDays || '7')}
                onChange={(e) => handleChange('staleDays', e.target.value)}
                placeholder="7"
                data-testid="input-stale-days"
              />
              <p className="text-xs text-muted-foreground">Trigger when an estimate has no approval/rejection after this many days.</p>
            </div>
          )}
          {formData.eventType === 'status_changed' && (
            <div className="space-y-2">
              <Label htmlFor="targetStatus">Status Changed To</Label>
              <Select value={String(formData.targetStatus || '')} onValueChange={(value) => handleChange('targetStatus', value)}>
                <SelectTrigger id="targetStatus" data-testid="select-target-status"><SelectValue placeholder="Select status" /></SelectTrigger>
                <SelectContent>
                  {formData.entityType === 'lead' && (<><SelectItem value="new">New</SelectItem><SelectItem value="contacted">Contacted</SelectItem><SelectItem value="scheduled">Scheduled</SelectItem><SelectItem value="disqualified">Disqualified</SelectItem><SelectItem value="lost">Lost</SelectItem><SelectItem value="aged">Aged</SelectItem></>)}
                  {formData.entityType === 'estimate' && (<><SelectItem value="scheduled">Scheduled</SelectItem><SelectItem value="in_progress">In Progress</SelectItem><SelectItem value="sent">Sent</SelectItem><SelectItem value="approved">Approved</SelectItem><SelectItem value="rejected">Rejected</SelectItem></>)}
                  {formData.entityType === 'job' && (<><SelectItem value="scheduled">Scheduled</SelectItem><SelectItem value="in_progress">In Progress</SelectItem><SelectItem value="completed">Completed</SelectItem><SelectItem value="cancelled">Cancelled</SelectItem></>)}
                  {formData.entityType === 'customer' && (<><SelectItem value="active">Active</SelectItem><SelectItem value="inactive">Inactive</SelectItem></>)}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-2">
            <Label>Filter by Tags (Optional)</Label>
            <p className="text-xs text-muted-foreground mb-2">Only trigger this workflow for contacts with these tags. Leave empty to trigger for all contacts.</p>
            <TagManager tags={(formData.tags as string[]) || []} onChange={(tags) => handleChange('tags', tags)} placeholder="Add tag filter (e.g., Ductless, Emergency)..." />
          </div>
        </>
      )}

      {formData.triggerType === 'time_based' && (
        <>
          <div className="space-y-2">
            <Label htmlFor="scheduleType">Schedule Type</Label>
            <Select value={String(formData.scheduleType || 'interval')} onValueChange={(value) => handleChange('scheduleType', value)}>
              <SelectTrigger id="scheduleType" data-testid="select-schedule-type"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="interval">Interval</SelectItem>
                <SelectItem value="daily">Daily</SelectItem>
                <SelectItem value="weekly">Weekly</SelectItem>
                <SelectItem value="monthly">Monthly</SelectItem>
                <SelectItem value="cron">Custom (Cron)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {formData.scheduleType === 'interval' && (
            <div className="space-y-2">
              <Label htmlFor="interval">Interval</Label>
              <Input id="interval" value={String(formData.interval || '')} onChange={(e) => handleChange('interval', e.target.value)} placeholder="e.g., 1 hour, 30 minutes" data-testid="input-trigger-interval" />
            </div>
          )}
          {formData.scheduleType === 'daily' && (
            <div className="space-y-2">
              <Label htmlFor="time">Time of Day</Label>
              <Input id="time" type="time" value={String(formData.time || '')} onChange={(e) => handleChange('time', e.target.value)} data-testid="input-trigger-time" />
            </div>
          )}
          {formData.scheduleType === 'cron' && (
            <div className="space-y-2">
              <Label htmlFor="cronExpression">Cron Expression</Label>
              <Input id="cronExpression" value={String(formData.cronExpression || '')} onChange={(e) => handleChange('cronExpression', e.target.value)} placeholder="0 9 * * 1-5" data-testid="input-trigger-cron" />
            </div>
          )}
        </>
      )}

      {formData.triggerType === 'manual' && (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">This workflow can be triggered manually from the workflows page or via API.</p>
        </div>
      )}
    </>
  );
}
