import { updateEntityById } from "../utils/workflow/entity-resolver";
import type { ExecutionContext, StepResult } from "./types";
import { logger } from "../utils/logger";
import { workflowEngine } from "../workflow-engine";
import { storage } from "../storage";
import { toWorkflowEvent } from "../utils/workflow/entity-adapter";

const log = logger('WorkflowUpdateEntity');

export async function handleUpdateEntity(
  config: Record<string, unknown>,
  context: ExecutionContext
): Promise<StepResult> {
  try {
    const { entityType, entityId, updates } = config;
    const entityIdStr = String(entityId ?? context.triggerData?.id ?? '');
    const resolvedEntityType = String(entityType ?? context.triggerEntityType ?? 'lead');

    if (!entityIdStr) {
      return { success: false, error: 'Cannot update entity: no entity ID available (trigger entity has no id)' };
    }

    log.info(`Updating ${resolvedEntityType} ${entityIdStr}`);

    await updateEntityById(resolvedEntityType, entityIdStr, updates as Record<string, unknown>, context.contractorId);

    if (resolvedEntityType === 'lead') {
      const upd = updates as Record<string, unknown> | undefined;
      const isAged = upd?.aged === true || upd?.aged === 'true';
      if (isAged || upd?.status) {
        try {
          const contact = await storage.getContact(entityIdStr, context.contractorId);
          if (contact) {
            const eventData = isAged
              ? { ...toWorkflowEvent(contact), status: 'aged' }
              : toWorkflowEvent(contact);
            workflowEngine.triggerWorkflowsForEvent('contact_status_changed', eventData, context.contractorId).catch(err =>
              log.error('Error triggering workflows for status change after update_entity', err)
            );
          }
        } catch (err) {
          log.warn('Could not emit status-changed event after update_entity', err);
        }
      }
    }

    return { success: true, data: { entityType: resolvedEntityType, entityId: entityIdStr } };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to update entity',
    };
  }
}
