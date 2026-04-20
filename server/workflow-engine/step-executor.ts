import type { WorkflowStep } from "@shared/schema";
import { logger } from "../utils/logger";
import type { ExecutionContext, StepResult } from "./types";
import { handleSendEmail } from "../workflow-actions/send-email";
import { handleSendSMS } from "../workflow-actions/send-sms";
import { handleCreateNotification } from "../workflow-actions/create-notification";
import { handleUpdateEntity } from "../workflow-actions/update-entity";
import { handleAssignUser } from "../workflow-actions/assign-user";
import { handleEvaluateCondition } from "../workflow-actions/condition";
import { handleDelay } from "../workflow-actions/delay";
import { handleSetFollowUp } from "../workflow-actions/set-follow-up";

const log = logger('WorkflowEngine');

/**
 * Extract the action config payload, handling both the legacy top-level shape
 * and the current nested shape { nodeId, position, data: { … }, edges }.
 */
export function extractConfig(config: unknown): Record<string, unknown> {
  const c = config as Record<string, unknown>;
  return (c?.data as Record<string, unknown>) ?? c ?? {};
}

/**
 * Execute a single workflow step, dispatching to the appropriate action handler.
 *
 * Each action type maps to a dedicated handler module under `server/workflow-actions/`.
 * Handlers receive only `params` and `context` — template interpolation and entity
 * mutation are imported directly by each handler (no callback injection).
 *
 * A per-step timeout (30 s) is enforced via Promise.race so that a hung
 * 3rd-party call never blocks the whole execution chain.
 *
 * Unknown action types return a failure result — a misconfigured step should not be
 * treated as a success because downstream steps may depend on this step's output.
 *
 * @param step    - The WorkflowStep row from the database.
 * @param context - The live execution context (mutated across step groups to pass data forward).
 */
export async function executeStep(step: WorkflowStep, context: ExecutionContext): Promise<StepResult> {
  log.debug(`Executing step ${step.stepOrder}: ${step.actionType}`);

  const timeoutMs = 30_000;

  // IMPORTANT — side-effect ambiguity on timeout:
  // Promise.race resolves as soon as one leg wins, but the losing promise
  // continues to run in the background. If the timeout fires first, the step
  // is marked failed and the workflow is aborted — however, the underlying
  // action (e.g. sending an email via Gmail, sending an SMS via Dialpad) may
  // have already been dispatched to the external API and will still succeed.
  // This means the customer *receives* the communication even though the
  // workflow shows a failure. This is intentional: correctness of delivery
  // is preferred over false-negative failure reporting, and a true timeout
  // almost always means a slow network rather than a failed send.
  // If you need guaranteed at-most-once delivery, you must add idempotency
  // keys and a retry-deduplication layer before changing this behaviour.
  const timeoutPromise: Promise<StepResult> = new Promise(resolve =>
    setTimeout(() => resolve({ success: false, error: `Step timed out after ${timeoutMs / 1000}s` }), timeoutMs)
  );

  try {
    const config = step.actionConfig ? JSON.parse(step.actionConfig) : {};
    const params = extractConfig(config);

    let stepPromise: Promise<StepResult>;

    switch (step.actionType) {
      case 'send_email':
        stepPromise = handleSendEmail(params, context);
        break;

      case 'send_sms':
        stepPromise = handleSendSMS(params, context);
        break;

      case 'create_notification':
        stepPromise = handleCreateNotification(params, context);
        break;

      case 'update_entity':
        stepPromise = handleUpdateEntity(params, context);
        break;

      case 'assign_user':
        stepPromise = handleAssignUser(params, context);
        break;

      case 'conditional_branch':
        stepPromise = handleEvaluateCondition(step, params, context);
        break;

      case 'set_follow_up':
        stepPromise = handleSetFollowUp(params, context);
        break;

      case 'delay':
      case 'wait_until':
        return await handleDelay(step, params);

      default:
        log.warn(`Unknown action type: ${step.actionType}`);
        return { success: false, error: `Unknown action type: ${step.actionType}` };
    }

    return await Promise.race([stepPromise, timeoutPromise]);
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}
