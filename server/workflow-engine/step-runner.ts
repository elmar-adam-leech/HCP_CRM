import type { WorkflowStep } from "@shared/schema";
import { storage } from "../storage";
import { logger } from "../utils/logger";
import type { ExecutionContext, StepGroupOutcome, StepLog, StepResult } from "./types";
import { executeStep } from "./step-executor";

const log = logger('WorkflowEngine');

/**
 * Cap the persisted size of a conditional_branch diagnostic so a step log row
 * stays small even when the resolved value is something huge (line items,
 * description blobs, an entire attached payload). When the resolved value
 * serializes to more than this many characters, we replace it with a string
 * preview and set `truncated: true` on the saved blob — the UI shows the
 * preview and explains that the rest was dropped.
 */
const RESOLVED_VALUE_MAX_BYTES = 2048;

export function truncateConditionDiagnostic(
  data: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!data || typeof data !== 'object') return data;
  if (!('resolvedValue' in data)) return data;
  const v = data.resolvedValue;
  let serialized: string;
  try {
    serialized = JSON.stringify(v);
  } catch {
    return { ...data, resolvedValue: String(v), truncated: true };
  }
  if (serialized === undefined) return data;
  if (serialized.length <= RESOLVED_VALUE_MAX_BYTES) return data;
  return {
    ...data,
    resolvedValue: serialized.slice(0, RESOLVED_VALUE_MAX_BYTES) + '…',
    truncated: true,
  };
}

interface ParsedEdge {
  source: string;
  target: string;
  sourceHandle?: string;
}

interface ParsedStepGraph {
  /** Map from step.id -> the React Flow nodeId saved in actionConfig.nodeId. */
  stepNodeIds: Map<string, string>;
  /** Map from React Flow nodeId -> outgoing edges. */
  outgoing: Map<string, ParsedEdge[]>;
  /** All node ids that ever appear in any edge. */
  allNodeIds: Set<string>;
  /** Node ids that appear as a target of some edge. */
  targetNodeIds: Set<string>;
  /**
   * Node ids that look like a conditional gate — derived structurally from the
   * edges (presence of a `true`/`false` sourceHandle). This is independent of
   * whether the conditional step row itself is part of the slice being parsed,
   * so resume paths still detect the gate even after the conditional step has
   * already executed and been dropped from `remainingSteps`.
   */
  conditionalNodeIdsFromEdges: Set<string>;
  /** Whether any step in the workflow declared a conditional_branch action. */
  hasConditional: boolean;
  /** Whether any step declared edges in actionConfig. */
  hasEdges: boolean;
}

/**
 * Parse the per-step actionConfig blobs into a single graph. Each step persists
 * the React Flow edges it touches under actionConfig.edges; taking the union
 * gives us the full workflow graph (the trigger node is the only node that has
 * no corresponding step row, but it shows up as the source of the edge into
 * the first step).
 */
export function parseStepGraph(steps: WorkflowStep[]): ParsedStepGraph {
  const stepNodeIds = new Map<string, string>();
  const outgoing = new Map<string, ParsedEdge[]>();
  const allNodeIds = new Set<string>();
  const targetNodeIds = new Set<string>();
  const conditionalNodeIdsFromEdges = new Set<string>();
  let hasConditional = false;
  let hasEdges = false;

  const seenEdgeKeys = new Set<string>();

  for (const step of steps) {
    if (step.actionType === 'conditional_branch') hasConditional = true;
    let cfg: Record<string, unknown> = {};
    try {
      cfg = step.actionConfig ? JSON.parse(step.actionConfig) : {};
    } catch {
      continue;
    }
    const nodeId = typeof cfg.nodeId === 'string' ? cfg.nodeId : undefined;
    if (nodeId) {
      stepNodeIds.set(step.id, nodeId);
      allNodeIds.add(nodeId);
    }
    const rawEdges = Array.isArray((cfg as { edges?: unknown }).edges)
      ? ((cfg as { edges: unknown[] }).edges)
      : [];
    for (const raw of rawEdges) {
      if (!raw || typeof raw !== 'object') continue;
      const e = raw as Record<string, unknown>;
      const source = typeof e.source === 'string' ? e.source : undefined;
      const target = typeof e.target === 'string' ? e.target : undefined;
      if (!source || !target) continue;
      const sourceHandle = typeof e.sourceHandle === 'string' ? e.sourceHandle : undefined;
      const key = `${source}\u0000${target}\u0000${sourceHandle ?? ''}`;
      if (seenEdgeKeys.has(key)) continue;
      seenEdgeKeys.add(key);
      hasEdges = true;
      if (!outgoing.has(source)) outgoing.set(source, []);
      outgoing.get(source)!.push({ source, target, sourceHandle });
      allNodeIds.add(source);
      allNodeIds.add(target);
      targetNodeIds.add(target);
      if (sourceHandle === 'true' || sourceHandle === 'false') {
        conditionalNodeIdsFromEdges.add(source);
      }
    }
  }

  return {
    stepNodeIds,
    outgoing,
    allNodeIds,
    targetNodeIds,
    conditionalNodeIdsFromEdges,
    hasConditional,
    hasEdges,
  };
}

/**
 * Walk the parsed graph from its trigger root(s) and return the set of node ids
 * that are reachable given the boolean results of conditional steps that have
 * already executed. Edges from a conditional whose result is known are followed
 * only on the matching `sourceHandle`. Conditionals whose result is not yet
 * known are treated as fully reachable (both branches) so their downstream
 * steps are not pre-emptively skipped before the condition runs.
 */
export function computeReachableNodeIds(
  graph: ParsedStepGraph,
  conditionalResults: Map<string, boolean>,
  conditionalNodeIds: Set<string> = graph.conditionalNodeIdsFromEdges,
): Set<string> {
  const roots: string[] = [];
  for (const id of graph.allNodeIds) {
    if (!graph.targetNodeIds.has(id)) roots.push(id);
  }

  const reachable = new Set<string>();
  const queue = [...roots];
  while (queue.length) {
    const id = queue.shift()!;
    if (reachable.has(id)) continue;
    reachable.add(id);

    const isConditional = conditionalNodeIds.has(id);
    const resolved = conditionalResults.get(id);
    const edges = graph.outgoing.get(id) ?? [];
    for (const edge of edges) {
      if (isConditional && resolved !== undefined) {
        const handle = edge.sourceHandle;
        if (handle === 'true' || handle === 'false') {
          const want = resolved ? 'true' : 'false';
          if (handle !== want) continue;
        }
      }
      queue.push(edge.target);
    }
  }
  return reachable;
}

/**
 * Re-derive the conditional results map from previously persisted step logs.
 * Used when resuming a suspended execution so gating decisions made before the
 * suspend point continue to apply on resume — even when the conditional step
 * row is no longer in the slice being executed.
 *
 * The nodeId is read from the StepLog itself (persisted at write time), with a
 * fallback to the current graph's stepId→nodeId map for older logs that were
 * written before nodeId was added to StepLog.
 */
function rebuildConditionalResultsFromLogs(
  stepLogs: StepLog[],
  graph: ParsedStepGraph,
): Map<string, boolean> {
  const results = new Map<string, boolean>();
  for (const entry of stepLogs) {
    if (entry.actionType !== 'conditional_branch') continue;
    const data = entry.result as Record<string, unknown> | undefined;
    if (!data) continue;
    const nodeId = entry.nodeId ?? graph.stepNodeIds.get(entry.stepId);
    if (!nodeId) continue;
    if (entry.status === 'success' && typeof data.result === 'boolean') {
      results.set(nodeId, data.result);
    } else if (entry.status === 'failed') {
      // Per task: default to "false branch" semantics if the conditional step
      // itself failed, so a flaky condition can't silently re-fire both
      // branches on retry.
      results.set(nodeId, false);
    }
  }
  return results;
}

/**
 * Run step groups in order, executing steps within each group in parallel.
 *
 * Steps are grouped by `stepOrder` — all steps sharing the same order run
 * concurrently via Promise.all, while groups at increasing orders run
 * sequentially to preserve causality (later steps can reference earlier output).
 *
 * If/else gating: before each group, we compute which React Flow node ids are
 * still reachable from the trigger given the boolean results of any
 * conditional_branch steps that have executed so far. Steps whose nodeId is
 * not reachable are recorded as `skipped` and their handler is not invoked,
 * so a workflow with `If tags contains "X"` that evaluates `false` no longer
 * silently runs both branches.
 *
 * Returns early on suspend (delay/wait_until) or failure (fail-fast).
 * On success, merges each step's output data into `context.variables`.
 */
export async function runStepGroups(
  steps: WorkflowStep[],
  stepLogs: StepLog[],
  context: ExecutionContext,
  executionId: string,
  contractorId: string,
): Promise<StepGroupOutcome> {
  const sorted = [...steps].sort((a, b) => a.stepOrder - b.stepOrder);
  const groups = new Map<number, WorkflowStep[]>();
  for (const step of sorted) {
    if (!groups.has(step.stepOrder)) groups.set(step.stepOrder, []);
    groups.get(step.stepOrder)!.push(step);
  }

  const graph = parseStepGraph(steps);
  // Union of conditional node ids derived from the step rows in this slice
  // and from the structural shape of the saved edges. The edge-derived set
  // matters on resume: when the conditional step has already executed and is
  // not in `remainingSteps`, the action-type lookup misses it but the
  // true/false handle on its outgoing edges still identifies it.
  const conditionalNodeIds = new Set<string>(graph.conditionalNodeIdsFromEdges);
  for (const step of steps) {
    if (step.actionType !== 'conditional_branch') continue;
    const nodeId = graph.stepNodeIds.get(step.id);
    if (nodeId) conditionalNodeIds.add(nodeId);
  }
  // Pull any conditional results that were recorded in earlier groups before
  // a suspend (delay/wait_until) — needed so gating still applies on resume
  // even when the conditional step row has been dropped from this slice.
  const priorResults = rebuildConditionalResultsFromLogs(stepLogs, graph);
  // Legacy / no-conditional workflows: no edges saved AND nothing identifying
  // a conditional gate (in the current slice, in prior logs, or in edge
  // structure) means there's nothing to gate on. Fall back to the historical
  // "run every step in stepOrder" behavior so existing workflows don't change.
  const gatingActive =
    graph.hasEdges &&
    (conditionalNodeIds.size > 0 || priorResults.size > 0);
  const conditionalResults: Map<string, boolean> = gatingActive
    ? priorResults
    : new Map();

  for (const [stepOrder, stepsInGroup] of Array.from(groups.entries()).sort(([a], [b]) => a - b)) {
    // Check if execution was cancelled externally before processing this step group.
    const current = await storage.getWorkflowExecution(executionId, contractorId);
    if (current?.status === 'cancelled') {
      log.info(`Execution ${executionId} was cancelled externally; aborting at step order ${stepOrder}`);
      return { kind: 'cancelled' };
    }

    log.debug(`Executing ${stepsInGroup.length} step(s) at order ${stepOrder}`);
    await storage.updateWorkflowExecution(executionId, { currentStep: stepOrder }, contractorId);

    const reachable = gatingActive
      ? computeReachableNodeIds(graph, conditionalResults, conditionalNodeIds)
      : null;

    const results = await Promise.all(
      stepsInGroup.map(async step => {
        const start = Date.now();
        const startedAt = new Date().toISOString();
        const stepNodeId = graph.stepNodeIds.get(step.id);
        const isReachable = !reachable
          || !stepNodeId
          || reachable.has(stepNodeId);

        let result: StepResult;
        let skipped = false;
        if (!isReachable) {
          skipped = true;
          result = {
            success: true,
            data: {
              skipped: true,
              reason: 'upstream conditional branch did not select this path',
            },
          };
        } else {
          result = await executeStep(step, context);
          if (result.success && result.data && (result.data as Record<string, unknown>).skipped) {
            skipped = true;
          }
        }
        const persistedResult = step.actionType === 'conditional_branch'
          ? truncateConditionDiagnostic(result.data)
          : result.data;
        stepLogs.push({
          stepId: step.id,
          nodeId: stepNodeId,
          stepOrder: step.stepOrder,
          actionType: step.actionType,
          startedAt,
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - start,
          status: result.success ? (skipped ? 'skipped' : 'success') : 'failed',
          result: persistedResult,
          error: result.error,
        });
        return result;
      })
    );

    const suspendResult = results.find(r => r.success && r.suspend && r.resumeAt);
    if (suspendResult) {
      return { kind: 'suspended', stepOrder, resumeAt: suspendResult.resumeAt! };
    }

    const failures = results.filter(r => !r.success);
    if (failures.length > 0) {
      const errorMessages = failures.map(f => f.error).join('; ');
      log.error(`${failures.length} step(s) failed at order ${stepOrder}: ${errorMessages}`);
      // Fail-fast: a step failure aborts the rest of the workflow. The
      // "default to false branch on conditional failure" rule from the task
      // is enforced at resume time inside rebuildConditionalResultsFromLogs,
      // so a retried run of a workflow whose conditional previously failed
      // will not silently re-fire the true branch.
      return { kind: 'failed', errorMessages };
    }

    results.forEach((result, index) => {
      if (result.data) {
        const step = stepsInGroup[index];
        context.variables[`step_${step.stepOrder}_${step.id}_result`] = result.data;

        // Record conditional outcomes so downstream groups in this run get
        // gated correctly. A skipped conditional (its parent branch wasn't
        // selected) does not contribute a result.
        if (gatingActive && step.actionType === 'conditional_branch') {
          const data = result.data as Record<string, unknown>;
          if (data.skipped !== true && typeof data.result === 'boolean') {
            const nodeId = graph.stepNodeIds.get(step.id);
            if (nodeId) conditionalResults.set(nodeId, data.result as boolean);
          }
        }
      }
    });
  }

  return { kind: 'completed' };
}
