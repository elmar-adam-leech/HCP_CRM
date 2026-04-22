/**
 * entity-resolver.ts — single source of truth for the entityType → storage method mapping.
 *
 * Previously the same switch statement appeared in three places:
 *   - server/workflow-engine.ts  (updateEntityStatus)
 *   - server/workflow-actions/update-entity.ts  (handleUpdateEntity)
 *   - server/workflow-actions/assign-user.ts    (handleAssignUser)
 *
 * All three now delegate here, so adding a new entity type requires one edit.
 */
import { storage } from "../../storage";

export type KnownEntityType = 'lead' | 'estimate' | 'job';

export function isKnownEntityType(entityType: string): entityType is KnownEntityType {
  return entityType === 'lead' || entityType === 'estimate' || entityType === 'job';
}

/**
 * Apply a partial update to the entity identified by `entityType` + `entityId`.
 * Throws if the entityType is unrecognised.
 */
export async function updateEntityById(
  entityType: string,
  entityId: string,
  updates: Record<string, unknown>,
  contractorId: string,
): Promise<void> {
  switch (entityType) {
    case 'lead': {
      const { aged, archived, ...contactUpdates } = updates;
      if (Object.keys(contactUpdates).length > 0) {
        await storage.updateContact(entityId, contactUpdates, contractorId);
      }
      const agedBool = aged === true || aged === 'true' ? true : aged === false || aged === 'false' ? false : undefined;
      if (agedBool === true) {
        await storage.ageLead(entityId, contractorId);
      } else if (agedBool === false) {
        await storage.unageLead(entityId, contractorId);
      }
      const archivedBool = archived === true || archived === 'true' ? true : archived === false || archived === 'false' ? false : undefined;
      if (archivedBool === true) {
        await storage.archiveLead(entityId, contractorId);
      } else if (archivedBool === false) {
        await storage.restoreLead(entityId, contractorId);
      }
      break;
    }
    case 'estimate':
      await storage.updateEstimate(entityId, updates, contractorId);
      break;
    case 'job':
      await storage.updateJob(entityId, updates, contractorId);
      break;
    default:
      throw new Error(`Unknown entity type: ${entityType}`);
  }
}

/**
 * Update the status field of the entity identified by `entityType` + `entityId`.
 * Returns `true` on success, `false` if the entityType is unknown (non-throwing).
 */
export async function updateEntityStatusById(
  entityType: string,
  entityId: string,
  status: string,
  contractorId: string,
): Promise<boolean> {
  try {
    switch (entityType) {
      case 'lead':
        if (status === 'aged') {
          await storage.ageLead(entityId, contractorId);
        } else {
          await storage.updateContact(
            entityId,
            { status: status as 'new' | 'contacted' | 'scheduled' | 'active' | 'disqualified' | 'inactive' | 'lost' },
            contractorId,
          );
        }
        break;
      case 'estimate':
        await storage.updateEstimate(
          entityId,
          { status: status as 'sent' | 'scheduled' | 'in_progress' | 'approved' | 'rejected' },
          contractorId,
        );
        break;
      case 'job':
        await storage.updateJob(
          entityId,
          { status: status as 'scheduled' | 'in_progress' | 'completed' | 'cancelled' },
          contractorId,
        );
        break;
      default:
        return false;
    }
    return true;
  } catch {
    return false;
  }
}
