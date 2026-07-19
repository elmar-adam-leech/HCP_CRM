import { storage } from "../storage";
import { logger } from "../utils/logger";
import { auditLog } from "../utils/audit-log";
import { EVENT_MAPPING } from "./event-map";
import type { eventType } from "./event-map";

const log = logger('WorkflowEngine');

export type { eventType };

export interface MatchedWorkflow {
  workflow: Awaited<ReturnType<typeof storage.getActiveApprovedWorkflows>>[number];
  triggerConfig: Record<string, unknown>;
}

/**
 * Reason a candidate workflow was filtered out — surfaced to the audit log so
 * "why didn't my workflow run?" is a 30-second lookup instead of an investigation.
 *
 * Each value is intentionally short and machine-grep-able (no embedded user content).
 * The `target_status_mismatch:expected=X,got=Y` form encodes both ends so an operator
 * can spot the gap without correlating against the workflow definition.
 */
type SkipReason =
  | 'entity_mismatch'
  | 'event_mismatch'
  | 'entity_type_not_lead'
  | 'tag_mismatch'
  | `target_status_mismatch:expected=${string},got=${string}`;

interface SkipEntry {
  workflowId: string;
  workflowName: string;
  reason: SkipReason;
}

/**
 * Match active/approved workflows to a business event, enrich the entity data
 * with related records, and return the list of matching workflows + enriched entity.
 *
 * Flow:
 *   1. Map the eventType to its { entity, event } shape.
 *   2. Fetch all active + approved workflows from the DB (single query).
 *   3. Filter in-memory by trigger config (entity, event, status, tags).
 *      For every skipped workflow we record a one-line reason so the audit
 *      log can answer "why didn't my workflow run?" instantly.
 *   4. Enrich the entity data with related records (contact, etc.) ONCE — before
 *      the loop — so the enrichment DB call is O(1) regardless of how many
 *      workflows match. (Previously it was inside the loop, causing N extra queries.)
 *   5. For `contact_status_changed` events we persist a `workflow.trigger_dispatch`
 *      audit log entry summarizing the dispatch (candidate count, matched ids,
 *      per-skip reason). This is the diagnostic that closes the "silent miss"
 *      class of bug — every status_changed dispatch leaves an inspectable trail.
 *
 * Returns null when the eventType is unknown.
 */
export async function matchAndEnrichWorkflows(
  eventType: eventType,
  entityData: Record<string, unknown>,
  contractorId: string,
): Promise<{ matchingWorkflows: MatchedWorkflow[]; enrichedData: Record<string, unknown> } | null> {
  const mapping = EVENT_MAPPING[eventType];
  if (!mapping) {
    log.info(`Unknown event type: ${eventType}`);
    return null;
  }

  const candidateWorkflows = await storage.getActiveApprovedWorkflows(contractorId);

  type ParsedWorkflow = MatchedWorkflow;
  const parsedWorkflows: ParsedWorkflow[] = candidateWorkflows.map(workflow => ({
    workflow,
    triggerConfig: workflow.triggerConfig ? JSON.parse(workflow.triggerConfig) : {},
  }));

  const skipped: SkipEntry[] = [];
  const matchingWorkflows = parsedWorkflows.filter(({ workflow, triggerConfig }) => {
    if (triggerConfig.entity !== mapping.entity) {
      skipped.push({ workflowId: workflow.id, workflowName: workflow.name, reason: 'entity_mismatch' });
      return false;
    }
    if (triggerConfig.event !== mapping.event) {
      skipped.push({ workflowId: workflow.id, workflowName: workflow.name, reason: 'event_mismatch' });
      return false;
    }

    if (mapping.entity === 'lead' && entityData.type !== 'lead') {
      log.debug(`Workflow "${workflow.name}" skipped - contact type "${entityData.type}" does not match lead trigger`);
      skipped.push({ workflowId: workflow.id, workflowName: workflow.name, reason: 'entity_type_not_lead' });
      return false;
    }

    if (triggerConfig.event === 'status_changed' && triggerConfig.targetStatus) {
      if (entityData.status !== triggerConfig.targetStatus) {
        skipped.push({
          workflowId: workflow.id,
          workflowName: workflow.name,
          reason: `target_status_mismatch:expected=${String(triggerConfig.targetStatus)},got=${String(entityData.status)}`,
        });
        return false;
      }
    }

    if (triggerConfig.tags && Array.isArray(triggerConfig.tags) && triggerConfig.tags.length > 0) {
      const contactRecord = entityData.contact as Record<string, unknown> | undefined;
      const contactTags = (entityData.tags as string[] | undefined) || (contactRecord?.tags as string[] | undefined) || [];
      const hasRequiredTag = triggerConfig.tags.some((requiredTag: string) =>
        contactTags.includes(requiredTag)
      );
      if (!hasRequiredTag) {
        log.debug(`Workflow "${workflow.name}" skipped - contact tags ${JSON.stringify(contactTags)} don't match required tags ${JSON.stringify(triggerConfig.tags)}`);
        skipped.push({ workflowId: workflow.id, workflowName: workflow.name, reason: 'tag_mismatch' });
        return false;
      }
    }

    return true;
  });

  log.debug(`Found ${matchingWorkflows.length} matching workflows for ${eventType}`);

  // Diagnostic audit trail. Originally scoped to contact_status_changed only, but
  // every other trigger (estimate_*, job_*, contact_created, ...) suffered the same
  // "why didn't my workflow run?" silent-failure mode — so we now log decisions for
  // ALL event types.
  //
  // Volume cap: writing a row for every contact_updated / estimate_updated would
  // explode audit storage on busy contractors. We bound volume by suppressing the
  // entry when no candidate workflow even targeted this entity+event — i.e. all
  // skips were the "wrong entity" or "wrong event" noise. In that case there is
  // nothing operationally interesting to surface (no decision was made about any
  // user-configured trigger). We also drop those noise reasons from the persisted
  // `skipped` array so the audit row only carries actionable signal.
  const noiseReasons = new Set<SkipReason>(['entity_mismatch', 'event_mismatch']);
  const meaningfulSkipped = skipped.filter(s => !noiseReasons.has(s.reason));
  const shouldEmit = matchingWorkflows.length > 0 || meaningfulSkipped.length > 0;
  if (shouldEmit) {
    // entityType for the audit row mirrors the trigger's entity so the
    // dispatch-decisions endpoint and Trigger Decisions tab can rely on it.
    // Estimate/job entities are joined to a parent contact for naming, but the
    // audit row is keyed by the entity that actually fired the event.
    const auditEntityType = mapping.entity === 'lead' ? 'contact' : mapping.entity;
    const entityName = typeof entityData.name === 'string'
      ? entityData.name
      : typeof entityData.title === 'string'
        ? entityData.title
        : null;

    auditLog({
      contractorId,
      action: 'workflow.trigger_dispatch',
      entityType: auditEntityType,
      entityId: typeof entityData.id === 'string' ? entityData.id : undefined,
      after: {
        event: eventType,
        entity: mapping.entity,
        entityName,
        targetStatus: typeof entityData.status === 'string' ? entityData.status : null,
        candidateCount: parsedWorkflows.length,
        matchedCount: matchingWorkflows.length,
        matchedWorkflowIds: matchingWorkflows.map(m => m.workflow.id),
        skipped: meaningfulSkipped.slice(0, 50), // cap to keep payload bounded
        skippedTotal: meaningfulSkipped.length,
      },
    }).catch(err => log.error('Failed to write workflow.trigger_dispatch audit log', err));
  }

  let enrichedData: Record<string, unknown> = entityData;
  const isEstimateEvent = eventType.startsWith('estimate_') || eventType === 'estimate_reply_received';
  const isJobEvent = eventType.startsWith('job_') || eventType === 'job_reply_received';
  const isLeadEvent = eventType.startsWith('lead_') || eventType === 'lead_reply_received' || eventType.startsWith('contact_');
  if (isEstimateEvent && entityData.id) {
    const enriched = await storage.getEstimateWithContact(String(entityData.id), contractorId);
    if (enriched) enrichedData = enriched as unknown as Record<string, unknown>;
  } else if (isJobEvent && entityData.id) {
    const enriched = await storage.getJobWithContact(String(entityData.id), contractorId);
    if (enriched) enrichedData = enriched as unknown as Record<string, unknown>;
  } else if (isLeadEvent && entityData.id) {
    // For lead/contact events, try to enrich with contact if a lead id is provided
    try {
      const lead = await storage.getLead(String(entityData.id), contractorId);
      if (lead) {
        const contact = lead.contactId ? await storage.getContact(String(lead.contactId), contractorId) : null;
        enrichedData = contact ? { ...lead, contact } : lead;
      }
    } catch {}
  }

  return { matchingWorkflows, enrichedData };
}
