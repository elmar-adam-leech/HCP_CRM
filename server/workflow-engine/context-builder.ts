import { storage } from "../storage";
import { extractVariablesFromEntity } from "../utils/workflow/variable-extractor";
import { getPublicBaseUrl } from "../utils/public-base-url";
import type { ExecutionContext } from "./types";

/**
 * Build an ExecutionContext for a workflow execution.
 *
 * Encapsulates:
 *   1. Contractor booking-slug lookup (best-effort — failure is non-fatal).
 *   2. Variable extraction from the trigger entity via extractVariablesFromEntity.
 *   3. Assembly of the ExecutionContext object.
 *
 * This helper removes the duplicated context-building block that previously
 * existed in both executeWorkflow and resumeSuspendedWorkflow.
 */
export async function buildExecutionContext(params: {
  workflowId: string;
  executionId: string;
  contractorId: string;
  workflowCreatorId: string;
  triggerData: Record<string, unknown>;
  triggerConfig: Record<string, unknown>;
}): Promise<ExecutionContext> {
  const { workflowId, executionId, contractorId, workflowCreatorId, triggerData, triggerConfig } = params;

  const entityType = (triggerConfig.entity as string | undefined) || 'lead';

  let bookingBaseUrl: string | undefined;
  let contractorSlugForBooking: string | undefined;
  try {
    const contractor = await storage.getContractor(contractorId);
    if (contractor?.bookingSlug) {
      const origin = getPublicBaseUrl();
      if (origin) {
        bookingBaseUrl = `${origin}/book/${contractor.bookingSlug}`;
      }
      contractorSlugForBooking = contractor.bookingSlug;
    }
  } catch { /* booking link is optional */ }

  const entityVariables = await extractVariablesFromEntity(triggerData, entityType, {
    bookingBaseUrl,
    contractorSlug: contractorSlugForBooking,
    contractorId,
  });

  const contactId = (entityType === 'lead' || entityType === 'contact')
    ? (triggerData.id as string | undefined)
    : undefined;

  return {
    workflowId,
    executionId,
    contractorId,
    workflowCreatorId,
    triggerEntityType: entityType,
    triggerData,
    contactId,
    variables: {
      [entityType]: entityVariables,
    },
  };
}
