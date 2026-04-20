import { updateEntityStatusById } from "../utils/workflow/entity-resolver";
import type { ExecutionContext } from "./types";
import { logger } from "../utils/logger";
import { workflowEngine } from "../workflow-engine";
import { storage } from "../storage";
import { toWorkflowEvent } from "../utils/workflow/entity-adapter";

const log = logger('WorkflowActionHelpers');

/**
 * Apply a post-send entity status update if the step config requests one.
 *
 * Both send_email and send_sms support an optional `updateStatus` config field
 * that changes the trigger entity's status after a successful send. The logic
 * is identical in both handlers, so it lives here.
 *
 * Returns the (possibly appended) warning string if the update fails, or the
 * existing warning unchanged if no status update was requested.
 */
export async function applyPostSendStatusUpdate(
  config: Record<string, unknown>,
  context: ExecutionContext,
  existingWarning?: string
): Promise<string | undefined> {
  const { updateStatus } = config;
  if (!updateStatus || !context.triggerData?.id) {
    return existingWarning;
  }

  const statusStr = String(updateStatus);
  const entityId = String(context.triggerData.id);

  const statusUpdated = await updateEntityStatusById(
    context.triggerEntityType,
    entityId,
    statusStr,
    context.contractorId
  );

  if (!statusUpdated) {
    const statusWarning = `Entity status update failed for ${context.triggerEntityType} ${context.triggerData.id}`;
    log.warn(statusWarning);
    return existingWarning ? `${existingWarning}; ${statusWarning}` : statusWarning;
  }

  if (context.triggerEntityType === 'lead') {
    try {
      const contact = await storage.getContact(entityId, context.contractorId);
      if (contact) {
        const eventData = statusStr === 'aged'
          ? { ...toWorkflowEvent(contact), status: 'aged' }
          : toWorkflowEvent(contact);
        workflowEngine.triggerWorkflowsForEvent('contact_status_changed', eventData, context.contractorId).catch(err =>
          log.error('Error triggering workflows for post-send status change', err)
        );
      }
    } catch (err) {
      log.warn('Could not emit status-changed event after post-send status update', err);
    }
  }

  return existingWarning;
}
