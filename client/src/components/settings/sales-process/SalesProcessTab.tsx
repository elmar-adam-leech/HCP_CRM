import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Plus, Trash2, ArrowUp, ArrowDown, Phone, MessageSquare, Mail, CalendarDays, Zap, ListTodo, Check, ChevronsUpDown, X, Workflow } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useContact } from "@/hooks/useContact";
import { cn } from "@/lib/utils";
import type { Contact, SalesProcess, SalesProcessStep } from "@shared/schema";
import { leadStatusEnum, estimateStatusEnum } from "@shared/schema/enums";

const LEAD_STATUS_VALUES = leadStatusEnum.enumValues;
const ESTIMATE_STATUS_VALUES = estimateStatusEnum.enumValues;

type ActionType = 'call' | 'text' | 'email';
type StepMode = 'manual' | 'auto';
type TriggerType = 'lead_created' | 'lead_status_changed' | 'estimate_status_changed';

const LEAD_STATUSES = ['new', 'contacted', 'qualified', 'converted', 'disqualified', 'lost'] as const;
const ESTIMATE_STATUSES = ['sent', 'scheduled', 'in_progress', 'approved', 'rejected'] as const;

interface StepDraft {
  key: string;
  dayOffset: number;
  actionType: ActionType;
  mode: StepMode;
  messageTemplate: string;
  callScript: string;
  guidance: string;
}

interface CadenceListItem extends SalesProcess {
  triggerType: TriggerType;
  targetStatus: string | null;
  entityType: 'lead' | 'estimate';
}

interface CadenceResponse {
  process: CadenceListItem;
  steps: SalesProcessStep[];
}

const ACTION_ICON: Record<ActionType, typeof Phone> = { call: Phone, text: MessageSquare, email: Mail };

function newKey() { return Math.random().toString(36).slice(2); }
function toDraft(step: SalesProcessStep): StepDraft {
  return {
    key: step.id,
    dayOffset: step.dayOffset,
    actionType: step.actionType as ActionType,
    mode: step.mode as StepMode,
    messageTemplate: step.messageTemplate ?? '',
    callScript: step.callScript ?? '',
    guidance: step.guidance ?? '',
  };
}

function describeTrigger(c: Pick<CadenceListItem, 'triggerType' | 'targetStatus'>): string {
  if (c.triggerType === 'lead_created') return 'When a new lead is created';
  if (c.triggerType === 'lead_status_changed') return `When a lead's status changes to ${c.targetStatus}`;
  return `When an estimate's status changes to ${c.targetStatus}`;
}

export function SalesProcessTab() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: cadences = [], isLoading: isLoadingList } = useQuery<CadenceListItem[]>({
    queryKey: ['/api/sales-process/cadences'],
  });

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showNewDialog, setShowNewDialog] = useState(false);

  // Auto-select first cadence (or stay in sync if the selected cadence is deleted).
  useEffect(() => {
    if (cadences.length === 0) {
      setSelectedId(null);
      return;
    }
    if (!selectedId || !cadences.find(c => c.id === selectedId)) {
      setSelectedId(cadences[0].id);
    }
  }, [cadences, selectedId]);

  const createMutation = useMutation({
    mutationFn: async (input: { triggerType: TriggerType; targetStatus: string | null; name: string }) => {
      const body: Record<string, unknown> = { triggerType: input.triggerType, name: input.name || undefined };
      if (input.triggerType !== 'lead_created') body.targetStatus = input.targetStatus;
      const res = await apiRequest('POST', '/api/sales-process/cadences', body);
      return res.json() as Promise<CadenceListItem>;
    },
    onSuccess: (cadence) => {
      queryClient.invalidateQueries({ queryKey: ['/api/sales-process/cadences'] });
      setSelectedId(cadence.id);
      setShowNewDialog(false);
      toast({ title: 'Cadence created' });
    },
    onError: (err: Error) => {
      toast({ title: 'Could not create cadence', description: err.message, variant: 'destructive' });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest('DELETE', `/api/sales-process/cadences/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/sales-process/cadences'] });
      queryClient.invalidateQueries({ queryKey: ['/api/sales-process/tasks'] });
      setSelectedId(null);
      toast({ title: 'Cadence deleted' });
    },
    onError: (err: Error) => {
      toast({ title: 'Could not delete cadence', description: err.message, variant: 'destructive' });
    },
  });

  if (isLoadingList) {
    return <div className="text-sm text-muted-foreground" data-testid="sales-process-loading">Loading sales process…</div>;
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Sales process</CardTitle>
          <CardDescription>
            Create one or more cadences. Each cadence defines what happens (and when) after a specific trigger —
            for example, when a new lead comes in or when an estimate is approved.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-[16rem_1fr] gap-4">
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Label className="text-sm font-medium">Cadences</Label>
                <Dialog open={showNewDialog} onOpenChange={setShowNewDialog}>
                  <DialogTrigger asChild>
                    <Button size="sm" variant="outline" data-testid="button-new-cadence">
                      <Plus className="h-4 w-4 mr-1" /> New
                    </Button>
                  </DialogTrigger>
                  <NewCadenceDialog
                    onSubmit={(input) => createMutation.mutate(input)}
                    isPending={createMutation.isPending}
                  />
                </Dialog>
              </div>
              {cadences.length === 0 ? (
                <div className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground" data-testid="cadences-empty">
                  No cadences yet. Create one to get started.
                </div>
              ) : (
                <div className="space-y-1">
                  {cadences.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => setSelectedId(c.id)}
                      data-testid={`cadence-item-${c.id}`}
                      data-active={selectedId === c.id}
                      className={cn(
                        'w-full text-left rounded-md border p-3 hover-elevate active-elevate-2',
                        selectedId === c.id && 'bg-accent',
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="font-medium text-sm truncate flex-1">{c.name}</div>
                        <Badge variant={c.active ? 'default' : 'secondary'} className="shrink-0">
                          {c.active ? 'Active' : 'Off'}
                        </Badge>
                      </div>
                      <div className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
                        <Workflow className="h-3 w-3 shrink-0" />
                        <span className="truncate">{describeTrigger(c)}</span>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div>
              {selectedId ? (
                <CadenceEditor
                  key={selectedId}
                  cadenceId={selectedId}
                  onDelete={() => deleteMutation.mutate(selectedId)}
                  isDeleting={deleteMutation.isPending}
                />
              ) : (
                <div className="rounded-md border border-dashed p-12 text-center text-sm text-muted-foreground" data-testid="cadence-editor-empty">
                  {cadences.length === 0
                    ? 'Create your first cadence to start automating follow-ups.'
                    : 'Select a cadence on the left to edit it.'}
                </div>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

interface NewCadenceDialogProps {
  onSubmit: (input: { triggerType: TriggerType; targetStatus: string | null; name: string }) => void;
  isPending: boolean;
}

function NewCadenceDialog({ onSubmit, isPending }: NewCadenceDialogProps) {
  const [triggerType, setTriggerType] = useState<TriggerType>('lead_created');
  const [targetStatus, setTargetStatus] = useState<string>('new');
  const [name, setName] = useState('');

  const statusOptions =
    triggerType === 'lead_status_changed' ? LEAD_STATUSES :
    triggerType === 'estimate_status_changed' ? ESTIMATE_STATUSES :
    null;

  // Reset target_status when switching trigger family so a stale lead-status
  // doesn't accidentally get submitted with an estimate trigger.
  useEffect(() => {
    if (triggerType === 'lead_status_changed') setTargetStatus('new');
    else if (triggerType === 'estimate_status_changed') setTargetStatus('sent');
  }, [triggerType]);

  return (
    <DialogContent data-testid="dialog-new-cadence">
      <DialogHeader>
        <DialogTitle>New cadence</DialogTitle>
        <DialogDescription>
          Pick what should trigger this cadence. You can edit the name and steps after creating it.
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-4">
        <div className="space-y-1">
          <Label htmlFor="cadence-trigger">Trigger</Label>
          <Select value={triggerType} onValueChange={(v) => setTriggerType(v as TriggerType)}>
            <SelectTrigger id="cadence-trigger" data-testid="select-cadence-trigger">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="lead_created">New lead created</SelectItem>
              <SelectItem value="lead_status_changed">Lead status changes to…</SelectItem>
              <SelectItem value="estimate_status_changed">Estimate status changes to…</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {statusOptions && (
          <div className="space-y-1">
            <Label htmlFor="cadence-status">Target status</Label>
            <Select value={targetStatus} onValueChange={setTargetStatus}>
              <SelectTrigger id="cadence-status" data-testid="select-cadence-status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {statusOptions.map(s => (
                  <SelectItem key={s} value={s}>{s}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        <div className="space-y-1">
          <Label htmlFor="cadence-name">Name (optional)</Label>
          <Input
            id="cadence-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Auto-named based on the trigger"
            data-testid="input-cadence-name"
          />
        </div>
      </div>
      <DialogFooter>
        <Button
          onClick={() => onSubmit({
            triggerType,
            targetStatus: triggerType === 'lead_created' ? null : targetStatus,
            name: name.trim(),
          })}
          disabled={isPending}
          data-testid="button-create-cadence"
        >
          {isPending ? 'Creating…' : 'Create cadence'}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

interface CadenceEditorProps {
  cadenceId: string;
  onDelete: () => void;
  isDeleting: boolean;
}

function CadenceEditor({ cadenceId, onDelete, isDeleting }: CadenceEditorProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery<CadenceResponse>({
    queryKey: ['/api/sales-process/cadences', cadenceId],
  });

  const [name, setName] = useState('');
  const [active, setActive] = useState(false);
  const [steps, setSteps] = useState<StepDraft[]>([]);
  const [stopStatuses, setStopStatuses] = useState<string[]>([]);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (data && !hydrated) {
      setName(data.process.name);
      setActive(data.process.active);
      setSteps(data.steps.map(toDraft));
      setStopStatuses(data.process.stopStatuses ?? []);
      setHydrated(true);
    }
  }, [data, hydrated]);

  // Re-hydrate when cadence changes (parent passes key={cadenceId} so this
  // component remounts, but defensively reset on data id change too).
  useEffect(() => { setHydrated(false); }, [cadenceId]);

  const validation = useMemo(() => {
    const errors: Record<string, string> = {};
    const seen = new Set<string>();
    for (const s of steps) {
      if (!Number.isFinite(s.dayOffset) || s.dayOffset < 1) {
        errors[s.key] = 'Day must be 1 or greater.';
      } else if (s.dayOffset > 365) {
        errors[s.key] = 'Day must be 365 or less.';
      }
      const key = `${s.dayOffset}|${s.actionType}`;
      if (seen.has(key)) errors[s.key] = 'Duplicate of another step (same day + action).';
      seen.add(key);
      if (s.mode === 'auto' && s.actionType === 'call') {
        errors[s.key] = 'Calls cannot be set to auto.';
      }
      if (s.mode === 'auto' && s.actionType !== 'call' && s.messageTemplate.trim().length === 0) {
        errors[s.key] = 'Auto steps need a message template.';
      }
    }
    return errors;
  }, [steps]);

  const hasErrors = Object.keys(validation).length > 0;

  const SAMPLE_LEAD = {
    first_name: 'Jane', last_name: 'Smith',
    phone: '(555) 123-4567', email: 'jane.smith@example.com',
  } as const;

  const [selectedLeadId, setSelectedLeadId] = useState<string | null>(null);
  const { data: selectedLead, isLoading: selectedLeadLoading } = useContact(selectedLeadId);

  const previewLead = useMemo(() => {
    if (selectedLeadId && selectedLead) {
      const fullName = selectedLead.name ?? '';
      const space = fullName.indexOf(' ');
      const first_name = space >= 0 ? fullName.slice(0, space) : fullName;
      const last_name = space >= 0 ? fullName.slice(space + 1) : '';
      const createdAt = selectedLead.createdAt ? new Date(selectedLead.createdAt) : new Date();
      return {
        isSample: false,
        label: fullName || 'Selected lead',
        first_name, last_name,
        phone: selectedLead.phones?.[0] ?? '',
        email: selectedLead.emails?.[0] ?? '',
        createdAt,
      };
    }
    return {
      isSample: true,
      label: `${SAMPLE_LEAD.first_name} ${SAMPLE_LEAD.last_name}`,
      first_name: SAMPLE_LEAD.first_name, last_name: SAMPLE_LEAD.last_name,
      phone: SAMPLE_LEAD.phone, email: SAMPLE_LEAD.email,
      createdAt: new Date(),
    };
  }, [selectedLeadId, selectedLead]);

  const renderTemplate = (tpl: string) =>
    tpl
      .replace(/\{first_name\}/g, previewLead.first_name)
      .replace(/\{last_name\}/g, previewLead.last_name)
      .replace(/\{phone\}/g, previewLead.phone)
      .replace(/\{email\}/g, previewLead.email);

  const previewItems = useMemo(() => {
    const MS_PER_DAY = 24 * 60 * 60 * 1000;
    const ref = previewLead.createdAt.getTime();
    return steps.map((s, i) => ({
      idx: i + 1, step: s,
      dueAt: new Date(ref + Math.max(0, s.dayOffset) * MS_PER_DAY),
    }));
  }, [steps, previewLead]);

  const dateFmt = useMemo(
    () => new Intl.DateTimeFormat(undefined, {
      weekday: 'short', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit',
    }), [],
  );

  const saveMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest('PUT', `/api/sales-process/cadences/${cadenceId}`, {
        name,
        active,
        stopStatuses,
        steps: steps.map((s, i) => ({
          dayOffset: s.dayOffset,
          actionType: s.actionType,
          mode: s.mode,
          messageTemplate: s.actionType === 'call' ? null : (s.messageTemplate || null),
          callScript: s.actionType === 'call' ? (s.callScript || null) : null,
          guidance: s.guidance || null,
          displayOrder: i,
        })),
      });
      return res.json() as Promise<{
        process: CadenceListItem; steps: SalesProcessStep[];
        wasActivated: boolean;
        backfill: { leadsTouched: number; tasksCreated: number };
        backfillStarted?: boolean;
      }>;
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['/api/sales-process/cadences'] });
      queryClient.invalidateQueries({ queryKey: ['/api/sales-process/cadences', cadenceId] });
      queryClient.invalidateQueries({ queryKey: ['/api/sales-process/tasks'] });
      setHydrated(false);
      if (result.backfillStarted) {
        toast({ title: 'Cadence saved', description: 'Backfilling existing entities in the background…' });
      } else if (result.wasActivated && result.backfill.tasksCreated > 0) {
        toast({
          title: 'Cadence activated',
          description: `Scheduled ${result.backfill.tasksCreated} task(s) for ${result.backfill.leadsTouched} matching item(s).`,
        });
      } else {
        toast({ title: 'Cadence saved' });
      }
    },
    onError: (err: Error) => {
      toast({ title: 'Could not save', description: err.message, variant: 'destructive' });
    },
  });

  const addStep = () => {
    setSteps(prev => [
      ...prev,
      {
        key: newKey(),
        dayOffset: prev.length === 0 ? 1 : (prev[prev.length - 1].dayOffset + 3),
        actionType: 'call', mode: 'manual', messageTemplate: '',
        callScript: '', guidance: '',
      },
    ]);
  };
  const updateStep = (key: string, patch: Partial<StepDraft>) => {
    setSteps(prev => prev.map(s => s.key === key ? { ...s, ...patch } : s));
  };
  const removeStep = (key: string) => {
    setSteps(prev => prev.filter(s => s.key !== key));
  };
  const moveStep = (key: string, direction: -1 | 1) => {
    setSteps(prev => {
      const idx = prev.findIndex(s => s.key === key);
      if (idx < 0) return prev;
      const target = idx + direction;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[target]] = [next[target], next[idx]];
      return next;
    });
  };

  if (isLoading || !data) {
    return <div className="text-sm text-muted-foreground" data-testid="cadence-loading">Loading cadence…</div>;
  }

  const isLeadCadence = data.process.entityType === 'lead';

  return (
    <div className="space-y-4" data-testid={`cadence-editor-${cadenceId}`}>
      <div className="rounded-md border p-4 space-y-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex-1 min-w-[12rem] space-y-1">
            <Label htmlFor="cadence-edit-name" className="text-sm">Name</Label>
            <Input
              id="cadence-edit-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              data-testid="input-edit-cadence-name"
            />
            <p className="text-xs text-muted-foreground flex items-center gap-1">
              <Workflow className="h-3 w-3" />
              {describeTrigger(data.process)}
            </p>
          </div>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="Delete cadence" data-testid="button-delete-cadence">
                <Trash2 className="h-4 w-4" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete this cadence?</AlertDialogTitle>
                <AlertDialogDescription>
                  This permanently removes the cadence and its steps. Pending tasks already created from it
                  will remain on rep to-do lists; only future enrollments stop. This cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={onDelete}
                  disabled={isDeleting}
                  data-testid="button-confirm-delete-cadence"
                >
                  {isDeleting ? 'Deleting…' : 'Delete cadence'}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
        <div className="flex items-center justify-between gap-4 rounded-md border p-3">
          <div>
            <Label htmlFor="cadence-edit-active" className="text-base">Active</Label>
            <p className="text-sm text-muted-foreground">
              When on, matching {isLeadCadence ? 'leads' : 'estimates'} are enrolled automatically.
              Activating now also enrolls existing {isLeadCadence ? 'open leads' : 'open estimates'}.
            </p>
          </div>
          <Switch
            id="cadence-edit-active"
            checked={active}
            onCheckedChange={setActive}
            data-testid="switch-cadence-active"
          />
        </div>
        {/* Per-cadence early-stop multi-select (task #725). Implicit terminals
            (converted/disqualified/lost for leads; rejected for estimates)
            always stop the cadence — they're hidden from this picker and
            called out in the helper text below. */}
        <StopStatusesPicker
          entityType={isLeadCadence ? 'lead' : 'estimate'}
          value={stopStatuses}
          onChange={setStopStatuses}
        />
      </div>

      <div className="space-y-3">
        {steps.length === 0 && (
          <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground" data-testid="sales-process-empty">
            No steps yet. Add your first touchpoint below.
          </div>
        )}
        {steps.map((step, idx) => {
          const Icon = ACTION_ICON[step.actionType];
          const err = validation[step.key];
          const isFirst = idx === 0;
          const isLast = idx === steps.length - 1;
          return (
            <div key={step.key} className="rounded-md border p-4 space-y-3" data-testid={`step-row-${step.key}`}>
              <div className="flex items-center gap-3 flex-wrap">
                <div className="flex flex-col">
                  <Button variant="ghost" size="icon" onClick={() => moveStep(step.key, -1)} disabled={isFirst} aria-label="Move step up" data-testid={`button-move-up-${step.key}`}>
                    <ArrowUp className="h-4 w-4" />
                  </Button>
                  <Button variant="ghost" size="icon" onClick={() => moveStep(step.key, 1)} disabled={isLast} aria-label="Move step down" data-testid={`button-move-down-${step.key}`}>
                    <ArrowDown className="h-4 w-4" />
                  </Button>
                </div>
                <div className="flex items-center gap-2">
                  <Label htmlFor={`day-${step.key}`} className="text-sm whitespace-nowrap">Day</Label>
                  <Input
                    id={`day-${step.key}`}
                    type="number"
                    min={1}
                    max={365}
                    value={step.dayOffset}
                    onChange={(e) => updateStep(step.key, { dayOffset: Math.max(1, parseInt(e.target.value || '1', 10)) })}
                    className="w-20"
                    data-testid={`input-day-${step.key}`}
                  />
                </div>
                <div className="flex items-center gap-2">
                  <Icon className="h-4 w-4 text-muted-foreground" />
                  <Select
                    value={step.actionType}
                    onValueChange={(v) => updateStep(step.key, { actionType: v as ActionType, mode: v === 'call' ? 'manual' : step.mode })}
                  >
                    <SelectTrigger className="w-32" data-testid={`select-action-${step.key}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="call">Call</SelectItem>
                      <SelectItem value="text">Text</SelectItem>
                      <SelectItem value="email">Email</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-center gap-2">
                  <Label className="text-sm whitespace-nowrap">Mode</Label>
                  <Select
                    value={step.mode}
                    onValueChange={(v) => updateStep(step.key, { mode: v as StepMode })}
                    disabled={step.actionType === 'call'}
                  >
                    <SelectTrigger className="w-32" data-testid={`select-mode-${step.key}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="manual">Manual</SelectItem>
                      <SelectItem value="auto">Auto</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex-1" />
                <Button variant="ghost" size="icon" onClick={() => removeStep(step.key)} data-testid={`button-remove-${step.key}`}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
              {step.actionType !== 'call' && (
                <div className="space-y-1">
                  <Label htmlFor={`tpl-${step.key}`} className="text-sm">
                    Message template {step.mode === 'manual' && <span className="text-muted-foreground">(optional)</span>}
                  </Label>
                  <Textarea
                    id={`tpl-${step.key}`}
                    rows={3}
                    placeholder="Hi {first_name}, just checking in — let me know if you'd like to schedule a quote."
                    value={step.messageTemplate}
                    onChange={(e) => updateStep(step.key, { messageTemplate: e.target.value })}
                    className="resize-y border text-sm"
                    data-testid={`textarea-template-${step.key}`}
                  />
                  <p className="text-xs text-muted-foreground">
                    {step.mode === 'auto' ? 'Required for auto steps. ' : 'Optional starter text for the rep when they manually send. '}
                    Variables: <code>{'{first_name}'}</code>, <code>{'{last_name}'}</code>, <code>{'{phone}'}</code>, <code>{'{email}'}</code>
                  </p>
                </div>
              )}
              {step.actionType === 'call' && (
                <div className="space-y-1">
                  <Label htmlFor={`script-${step.key}`} className="text-sm">
                    Call script <span className="text-muted-foreground">(optional)</span>
                  </Label>
                  <Textarea
                    id={`script-${step.key}`}
                    rows={4}
                    placeholder="Hi {first_name}, this is [Your Name] calling about your HVAC quote request. Got a minute to walk through what you're looking for?"
                    value={step.callScript}
                    onChange={(e) => updateStep(step.key, { callScript: e.target.value })}
                    className="resize-y border text-sm"
                    data-testid={`textarea-call-script-${step.key}`}
                  />
                  <p className="text-xs text-muted-foreground">
                    Talk track shown to the rep on the Follow-Ups page when they click Call.
                  </p>
                </div>
              )}
              <div className="space-y-1">
                <Label htmlFor={`guidance-${step.key}`} className="text-sm">
                  Why this step <span className="text-muted-foreground">(optional)</span>
                </Label>
                <Textarea
                  id={`guidance-${step.key}`}
                  rows={2}
                  placeholder="Goal: confirm interest and lock in a site visit. Lead is still warm at this point."
                  value={step.guidance}
                  onChange={(e) => updateStep(step.key, { guidance: e.target.value })}
                  className="resize-y border text-sm"
                  data-testid={`textarea-guidance-${step.key}`}
                />
                <p className="text-xs text-muted-foreground">
                  Coaching note shown to the rep alongside the script on the Follow-Ups page.
                </p>
              </div>
              {err && (
                <p className="text-sm text-destructive" data-testid={`error-${step.key}`}>{err}</p>
              )}
            </div>
          );
        })}
      </div>

      {steps.length > 0 && isLeadCadence && (
        <div className="rounded-md border p-4 space-y-3" data-testid="card-cadence-preview">
          <div className="space-y-3">
            <div>
              <div className="text-base font-medium flex items-center gap-2">
                <CalendarDays className="h-4 w-4" />
                Preview cadence
              </div>
              <p className="text-sm text-muted-foreground mt-1">
                {previewLead.isSample
                  ? `Using sample lead ${previewLead.label} as if they came in right now. `
                  : `Using ${previewLead.label}'s real info and createdAt. `}
                Auto steps are sent automatically; manual steps appear as to-dos for your team.
              </p>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <Label className="text-sm whitespace-nowrap">Preview as</Label>
              <LeadPicker
                selectedLeadId={selectedLeadId}
                selectedLeadLabel={previewLead.isSample ? null : previewLead.label}
                isLoading={selectedLeadLoading}
                onSelect={setSelectedLeadId}
              />
              {selectedLeadId && (
                <Button variant="ghost" size="sm" onClick={() => setSelectedLeadId(null)} data-testid="button-use-sample-lead">
                  <X className="h-4 w-4 mr-1" />
                  Use sample lead
                </Button>
              )}
            </div>
          </div>
          <div>
            {hasErrors ? (
              <p className="text-sm text-muted-foreground" data-testid="preview-disabled">
                Fix the errors above to see the schedule preview.
              </p>
            ) : (
              <ol className="space-y-3">
                {previewItems.map(({ idx, step, dueAt }) => {
                  const Icon = ACTION_ICON[step.actionType];
                  const isAuto = step.mode === 'auto';
                  const rendered = renderTemplate(step.messageTemplate || '');
                  return (
                    <li key={step.key} className="flex gap-3 rounded-md border p-3" data-testid={`preview-item-${idx}`}>
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-medium text-muted-foreground">
                        {idx}
                      </div>
                      <div className="flex-1 min-w-0 space-y-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <Icon className="h-4 w-4 text-muted-foreground" />
                          <span className="text-sm font-medium capitalize">{step.actionType}</span>
                          <Badge variant={isAuto ? 'default' : 'secondary'} className="gap-1">
                            {isAuto ? <Zap className="h-3 w-3" /> : <ListTodo className="h-3 w-3" />}
                            {isAuto ? 'Sent automatically' : 'To-do for team'}
                          </Badge>
                          <span className="text-xs text-muted-foreground">Day {step.dayOffset}</span>
                        </div>
                        <div className="text-sm text-muted-foreground" data-testid={`preview-date-${idx}`}>
                          {dateFmt.format(dueAt)}
                        </div>
                        {step.actionType !== 'call' && rendered.trim().length > 0 && (
                          <div className="mt-1 whitespace-pre-wrap rounded border bg-muted/40 p-2 text-sm" data-testid={`preview-message-${idx}`}>
                            {rendered}
                          </div>
                        )}
                        {step.actionType !== 'call' && rendered.trim().length === 0 && step.mode === 'manual' && (
                          <p className="text-xs text-muted-foreground italic">
                            No starter message — rep will compose when sending.
                          </p>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
        </div>
      )}

      <div className="flex items-center justify-between gap-2">
        <Button variant="outline" onClick={addStep} data-testid="button-add-step">
          <Plus className="h-4 w-4 mr-1" /> Add step
        </Button>
        <Button
          onClick={() => saveMutation.mutate()}
          disabled={hasErrors || saveMutation.isPending}
          data-testid="button-save-process"
        >
          {saveMutation.isPending ? 'Saving…' : 'Save changes'}
        </Button>
      </div>
    </div>
  );
}

interface LeadPickerProps {
  selectedLeadId: string | null;
  selectedLeadLabel: string | null;
  isLoading?: boolean;
  onSelect: (id: string) => void;
}

function LeadPicker({ selectedLeadId, selectedLeadLabel, isLoading, onSelect }: LeadPickerProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 250);
    return () => clearTimeout(t);
  }, [search]);

  const { data: leads = [], isLoading: isLoadingLeads } = useQuery<Contact[]>({
    queryKey: ['/api/contacts/paginated', { type: 'lead', search: debounced, limit: 20, includeAll: true }],
    queryFn: async () => {
      const params = new URLSearchParams({ type: 'lead', limit: '20', includeAll: 'true' });
      if (debounced) params.set('search', debounced);
      const result = await (await apiRequest('GET', `/api/contacts/paginated?${params}`)).json();
      return (result.data ?? []) as Contact[];
    },
    enabled: open,
  });

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-72 justify-between"
          data-testid="button-select-preview-lead"
        >
          <span className="truncate">
            {selectedLeadId
              ? (selectedLeadLabel ?? (isLoading ? 'Loading selected lead…' : 'Selected lead'))
              : 'Use sample lead'}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search leads by name, email, or phone…"
            value={search}
            onValueChange={setSearch}
            data-testid="input-search-preview-lead"
          />
          <CommandList>
            <CommandEmpty>
              <div className="p-2 text-sm text-muted-foreground">
                {isLoadingLeads ? 'Loading…' : 'No leads found.'}
              </div>
            </CommandEmpty>
            <CommandGroup>
              {leads.map((lead) => (
                <CommandItem
                  key={lead.id}
                  value={lead.id}
                  onSelect={() => {
                    onSelect(lead.id);
                    setOpen(false);
                    setSearch('');
                  }}
                  data-testid={`option-preview-lead-${lead.id}`}
                >
                  <Check className={cn('mr-2 h-4 w-4', selectedLeadId === lead.id ? 'opacity-100' : 'opacity-0')} />
                  <div className="flex flex-col flex-1 min-w-0">
                    <span className="truncate text-sm">{lead.name}</span>
                    <span className="text-xs text-muted-foreground truncate">
                      {lead.emails?.[0] || lead.phones?.[0] || 'No contact info'}
                    </span>
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

// ── Per-cadence early-stop multi-select (task #725) ─────────────────────────
// Implicit terminals always stop the cadence and are intentionally hidden
// from the picker (lead: converted/disqualified/lost, estimate: rejected).
// Status lists derive from the shared pgEnum so the UI can not drift.
const LEAD_IMPLICIT_TERMINALS = new Set(['converted', 'disqualified', 'lost']);
const ESTIMATE_IMPLICIT_TERMINALS = new Set(['rejected']);
const LEAD_STOP_OPTIONS = LEAD_STATUS_VALUES.filter((s) => !LEAD_IMPLICIT_TERMINALS.has(s));
const ESTIMATE_STOP_OPTIONS = ESTIMATE_STATUS_VALUES.filter((s) => !ESTIMATE_IMPLICIT_TERMINALS.has(s));

interface StopStatusesPickerProps {
  entityType: 'lead' | 'estimate';
  value: string[];
  onChange: (next: string[]) => void;
}

function StopStatusesPicker({ entityType, value, onChange }: StopStatusesPickerProps) {
  const options = entityType === 'lead' ? LEAD_STOP_OPTIONS : ESTIMATE_STOP_OPTIONS;
  const helper = entityType === 'lead'
    ? 'We always stop on Converted, Disqualified, and Lost — you can stop earlier here.'
    : 'We always stop on Rejected — you can stop earlier here.';
  const toggle = (status: string) => {
    if (value.includes(status)) onChange(value.filter(s => s !== status));
    else onChange([...value, status]);
  };
  return (
    <div className="rounded-md border p-3 space-y-2" data-testid="stop-statuses-picker">
      <div>
        <Label className="text-base">Stop process when status becomes…</Label>
        <p className="text-sm text-muted-foreground">{helper}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        {options.map((status) => {
          const selected = value.includes(status);
          return (
            <Badge
              key={status}
              variant={selected ? 'default' : 'outline'}
              className={cn(
                'cursor-pointer toggle-elevate',
                selected && 'toggle-elevated',
              )}
              onClick={() => toggle(status)}
              data-testid={`stop-status-chip-${status}`}
              data-selected={selected}
            >
              {selected && <Check className="h-3 w-3 mr-1" />}
              {status}
            </Badge>
          );
        })}
      </div>
    </div>
  );
}
