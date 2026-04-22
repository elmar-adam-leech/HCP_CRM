import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Trash2, ArrowUp, ArrowDown, Phone, MessageSquare, Mail, CalendarDays, Zap, ListTodo } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { SalesProcess, SalesProcessStep } from "@shared/schema";

type ActionType = 'call' | 'text' | 'email';
type StepMode = 'manual' | 'auto';

interface StepDraft {
  key: string;
  dayOffset: number;
  actionType: ActionType;
  mode: StepMode;
  messageTemplate: string;
}

interface ProcessResponse {
  process: SalesProcess;
  steps: SalesProcessStep[];
}

const ACTION_ICON: Record<ActionType, typeof Phone> = { call: Phone, text: MessageSquare, email: Mail };

function newKey() {
  return Math.random().toString(36).slice(2);
}

function toDraft(step: SalesProcessStep): StepDraft {
  return {
    key: step.id,
    dayOffset: step.dayOffset,
    actionType: step.actionType as ActionType,
    mode: step.mode as StepMode,
    messageTemplate: step.messageTemplate ?? '',
  };
}

export function SalesProcessTab() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery<ProcessResponse>({ queryKey: ['/api/sales-process'] });

  const [active, setActive] = useState(false);
  const [steps, setSteps] = useState<StepDraft[]>([]);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (data && !hydrated) {
      setActive(data.process.active);
      setSteps(data.steps.map(toDraft));
      setHydrated(true);
    }
  }, [data, hydrated]);

  const validation = useMemo(() => {
    const errors: Record<string, string> = {};
    const seen = new Set<string>();
    for (const s of steps) {
      // Day must be a positive integer per spec — Day 0 is the lead's
      // initial creation moment, not a cadence touchpoint. Mirroring the
      // server-side Zod rule keeps form errors immediate (no round-trip).
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

  // Preview: "If a lead came in today, here's what would happen."
  // Mirrors server's computeDueAt (createdAt + dayOffset days, preserving
  // time-of-day) so managers see exactly when each touchpoint fires before
  // they save. The reference `now` is captured when steps change (not on
  // every render); managers are reading calendar-day granularity, so a few
  // minutes of drift while the panel sits open doesn't matter. We don't
  // tick on a timer — this is a sanity-check preview, not a live clock.
  const SAMPLE_LEAD = {
    first_name: 'Jane',
    last_name: 'Smith',
    phone: '(555) 123-4567',
    email: 'jane.smith@example.com',
  } as const;

  const renderTemplate = (tpl: string) =>
    tpl
      .replace(/\{first_name\}/g, SAMPLE_LEAD.first_name)
      .replace(/\{last_name\}/g, SAMPLE_LEAD.last_name)
      .replace(/\{phone\}/g, SAMPLE_LEAD.phone)
      .replace(/\{email\}/g, SAMPLE_LEAD.email);

  const previewItems = useMemo(() => {
    const now = new Date();
    const MS_PER_DAY = 24 * 60 * 60 * 1000;
    return steps.map((s, i) => ({
      idx: i + 1,
      step: s,
      dueAt: new Date(now.getTime() + Math.max(0, s.dayOffset) * MS_PER_DAY),
    }));
  }, [steps]);

  const dateFmt = useMemo(
    () => new Intl.DateTimeFormat(undefined, {
      weekday: 'short', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit',
    }),
    [],
  );

  const saveMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest('PUT', '/api/sales-process', {
        active,
        steps: steps.map((s, i) => ({
          dayOffset: s.dayOffset,
          actionType: s.actionType,
          mode: s.mode,
          messageTemplate: s.actionType === 'call' ? null : (s.messageTemplate || null),
          displayOrder: i,
        })),
      });
      return res.json() as Promise<{
        process: SalesProcess;
        steps: SalesProcessStep[];
        wasActivated: boolean;
        backfill: { leadsTouched: number; tasksCreated: number };
      }>;
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['/api/sales-process'] });
      queryClient.invalidateQueries({ queryKey: ['/api/sales-process/tasks'] });
      setHydrated(false); // re-pull canonical state from server
      if (result.wasActivated && result.backfill.tasksCreated > 0) {
        toast({
          title: 'Sales process activated',
          description: `Scheduled ${result.backfill.tasksCreated} task(s) for ${result.backfill.leadsTouched} open lead(s).`,
        });
      } else {
        toast({ title: 'Sales process saved' });
      }
    },
    onError: (err: Error) => {
      toast({ title: 'Could not save', description: err.message, variant: 'destructive' });
    },
  });

  const addStep = () => {
    setSteps(prev => [
      ...prev,
      // First step defaults to Day 1 (the spec requires positive day
      // offsets — Day 0 isn't a cadence touchpoint, it's the initial
      // outreach). Each subsequent step suggests +3 days from the last.
      {
        key: newKey(),
        dayOffset: prev.length === 0 ? 1 : (prev[prev.length - 1].dayOffset + 3),
        actionType: 'call',
        mode: 'manual',
        messageTemplate: '',
      },
    ]);
  };

  const updateStep = (key: string, patch: Partial<StepDraft>) => {
    setSteps(prev => prev.map(s => s.key === key ? { ...s, ...patch } : s));
  };

  const removeStep = (key: string) => {
    setSteps(prev => prev.filter(s => s.key !== key));
  };

  // Steps are kept in user-controlled order in `steps`; the visible order
  // matches that array directly so reorder controls (move up / move down)
  // produce predictable results. We do NOT auto-sort by dayOffset because
  // managers may want to express ordering intent independent of the day
  // numbers themselves (e.g. two same-day actions). The server normalizes
  // displayOrder from the request order on save.
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

  if (isLoading) {
    return <div className="text-sm text-muted-foreground" data-testid="sales-process-loading">Loading sales process…</div>;
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Sales process</CardTitle>
          <CardDescription>
            Define your follow-up cadence — what happens on day 1, day 4, day 7, etc. for every new lead.
            Manual steps appear as to-dos for your team. Auto steps are sent automatically by the system.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between gap-4 rounded-md border p-4">
            <div>
              <Label htmlFor="sp-active" className="text-base">Process active</Label>
              <p className="text-sm text-muted-foreground">
                When on, every new lead is enrolled. Activating now also enrolls existing open leads (won/lost leads are skipped).
              </p>
            </div>
            <Switch
              id="sp-active"
              checked={active}
              onCheckedChange={setActive}
              data-testid="switch-process-active"
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
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => moveStep(step.key, -1)}
                        disabled={isFirst}
                        aria-label="Move step up"
                        data-testid={`button-move-up-${step.key}`}
                      >
                        <ArrowUp className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => moveStep(step.key, 1)}
                        disabled={isLast}
                        aria-label="Move step down"
                        data-testid={`button-move-down-${step.key}`}
                      >
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
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => removeStep(step.key)}
                      data-testid={`button-remove-${step.key}`}
                    >
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
                        {step.mode === 'auto'
                          ? 'Required for auto steps. '
                          : 'Optional starter text for the rep when they manually send. '}
                        Variables: <code>{'{first_name}'}</code>, <code>{'{last_name}'}</code>, <code>{'{phone}'}</code>, <code>{'{email}'}</code>
                      </p>
                    </div>
                  )}
                  {err && (
                    <p className="text-sm text-destructive" data-testid={`error-${step.key}`}>{err}</p>
                  )}
                </div>
              );
            })}
          </div>

          {steps.length > 0 && (
            <div className="rounded-md border p-4 space-y-3" data-testid="card-cadence-preview">
              <div>
                <div className="text-base font-medium flex items-center gap-2">
                  <CalendarDays className="h-4 w-4" />
                  Preview: if a lead came in today
                </div>
                <p className="text-sm text-muted-foreground mt-1">
                  Sample lead {SAMPLE_LEAD.first_name} {SAMPLE_LEAD.last_name}. Auto steps are sent automatically; manual steps appear as to-dos for your team.
                </p>
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
                        <li
                          key={step.key}
                          className="flex gap-3 rounded-md border p-3"
                          data-testid={`preview-item-${idx}`}
                        >
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
                            <div
                              className="text-sm text-muted-foreground"
                              data-testid={`preview-date-${idx}`}
                            >
                              {dateFmt.format(dueAt)}
                            </div>
                            {step.actionType !== 'call' && rendered.trim().length > 0 && (
                              <div
                                className="mt-1 whitespace-pre-wrap rounded border bg-muted/40 p-2 text-sm"
                                data-testid={`preview-message-${idx}`}
                              >
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
        </CardContent>
      </Card>
    </div>
  );
}
