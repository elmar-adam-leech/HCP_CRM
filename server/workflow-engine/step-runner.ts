import type { WorkflowStep } from "@shared/schema";
import { storage } from "../storage";
import { logger } from "../utils/logger";
import type { ExecutionContext, StepGroupOutcome, StepLog } from "./types";
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

/**
 * Run step groups in order, executing steps within each group in parallel.
 *
 * Steps are grouped by `stepOrder` — all steps sharing the same order run
 * concurrently via Promise.all, while groups at increasing orders run
 * sequentially to preserve causality (later steps can reference earlier output).
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

  for (const [stepOrder, stepsInGroup] of Array.from(groups.entries()).sort(([a], [b]) => a - b)) {
    // Check if execution was cancelled externally before processing this step group.
    const current = await storage.getWorkflowExecution(executionId, contractorId);
    if (current?.status === 'cancelled') {
      log.info(`Execution ${executionId} was cancelled externally; aborting at step order ${stepOrder}`);
      return { kind: 'cancelled' };
    }

    log.debug(`Executing ${stepsInGroup.length} step(s) at order ${stepOrder}`);
    await storage.updateWorkflowExecution(executionId, { currentStep: stepOrder }, contractorId);

    const results = await Promise.all(
      stepsInGroup.map(async step => {
        const start = Date.now();
        const startedAt = new Date().toISOString();
        const result = await executeStep(step, context);
        const persistedResult = step.actionType === 'conditional_branch'
          ? truncateConditionDiagnostic(result.data)
          : result.data;
        stepLogs.push({
          stepId: step.id,
          stepOrder: step.stepOrder,
          actionType: step.actionType,
          startedAt,
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - start,
          status: result.success
            ? (result.data && (result.data as Record<string, unknown>).skipped ? 'skipped' : 'success')
            : 'failed',
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
      return { kind: 'failed', errorMessages };
    }

    results.forEach((result, index) => {
      if (result.data) {
        const step = stepsInGroup[index];
        context.variables[`step_${step.stepOrder}_${step.id}_result`] = result.data;
      }
    });
  }

  return { kind: 'completed' };
}
