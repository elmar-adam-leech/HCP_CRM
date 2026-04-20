import { storage } from "../storage";
import type { ExecutionContext, StepResult } from "./types";
import { logger } from "../utils/logger";

const log = logger('WorkflowSetFollowUp');

export async function handleSetFollowUp(
  config: Record<string, unknown>,
  context: ExecutionContext
): Promise<StepResult> {
  try {
    const offsetDays = Number(config.offsetDays ?? 1);
    const entityType = String(context.triggerEntityType ?? 'lead');
    const entityId = String(context.triggerData?.id ?? '');

    if (!entityId) {
      return { success: false, error: 'No entity ID available from trigger' };
    }

    const followUpDate = new Date();
    followUpDate.setDate(followUpDate.getDate() + offsetDays);
    followUpDate.setHours(9, 0, 0, 0);

    log.info(`Setting follow-up on ${entityType} ${entityId} to ${followUpDate.toISOString()} (${offsetDays} days out)`);

    switch (entityType) {
      case 'lead': {
        const updated = await storage.updateContact(entityId, { followUpDate }, context.contractorId);
        if (!updated) {
          return { success: false, error: `Contact ${entityId} not found` };
        }
        break;
      }
      case 'estimate': {
        const updated = await storage.updateEstimate(entityId, { followUpDate }, context.contractorId);
        if (!updated) {
          return { success: false, error: `Estimate ${entityId} not found` };
        }
        break;
      }
      default:
        return { success: false, error: `Set Follow Up is not supported for entity type: ${entityType}` };
    }

    return {
      success: true,
      data: { entityType, entityId, followUpDate: followUpDate.toISOString() },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to set follow-up date',
    };
  }
}
