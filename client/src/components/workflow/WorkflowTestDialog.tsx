import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useToast } from '@/hooks/use-toast';
import { Play, AlertCircle, CheckCircle2, ChevronDown, ChevronRight } from 'lucide-react';
import { apiRequest, queryClient } from '@/lib/queryClient';
import { useQuery } from '@tanstack/react-query';
import { EntityPicker, type EntityOption } from './EntityPicker';
import type { Workflow } from '@/types/workflow';

type WorkflowTestDialogProps = {
  workflowId?: string;
  disabled?: boolean;
  unapprovedMessage?: string;
  isDirty?: boolean;
  onSaveBeforeTest?: () => Promise<void>;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  hideTrigger?: boolean;
};

type ExecutionPayload = {
  id: string;
  triggerData?: string | Record<string, unknown> | null;
};

/**
 * Decode the workflow's `triggerConfig` JSON to find the entity type the
 * trigger is configured for. We use this to pre-scope the entity picker so
 * the user can only pick the kind of record the workflow actually fires on.
 * Falls back to 'lead' to match the engine's default in context-builder.ts.
 */
function getTriggerEntityType(workflow: Workflow | undefined): string {
  if (!workflow?.triggerConfig) return 'lead';
  try {
    const cfg = typeof workflow.triggerConfig === 'string'
      ? JSON.parse(workflow.triggerConfig)
      : workflow.triggerConfig;
    return String(cfg?.entity || cfg?.entityType || 'lead');
  } catch {
    return 'lead';
  }
}

export function WorkflowTestDialog({
  workflowId,
  disabled,
  unapprovedMessage,
  isDirty,
  onSaveBeforeTest,
  open,
  onOpenChange,
  hideTrigger,
}: WorkflowTestDialogProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const isOpen = open !== undefined ? open : internalOpen;
  const setIsOpen = onOpenChange || setInternalOpen;
  const [selectedEntity, setSelectedEntity] = useState<EntityOption | null>(null);
  const [advancedJson, setAdvancedJson] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [loadingLabel, setLoadingLabel] = useState('Running...');
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [lastExecutionId, setLastExecutionId] = useState<string | null>(null);
  const [resolvedOpen, setResolvedOpen] = useState(true);
  const { toast } = useToast();

  const { data: workflow } = useQuery<Workflow>({
    queryKey: ['/api/workflows', workflowId],
    enabled: !!workflowId && isOpen,
  });
  const entityType = getTriggerEntityType(workflow);

  // Re-fetch the new execution row after a successful test run so we can show
  // the user the *exact* payload the engine saw — that's the actual debug info
  // they need ("did my tag actually make it into the trigger data?").
  const { data: lastExecution } = useQuery<ExecutionPayload>({
    queryKey: ['/api/workflow-executions', lastExecutionId],
    queryFn: async () => {
      const r = await apiRequest('GET', `/api/workflow-executions/${lastExecutionId}`);
      return r.json();
    },
    enabled: !!lastExecutionId,
    refetchInterval: 1500,
    refetchIntervalInBackground: false,
  });

  // Reset state when dialog closes so the next open is clean.
  useEffect(() => {
    if (!isOpen) {
      setTestResult(null);
      setLastExecutionId(null);
      setShowAdvanced(false);
    }
  }, [isOpen]);

  const handleTest = async () => {
    if (!workflowId) {
      toast({
        title: 'Error',
        description: 'Please save the workflow before testing',
        variant: 'destructive',
      });
      return;
    }

    setIsLoading(true);
    setTestResult(null);
    setLastExecutionId(null);

    try {
      if (isDirty && onSaveBeforeTest) {
        setLoadingLabel('Saving...');
        await onSaveBeforeTest();
        setLoadingLabel('Running...');
      }

      // Build trigger payload: prefer the entity picker; fall back to the
      // advanced JSON for the rare case someone wants a hand-built payload.
      let triggerData: Record<string, unknown> = {};
      if (selectedEntity) {
        triggerData = { entityId: selectedEntity.id, entityType };
      } else if (showAdvanced && advancedJson.trim()) {
        try {
          const parsed = JSON.parse(advancedJson);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('Advanced JSON must be an object');
          }
          triggerData = parsed;
        } catch (e) {
          throw new Error(e instanceof Error ? e.message : 'Invalid JSON in Advanced payload');
        }
      } else {
        throw new Error(`Pick a ${entityType} to test against`);
      }

      const response = await apiRequest('POST', `/api/workflows/${workflowId}/execute`, {
        triggerData,
      });
      const created = await response.json();
      if (created?.id) setLastExecutionId(created.id);

      setTestResult({
        success: true,
        message: 'Workflow execution started. The resolved trigger payload is shown below.',
      });
      toast({
        title: 'Test Started',
        description: 'Workflow is now running in test mode',
      });
      queryClient.invalidateQueries({ queryKey: ['/api/workflows', workflowId, 'executions'] });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to start workflow execution';
      setTestResult({ success: false, message });
      toast({ title: 'Test Failed', description: message, variant: 'destructive' });
    } finally {
      setIsLoading(false);
      setLoadingLabel('Running...');
    }
  };

  const resolvedTriggerData: Record<string, unknown> | null = (() => {
    if (!lastExecution?.triggerData) return null;
    if (typeof lastExecution.triggerData === 'string') {
      try {
        return JSON.parse(lastExecution.triggerData);
      } catch {
        return { _raw: lastExecution.triggerData };
      }
    }
    return lastExecution.triggerData as Record<string, unknown>;
  })();

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      {!hideTrigger && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex" tabIndex={disabled ? 0 : undefined}>
              <DialogTrigger asChild disabled={disabled}>
                <Button
                  variant="outline"
                  size="default"
                  disabled={disabled}
                  data-testid="button-test-workflow"
                >
                  <Play className="h-4 w-4 mr-2" />
                  Test
                </Button>
              </DialogTrigger>
            </span>
          </TooltipTrigger>
          {unapprovedMessage && disabled && (
            <TooltipContent data-testid="tooltip-test-disabled">
              <p>{unapprovedMessage}</p>
            </TooltipContent>
          )}
        </Tooltip>
      )}
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Test Workflow</DialogTitle>
          <DialogDescription>
            Pick a real record to dispatch this workflow against. The engine will
            load that record's live data the same way a real trigger event would.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {isDirty && (
            <Alert>
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>
                You have unsaved changes. The workflow will be saved automatically before running.
              </AlertDescription>
            </Alert>
          )}

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <Label>Test against</Label>
              <Badge variant="outline" className="text-xs" data-testid="badge-test-entity-type">
                {entityType}
              </Badge>
            </div>
            <EntityPicker
              entityType={entityType}
              value={selectedEntity}
              onChange={setSelectedEntity}
              placeholder={`Search ${entityType} by name…`}
            />
            <p className="text-xs text-muted-foreground">
              Real triggers always include the live entity from the database — picking
              one here mirrors that exactly.
            </p>
          </div>

          <Collapsible open={showAdvanced} onOpenChange={setShowAdvanced}>
            <CollapsibleTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="px-0"
                data-testid="button-toggle-advanced"
              >
                {showAdvanced
                  ? <ChevronDown className="h-3.5 w-3.5 mr-1" />
                  : <ChevronRight className="h-3.5 w-3.5 mr-1" />}
                Advanced — provide raw JSON
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-2 pt-2">
              <Textarea
                value={advancedJson}
                onChange={(e) => setAdvancedJson(e.target.value)}
                placeholder='{ "entityId": "<uuid>", "entityType": "lead" }'
                className="font-mono text-sm min-h-[120px]"
                data-testid="textarea-test-data"
              />
              <p className="text-xs text-muted-foreground">
                Used only when no record is picked above. Must be a JSON object.
              </p>
            </CollapsibleContent>
          </Collapsible>

          {testResult && (
            <Alert variant={testResult.success ? 'default' : 'destructive'}>
              <div className="flex items-start gap-2">
                {testResult.success ? (
                  <CheckCircle2 className="h-4 w-4 mt-0.5" />
                ) : (
                  <AlertCircle className="h-4 w-4 mt-0.5" />
                )}
                <AlertDescription>{testResult.message}</AlertDescription>
              </div>
            </Alert>
          )}

          {lastExecutionId && (
            <Collapsible open={resolvedOpen} onOpenChange={setResolvedOpen}>
              <CollapsibleTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="px-0"
                  data-testid="button-toggle-resolved-payload"
                >
                  {resolvedOpen
                    ? <ChevronDown className="h-3.5 w-3.5 mr-1" />
                    : <ChevronRight className="h-3.5 w-3.5 mr-1" />}
                  Resolved trigger payload
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="pt-2">
                <pre
                  className="rounded-md border bg-muted/40 p-3 text-xs font-mono overflow-auto max-h-72"
                  data-testid="pre-resolved-trigger-data"
                >
                  {resolvedTriggerData
                    ? JSON.stringify(resolvedTriggerData, null, 2)
                    : 'Loading…'}
                </pre>
              </CollapsibleContent>
            </Collapsible>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setIsOpen(false)}
            disabled={isLoading}
            data-testid="button-cancel-test"
          >
            Close
          </Button>
          <Button
            onClick={handleTest}
            disabled={isLoading || !workflowId}
            data-testid="button-run-test"
          >
            {isLoading ? loadingLabel : 'Run Test'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
