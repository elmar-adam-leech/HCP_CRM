import { useState, useEffect } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { useWebSocketContext } from '@/contexts/WebSocketContext';
import { useRoute, useSearch } from 'wouter';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  CheckCircle2,
  XCircle,
  Clock,
  ArrowLeft,
  Calendar,
  AlertCircle,
  ChevronDown,
  ChevronRight,
  SkipForward,
  UserX,
  Hourglass,
  HelpCircle,
} from 'lucide-react';
import { formatDistanceToNow, differenceInHours, differenceInMinutes } from 'date-fns';
import { Link } from 'wouter';
import { PageLayout } from '@/components/ui/page-layout';
import { apiRequest } from '@/lib/queryClient';
import { useToast } from '@/hooks/use-toast';
import type { Workflow } from '@/types/workflow';

type StepLog = {
  stepId: string;
  stepOrder: number;
  actionType: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  status: 'success' | 'failed' | 'skipped';
  result?: unknown;
  error?: string;
};

type WorkflowExecution = {
  id: string;
  workflowId: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'suspended' | 'cancelled';
  triggeredBy: 'manual' | 'entity_event' | 'time_based';
  triggerData: Record<string, unknown>;
  errorMessage: string | null;
  startedAt: string;
  completedAt: string | null;
  currentStep: number | null;
  resumeAt: string | null;
  stepLogs: StepLog[];
  contactName: string | null;
  contactEmail: string | null;
};

type DispatchDecision = {
  id: string;
  createdAt: string;
  entityId: string | null;
  entityName: string | null;
  // 'contact' | 'estimate' | 'job' — drives the deep-link target for the entity name.
  entityType: string | null;
  // Full event type, e.g. 'contact_created', 'estimate_status_changed', 'job_paid'.
  eventType: string | null;
  status: 'matched' | 'skipped';
  reason: string | null;
  targetStatus: string | null;
  executionId: string | null;
};

/**
 * Turn the raw event identifier into a short label rendered next to each
 * decision row. Keeping this human ("Status changed", "Estimate created")
 * means the trigger-decisions list reads naturally even when a workflow
 * listens to several event types.
 */
function formatEventType(eventType: string | null): string {
  if (!eventType) return 'Event';
  switch (eventType) {
    case 'contact_created':         return 'Contact created';
    case 'contact_updated':         return 'Contact updated';
    case 'contact_status_changed':  return 'Status changed';
    case 'estimate_created':        return 'Estimate created';
    case 'estimate_updated':        return 'Estimate updated';
    case 'estimate_status_changed': return 'Estimate status changed';
    case 'job_created':             return 'Job created';
    case 'job_updated':             return 'Job updated';
    case 'job_status_changed':      return 'Job status changed';
    case 'job_paid':                return 'Job paid';
    default:
      return eventType.replace(/_/g, ' ');
  }
}

/**
 * Build the link target for the decision's entity name. Estimates and jobs
 * don't have per-record routes today, so we fall back to the list page.
 */
function entityHref(entityType: string | null, entityId: string | null): string | null {
  if (!entityId) return null;
  switch (entityType) {
    case 'estimate': return '/estimates';
    case 'job':      return '/jobs';
    case 'contact':
    default:         return `/contacts?id=${entityId}`;
  }
}

/**
 * Translate a machine-readable skip reason from the trigger-matcher audit log
 * into a sentence a contractor can act on.
 *
 * Reasons come in two shapes:
 *   - simple keys: 'entity_mismatch', 'event_mismatch', 'entity_type_not_lead', 'tag_mismatch'
 *   - status-mismatch with payload: 'target_status_mismatch:expected=scheduled,got=new'
 *
 * If a future reason is added on the backend that isn't translated here we fall
 * back to a humanized version of the raw key — the operator still sees signal,
 * just without the polished copy.
 */
function humanizeSkipReason(reason: string): string {
  if (reason.startsWith('target_status_mismatch:')) {
    const payload = reason.slice('target_status_mismatch:'.length);
    const expectedMatch = payload.match(/expected=([^,]*)/);
    const gotMatch = payload.match(/got=([^,]*)/);
    const expected = expectedMatch ? expectedMatch[1] : '';
    const got = gotMatch ? gotMatch[1] : '';
    return `Status was '${got || 'unknown'}' instead of '${expected || 'expected status'}'`;
  }
  switch (reason) {
    case 'entity_mismatch':
      return 'Trigger is configured for a different entity type';
    case 'event_mismatch':
      return 'Trigger is configured for a different event';
    case 'entity_type_not_lead':
      return 'Contact is not a lead, but the trigger only fires for leads';
    case 'tag_mismatch':
      return "Contact doesn't have any of the required tags";
    default:
      return reason.replace(/_/g, ' ');
  }
}

type ConditionDiagnostic = {
  result?: boolean;
  field?: string;
  operator?: string;
  target?: unknown;
  resolvedValue?: unknown;
  resolvedValueType?: string;
  truncated?: boolean;
  note?: string;
};

/**
 * Render a value (resolved field value or comparison target) in a way that's
 * unambiguous in the timeline summary line: arrays as JSON, strings quoted,
 * undefined/null spelled out so operators don't confuse them with empty
 * strings.
 */
function formatDiagnosticValue(v: unknown): string {
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v) || typeof v === 'object') {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

function formatActionType(actionType: string): string {
  return actionType
    .split('_')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function formatWaitDuration(resumeAt: string): string {
  const now = new Date();
  const resume = new Date(resumeAt);
  if (resume <= now) return 'Resuming soon';
  const hours = differenceInHours(resume, now);
  const minutes = differenceInMinutes(resume, now) % 60;
  if (hours > 0) return `Waiting ${hours}h ${minutes}m`;
  return `Waiting ${minutes}m`;
}

export default function WorkflowExecutions() {
  const [, params] = useRoute('/workflows/:id/executions');
  const workflowId = params?.id || null;
  const search = useSearch();
  // Allow deep-linking to a specific execution (e.g. from the trigger-decisions tab):
  // /workflows/:id/executions?execution=<executionId> opens the History tab and
  // expands that execution's step timeline.
  const targetExecutionId = new URLSearchParams(search).get('execution');
  const [expandedId, setExpandedId] = useState<string | null>(targetExecutionId);
  const [activeTab, setActiveTab] = useState<string>(targetExecutionId ? 'history' : 'active');
  useEffect(() => {
    if (targetExecutionId) {
      setExpandedId(targetExecutionId);
      setActiveTab('history');
    }
  }, [targetExecutionId]);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: workflow, isLoading: workflowLoading } = useQuery<Workflow>({
    queryKey: ['/api/workflows', workflowId],
    enabled: !!workflowId,
  });

  const { data: historyExecutions, isLoading: historyLoading } = useQuery<WorkflowExecution[]>({
    queryKey: ['/api/workflows', workflowId, 'executions', 'history'],
    queryFn: () => fetch(`/api/workflows/${workflowId}/executions?status=completed&status=failed&status=cancelled&limit=50`).then(r => r.json()),
    enabled: !!workflowId,
  });

  const { data: activeExecutions, isLoading: activeLoading } = useQuery<WorkflowExecution[]>({
    queryKey: ['/api/workflows', workflowId, 'executions', 'active'],
    queryFn: () => fetch(`/api/workflows/${workflowId}/executions?status=running&status=suspended&status=pending&limit=100`).then(r => r.json()),
    enabled: !!workflowId,
    refetchInterval: 15000,
  });

  const { data: dispatchDecisions, isLoading: decisionsLoading } = useQuery<DispatchDecision[]>({
    queryKey: ['/api/workflows', workflowId, 'dispatch-decisions'],
    enabled: !!workflowId,
    refetchInterval: 30000,
  });

  // Once history data is loaded, scroll the targeted execution into view so the
  // deep link from the trigger-decisions tab surfaces the right row.
  useEffect(() => {
    if (!targetExecutionId || activeTab !== 'history') return;
    const el = document.querySelector(`[data-testid="card-execution-${targetExecutionId}"]`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [targetExecutionId, activeTab, historyExecutions]);

  const cancelMutation = useMutation({
    mutationFn: (executionId: string) =>
      apiRequest('POST', `/api/workflow-executions/${executionId}/cancel`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/workflows', workflowId, 'executions', 'active'] });
      queryClient.invalidateQueries({ queryKey: ['/api/workflows', workflowId, 'executions', 'history'] });
      toast({ title: 'Enrollment stopped', description: 'The contact has been removed from this workflow.' });
    },
    onError: () => {
      toast({ title: 'Failed to stop enrollment', variant: 'destructive' });
    },
  });

  const { subscribe } = useWebSocketContext();
  useEffect(() => {
    if (!workflowId) return;
    const unsubscribe = subscribe((message: { type: string; workflowId?: string }) => {
      if (
        ['workflow_started', 'workflow_completed', 'workflow_failed'].includes(message.type) &&
        (!message.workflowId || message.workflowId === workflowId)
      ) {
        queryClient.invalidateQueries({ queryKey: ['/api/workflows', workflowId, 'executions', 'active'] });
        queryClient.invalidateQueries({ queryKey: ['/api/workflows', workflowId, 'executions', 'history'] });
      }
    });
    return unsubscribe;
  }, [subscribe, queryClient, workflowId]);

  if (!workflowId) {
    return (
      <PageLayout>
        <div className="flex items-center justify-center h-full">
          <Card className="p-6">
            <p className="text-muted-foreground">Invalid workflow ID</p>
          </Card>
        </div>
      </PageLayout>
    );
  }

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'completed':
        return <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />;
      case 'failed':
        return <XCircle className="h-4 w-4 text-destructive" />;
      case 'running':
        return <Clock className="h-4 w-4 text-blue-600 dark:text-blue-400" />;
      case 'suspended':
        return <Hourglass className="h-4 w-4 text-amber-600 dark:text-amber-400" />;
      case 'cancelled':
        return <UserX className="h-4 w-4 text-muted-foreground" />;
      default:
        return <AlertCircle className="h-4 w-4 text-muted-foreground" />;
    }
  };

  const getStatusBadge = (status: string) => {
    const variants: Record<string, 'default' | 'destructive' | 'secondary' | 'outline'> = {
      completed: 'default',
      failed: 'destructive',
      running: 'secondary',
      suspended: 'secondary',
      cancelled: 'outline',
    };

    return (
      <Badge variant={variants[status] ?? 'secondary'} className="text-xs">
        {status}
      </Badge>
    );
  };

  const getStepIcon = (status: 'success' | 'failed' | 'skipped') => {
    if (status === 'success') {
      return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />;
    }
    if (status === 'skipped') {
      return <SkipForward className="h-3.5 w-3.5 text-muted-foreground shrink-0" />;
    }
    return <XCircle className="h-3.5 w-3.5 text-destructive shrink-0" />;
  };

  const renderActiveRow = (execution: WorkflowExecution) => {
    const isCancelling = cancelMutation.isPending && cancelMutation.variables === execution.id;
    const displayName = execution.contactName || execution.contactEmail || `Enrollment #${execution.id.slice(0, 8)}`;
    const isSuspended = execution.status === 'suspended';

    return (
      <Card key={execution.id} data-testid={`card-active-${execution.id}`}>
        <CardContent className="py-4">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-3 min-w-0">
              {getStatusIcon(execution.status)}
              <div className="min-w-0">
                <p className="font-medium truncate">{displayName}</p>
                {execution.contactEmail && execution.contactName && (
                  <p className="text-xs text-muted-foreground truncate">{execution.contactEmail}</p>
                )}
              </div>
            </div>
            <div className="flex items-center gap-4 flex-wrap">
              <div className="text-sm text-right">
                {execution.currentStep !== null && (
                  <p className="text-muted-foreground">Step {execution.currentStep}</p>
                )}
                {isSuspended && execution.resumeAt ? (
                  <p className="text-amber-600 dark:text-amber-400 text-xs font-medium">
                    {formatWaitDuration(execution.resumeAt)}
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">{execution.status}</p>
                )}
              </div>
              <div className="text-sm text-right">
                <p className="text-muted-foreground text-xs">Enrolled</p>
                <p className="text-xs">
                  {execution.startedAt
                    ? formatDistanceToNow(new Date(execution.startedAt), { addSuffix: true })
                    : '—'}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                data-testid={`button-stop-${execution.id}`}
                disabled={isCancelling}
                onClick={() => cancelMutation.mutate(execution.id)}
              >
                {isCancelling ? 'Stopping…' : 'Stop'}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  };

  const renderHistoryRow = (execution: WorkflowExecution) => {
    const isExpanded = expandedId === execution.id;
    const hasStepLogs = execution.stepLogs && execution.stepLogs.length > 0;
    return (
      <Card
        key={execution.id}
        data-testid={`card-execution-${execution.id}`}
      >
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-2">
              {getStatusIcon(execution.status)}
              <CardTitle className="text-base">
                {execution.contactName || `Execution #${execution.id.slice(0, 8)}`}
              </CardTitle>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {getStatusBadge(execution.status)}
              <Button
                variant="ghost"
                size="sm"
                data-testid={`button-steps-${execution.id}`}
                disabled={!hasStepLogs}
                onClick={() => setExpandedId(isExpanded ? null : execution.id)}
              >
                {isExpanded
                  ? <ChevronDown className="h-3.5 w-3.5 mr-1" />
                  : <ChevronRight className="h-3.5 w-3.5 mr-1" />
                }
                Steps ({execution.stepLogs?.length ?? 0})
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-muted-foreground mb-1">Triggered By</p>
              <Badge variant="outline" className="text-xs">
                {(execution.triggeredBy || 'manual').replace(/_/g, ' ')}
              </Badge>
            </div>
            <div>
              <p className="text-muted-foreground mb-1">Started</p>
              <p className="font-medium">
                {execution.startedAt
                  ? formatDistanceToNow(new Date(execution.startedAt), { addSuffix: true })
                  : '—'}
              </p>
            </div>
          </div>

          {execution.completedAt && (
            <div className="text-sm">
              <p className="text-muted-foreground mb-1">Completed</p>
              <p className="font-medium">
                {formatDistanceToNow(new Date(execution.completedAt), { addSuffix: true })}
              </p>
            </div>
          )}

          {execution.errorMessage && (
            <div className="mt-3 p-3 bg-destructive/10 rounded-md border border-destructive/20">
              <div className="flex items-start gap-2">
                <XCircle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
                <div className="flex-1">
                  <p className="text-sm font-medium text-destructive mb-1">Error</p>
                  <p className="text-sm text-destructive/90">{execution.errorMessage}</p>
                </div>
              </div>
            </div>
          )}

          {isExpanded && hasStepLogs && (
            <div className="mt-3 pt-3 border-t space-y-2" data-testid={`step-timeline-${execution.id}`}>
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">
                Step Timeline
              </p>
              {execution.stepLogs.map((log, idx) => {
                const isCondition = log.actionType === 'conditional_branch';
                const diag = isCondition
                  ? (log.result as ConditionDiagnostic | undefined)
                  : undefined;
                return (
                  <div key={log.stepId || idx} className="flex items-start gap-3 py-1.5">
                    {getStepIcon(log.status)}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium">
                          {formatActionType(log.actionType)}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {log.durationMs}ms
                        </span>
                        {isCondition && typeof diag?.result === 'boolean' && (
                          <Badge
                            variant={diag.result ? 'default' : 'outline'}
                            className="text-xs"
                            data-testid={`badge-condition-result-${log.stepId || idx}`}
                          >
                            {diag.result ? 'true' : 'false'}
                          </Badge>
                        )}
                      </div>
                      {isCondition && diag?.field && (
                        <p
                          className="text-xs text-muted-foreground mt-0.5 break-words"
                          data-testid={`text-condition-summary-${log.stepId || idx}`}
                        >
                          <span className="font-mono">{diag.field}</span>
                          {' '}{diag.operator || ''}{' '}
                          <span className="font-mono">{formatDiagnosticValue(diag.target)}</span>
                          {' → '}
                          <span className="font-medium">
                            {diag.result === undefined ? '—' : String(diag.result)}
                          </span>
                          {' (resolved: '}
                          <span className="font-mono">{formatDiagnosticValue(diag.resolvedValue)}</span>
                          {diag.truncated ? ', truncated' : ''}
                          {')'}
                        </p>
                      )}
                      {isCondition && diag?.note && (
                        <p className="text-xs text-amber-600 dark:text-amber-400 mt-0.5">
                          {diag.note}
                        </p>
                      )}
                      {isCondition && diag && (
                        <details className="mt-1" data-testid={`details-condition-${log.stepId || idx}`}>
                          <summary className="text-xs text-muted-foreground cursor-pointer hover-elevate rounded-md px-1 py-0.5 inline-block">
                            Full diagnostic{diag.truncated ? ' (resolvedValue truncated to 2 KB)' : ''}
                          </summary>
                          <pre
                            className="mt-1 text-[11px] leading-tight bg-muted rounded-md p-2 overflow-x-auto whitespace-pre-wrap break-words"
                            data-testid={`pre-condition-diagnostic-${log.stepId || idx}`}
                          >
{JSON.stringify(diag, null, 2)}
                          </pre>
                        </details>
                      )}
                      {log.status === 'skipped' && (
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {(log.result as { reason?: string } | undefined)?.reason ?? 'Skipped'}
                        </p>
                      )}
                      {log.error && (
                        <p className="text-xs text-destructive mt-0.5">{log.error}</p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    );
  };

  return (
    <PageLayout>
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <Link href="/workflows/manage">
            <Button variant="ghost" size="icon" data-testid="button-back">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <h1 className="text-2xl font-bold" data-testid="text-page-title">
              Workflow Executions
            </h1>
            {workflowLoading ? (
              <Skeleton className="h-4 w-48 mt-1" />
            ) : workflow ? (
              <p className="text-sm text-muted-foreground">{workflow.name}</p>
            ) : null}
          </div>
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList>
            <TabsTrigger value="active" data-testid="tab-active">
              Active
              {activeExecutions && activeExecutions.length > 0 && (
                <Badge variant="secondary" className="ml-2 text-xs no-default-active-elevate">
                  {activeExecutions.length}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="history" data-testid="tab-history">
              History
            </TabsTrigger>
            <TabsTrigger value="decisions" data-testid="tab-decisions">
              Trigger decisions
            </TabsTrigger>
          </TabsList>

          <TabsContent value="active" className="mt-4 space-y-3">
            {activeLoading ? (
              Array.from({ length: 3 }).map((_, i) => (
                <Card key={i}>
                  <CardContent className="py-4">
                    <Skeleton className="h-6 w-full" />
                  </CardContent>
                </Card>
              ))
            ) : !activeExecutions || activeExecutions.length === 0 ? (
              <Card>
                <CardContent className="flex flex-col items-center justify-center py-12">
                  <CheckCircle2 className="h-12 w-12 text-muted-foreground mb-4" />
                  <p className="text-lg font-medium">No active enrollments</p>
                  <p className="text-sm text-muted-foreground">
                    Nobody is currently running through this workflow
                  </p>
                </CardContent>
              </Card>
            ) : (
              activeExecutions.map(renderActiveRow)
            )}
          </TabsContent>

          <TabsContent value="history" className="mt-4 space-y-4">
            {historyLoading ? (
              Array.from({ length: 3 }).map((_, i) => (
                <Card key={i}>
                  <CardHeader>
                    <Skeleton className="h-6 w-full" />
                  </CardHeader>
                  <CardContent>
                    <Skeleton className="h-4 w-3/4" />
                  </CardContent>
                </Card>
              ))
            ) : !historyExecutions || historyExecutions.length === 0 ? (
              <Card>
                <CardContent className="flex flex-col items-center justify-center py-12">
                  <Calendar className="h-12 w-12 text-muted-foreground mb-4" />
                  <p className="text-lg font-medium">No executions yet</p>
                  <p className="text-sm text-muted-foreground">
                    This workflow hasn't been run yet
                  </p>
                </CardContent>
              </Card>
            ) : (
              historyExecutions.map(renderHistoryRow)
            )}
          </TabsContent>

          <TabsContent value="decisions" className="mt-4 space-y-3">
            <p className="text-sm text-muted-foreground">
              Every time a contact, estimate, or job event fires, this workflow's trigger is evaluated.
              Use this list to see which events ran the workflow and which were skipped — and why.
            </p>
            {decisionsLoading ? (
              Array.from({ length: 3 }).map((_, i) => (
                <Card key={i}>
                  <CardContent className="py-4">
                    <Skeleton className="h-6 w-full" />
                  </CardContent>
                </Card>
              ))
            ) : !dispatchDecisions || dispatchDecisions.length === 0 ? (
              <Card>
                <CardContent className="flex flex-col items-center justify-center py-12">
                  <HelpCircle className="h-12 w-12 text-muted-foreground mb-4" />
                  <p className="text-lg font-medium">No recent dispatch decisions</p>
                  <p className="text-sm text-muted-foreground">
                    Once a relevant contact, estimate, or job event fires, the decision will appear here.
                  </p>
                </CardContent>
              </Card>
            ) : (
              dispatchDecisions.map(decision => {
                const matched = decision.status === 'matched';
                // Fallback label uses the actual entity type so estimate/job rows
                // don't read as "Contact …" or "Unknown contact" when the trigger
                // payload didn't include a name.
                const entityNoun = decision.entityType === 'estimate'
                  ? 'Estimate'
                  : decision.entityType === 'job'
                    ? 'Job'
                    : 'Contact';
                const entityLabel = decision.entityName
                  ?? (decision.entityId ? `${entityNoun} ${decision.entityId.slice(0, 8)}` : `Unknown ${entityNoun.toLowerCase()}`);
                return (
                  <Card key={decision.id} data-testid={`card-decision-${decision.id}`}>
                    <CardContent className="py-4">
                      <div className="flex items-start justify-between gap-4 flex-wrap">
                        <div className="flex items-start gap-3 min-w-0">
                          {matched
                            ? <CheckCircle2 className="h-4 w-4 mt-0.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
                            : <SkipForward className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
                          }
                          <div className="min-w-0">
                            <p className="font-medium truncate" data-testid={`text-decision-entity-${decision.id}`}>
                              {(() => {
                                const href = entityHref(decision.entityType, decision.entityId);
                                return href
                                  ? <Link href={href} className="hover:underline">{entityLabel}</Link>
                                  : entityLabel;
                              })()}
                            </p>
                            <p className="text-xs text-muted-foreground" data-testid={`text-decision-event-${decision.id}`}>
                              {formatEventType(decision.eventType)}
                            </p>
                            {matched ? (
                              <p className="text-sm text-emerald-700 dark:text-emerald-400">
                                Matched and ran
                                {decision.executionId && (
                                  <>
                                    {' '}·{' '}
                                    <Link
                                      href={`/workflows/${workflowId}/executions?execution=${decision.executionId}`}
                                      className="hover:underline"
                                      data-testid={`link-decision-execution-${decision.id}`}
                                    >
                                      View execution
                                    </Link>
                                  </>
                                )}
                              </p>
                            ) : (
                              <p className="text-sm text-muted-foreground" data-testid={`text-decision-reason-${decision.id}`}>
                                Skipped: {decision.reason ? humanizeSkipReason(decision.reason) : 'unknown reason'}
                              </p>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <Badge
                            variant={matched ? 'default' : 'outline'}
                            className="text-xs no-default-active-elevate"
                          >
                            {matched ? 'Ran' : 'Skipped'}
                          </Badge>
                          <span className="text-xs text-muted-foreground">
                            {formatDistanceToNow(new Date(decision.createdAt), { addSuffix: true })}
                          </span>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                );
              })
            )}
          </TabsContent>
        </Tabs>
      </div>
    </PageLayout>
  );
}
