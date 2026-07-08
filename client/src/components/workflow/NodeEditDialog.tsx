import { useState, useEffect } from 'react';
import { Node } from 'reactflow';
import { useQuery } from '@tanstack/react-query';
import { apiRequest } from '@/lib/queryClient';
import { useTerminologyContext } from '@/contexts/TerminologyContext';
import { useUsers } from '@/hooks/useUsers';
import { useAvailableFromNumbers } from '@/hooks/useAvailableFromNumbers';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Trash2 } from 'lucide-react';
import { useCurrentUser, isAdminUser } from '@/hooks/useCurrentUser';
import { buildTriggerLabel } from '@/lib/workflow-utils';
import { TriggerNodeForm } from './node-forms/TriggerNodeForm';
import { SendEmailNodeForm } from './node-forms/SendEmailNodeForm';
import { SendSmsNodeForm } from './node-forms/SendSmsNodeForm';
import { NotificationNodeForm } from './node-forms/NotificationNodeForm';
import { UpdateEntityNodeForm } from './node-forms/UpdateEntityNodeForm';
import { AssignUserNodeForm } from './node-forms/AssignUserNodeForm';
import { ConditionalNodeForm } from './node-forms/ConditionalNodeForm';
import { DelayNodeForm } from './node-forms/DelayNodeForm';
import { WaitUntilNodeForm } from './node-forms/WaitUntilNodeForm';
import { SetFollowUpNodeForm } from './node-forms/SetFollowUpNodeForm';

type NodeEditDialogProps = {
  node: Node | null;
  open: boolean;
  onClose: () => void;
  onSave: (nodeId: string, newData: Record<string, unknown>) => void;
  onDelete?: (nodeId: string) => void;
  /** The workflow creator's user id — their default From number is what an SMS step falls back to. Omitted for unsaved workflows (current user is the creator). */
  workflowCreatorId?: string;
};

export type ResolvedDefaultFromNumber = {
  fromNumber?: string;
  displayName?: string;
  error?: string;
};

export default function NodeEditDialog({ node, open, onClose, onSave, onDelete, workflowCreatorId }: NodeEditDialogProps) {
  const [formData, setFormData] = useState<Record<string, unknown>>({});
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const { data: currentUser } = useCurrentUser();
  const isAdmin = isAdminUser(currentUser?.user?.role);

  const { data: gmailUsers = [] } = useQuery<Array<{ id: string; name: string; email: string }>>({
    queryKey: ['/api/users/gmail-connected'],
    enabled: isAdmin && open,
  });

  // Provider-agnostic picker source — merges numbers from every enabled
  // calling/texting integration (Dialpad, Twilio, ...), task #902.
  const { data: phoneNumbers = [] } = useAvailableFromNumbers('sms', isAdmin && open);

  // Task #905: show which number "Use workflow creator's default" actually
  // resolves to, using the same provider-aware logic as the send path.
  const { data: resolvedDefault, isLoading: resolvedDefaultLoading } = useQuery<ResolvedDefaultFromNumber>({
    queryKey: ['/api/workflows/resolved-default-from-number', workflowCreatorId ?? 'self'],
    queryFn: async () => {
      const qs = workflowCreatorId ? `?creatorId=${encodeURIComponent(workflowCreatorId)}` : '';
      const response = await apiRequest('GET', `/api/workflows/resolved-default-from-number${qs}`);
      return response.json();
    },
    enabled: isAdmin && open && node?.type === 'sendSMS',
  });

  // Shared hooks — share cache entries across the whole app
  const { data: usersData = [] } = useUsers();
  const teamUsers = usersData.map(u => ({ id: u.id, name: u.name, email: '' }));

  const terminology = useTerminologyContext();

  useEffect(() => {
    if (node) { setFormData(node.data || {}); }
  }, [node]);

  const handleChange = (field: string, value: unknown) => {
    setFormData(prev => {
      const newData = { ...prev, [field]: value };
      if (node?.type === 'trigger' && (field === 'entityType' || field === 'eventType' || field === 'targetStatus')) {
        const entity = String(field === 'entityType' ? value : (prev.entityType || 'lead'));
        const event = String(field === 'eventType' ? value : (prev.eventType || 'created'));
        const targetStatus = String(field === 'targetStatus' ? value : (prev.targetStatus || ''));
        newData.label = buildTriggerLabel(entity, event, targetStatus || undefined, terminology);
      }
      return newData;
    });
  };

  const handleSave = () => {
    if (node) { onSave(node.id, formData); onClose(); }
  };

  const handleDelete = () => {
    if (node && onDelete) { setShowDeleteConfirm(true); }
  };

  if (!node) return null;

  const renderFields = () => {
    const nodeType = node.type;
    const entityType = (formData.entityType as "lead" | "estimate" | "job" | "customer") || "lead";

    switch (nodeType) {
      case 'trigger':
        return <TriggerNodeForm formData={formData} handleChange={handleChange} terminology={terminology} />;
      case 'sendEmail':
        return <SendEmailNodeForm formData={formData} handleChange={handleChange} entityType={entityType} isAdmin={isAdmin} gmailUsers={gmailUsers} />;
      case 'sendSMS':
        return <SendSmsNodeForm formData={formData} handleChange={handleChange} entityType={entityType} isAdmin={isAdmin} phoneNumbers={phoneNumbers} resolvedDefault={resolvedDefault} resolvedDefaultLoading={resolvedDefaultLoading} />;
      case 'notification':
        return <NotificationNodeForm formData={formData} handleChange={handleChange} entityType={entityType} />;
      case 'updateEntity':
        return <UpdateEntityNodeForm formData={formData} handleChange={handleChange} setFormData={setFormData} terminology={terminology} />;
      case 'assignUser':
        return <AssignUserNodeForm formData={formData} handleChange={handleChange} isAdmin={isAdmin} teamUsers={teamUsers} />;
      case 'setFollowUp':
        return <SetFollowUpNodeForm formData={formData} handleChange={handleChange} entityType={entityType} />;
      case 'conditional':
        return <ConditionalNodeForm formData={formData} handleChange={handleChange} />;
      case 'delay':
        return <DelayNodeForm formData={formData} handleChange={handleChange} />;
      case 'waitUntil':
        return <WaitUntilNodeForm formData={formData} handleChange={handleChange} />;
      default:
        return <div className="text-muted-foreground">No editable properties for this node type.</div>;
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onClose}>
        <DialogContent data-testid="dialog-node-edit">
          <DialogHeader>
            <DialogTitle>Edit Node</DialogTitle>
            <DialogDescription>Configure the properties for this workflow node.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            {renderFields()}
          </div>
          <DialogFooter className="flex justify-between items-center">
            <div>
              {onDelete && (
                <Button variant="destructive" onClick={handleDelete} data-testid="button-delete-node">
                  <Trash2 className="h-4 w-4 mr-2" />Delete Node
                </Button>
              )}
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={onClose} data-testid="button-cancel-edit">Cancel</Button>
              <Button onClick={handleSave} data-testid="button-save-edit">Save Changes</Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Node</AlertDialogTitle>
            <AlertDialogDescription>Are you sure you want to delete this node? This action cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete-node">Cancel</AlertDialogCancel>
            <AlertDialogAction data-testid="button-confirm-delete-node" onClick={() => {
              if (node && onDelete) { onDelete(node.id); onClose(); }
              setShowDeleteConfirm(false);
            }}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
