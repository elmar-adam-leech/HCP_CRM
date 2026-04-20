import { storage } from "../storage";
import type { ExecutionContext, StepResult } from "./types";
import { logger } from "../utils/logger";

const log = logger('WorkflowAssignUser');

export async function handleAssignUser(
  config: Record<string, unknown>,
  context: ExecutionContext
): Promise<StepResult> {
  try {
    const { entityType, entityId, userId } = config;
    const entityIdStr = String(entityId ?? context.triggerData?.id ?? '');
    const userIdStr = String(userId ?? '');
    const resolvedEntityType = String(entityType ?? context.triggerEntityType ?? 'lead');

    if (!userIdStr) {
      return { success: false, error: 'Cannot assign user: no userId configured on this node' };
    }
    if (!entityIdStr) {
      return { success: false, error: 'Cannot assign user: no entity ID available (trigger entity has no id)' };
    }

    log.info(`Assigning user ${userIdStr} to ${resolvedEntityType} ${entityIdStr}`);

    switch (resolvedEntityType) {
      case 'lead': {
        const allLeads = await storage.getLeadsByContact(entityIdStr, context.contractorId);
        const activeLead = allLeads.find(l => !l.archived);

        if (activeLead) {
          await storage.updateLead(activeLead.id, { assignedToUserId: userIdStr }, context.contractorId);
          log.info(`Assigned user ${userIdStr} to lead ${activeLead.id} (via contact ${entityIdStr})`);
          return { success: true, data: { entityType: resolvedEntityType, entityId: activeLead.id, userId: userIdStr } };
        }

        const directLead = await storage.getLead(entityIdStr, context.contractorId);
        if (directLead) {
          await storage.updateLead(directLead.id, { assignedToUserId: userIdStr }, context.contractorId);
          log.info(`Assigned user ${userIdStr} to lead ${directLead.id} (direct lead ID)`);
          return { success: true, data: { entityType: resolvedEntityType, entityId: directLead.id, userId: userIdStr } };
        }

        return {
          success: false,
          error: `Cannot assign user: no active lead found for contact or lead ID ${entityIdStr}`,
        };
      }
      case 'estimate':
        return {
          success: false,
          error: `Assign user is not supported for estimates (estimates inherit assignment from their lead)`,
        };
      case 'job':
        return {
          success: false,
          error: `Assign user is not supported for jobs (jobs inherit assignment from their estimate)`,
        };
      default:
        return { success: false, error: `Unknown entity type: ${resolvedEntityType}` };
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to assign user',
    };
  }
}
