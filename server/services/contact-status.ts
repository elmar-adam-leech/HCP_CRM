/**
 * contact-status.ts — single source of truth for "mark this contact as scheduled".
 *
 * Why this exists:
 *   Several code paths used to update `status: 'scheduled'` and/or `isScheduled: true`
 *   independently — in-app booking, public booking widget, HCP `lead.converted` webhook,
 *   HCP estimate linking, manual status dropdown, bulk status update. Each path had its
 *   own subtly different combination of: status flip, scheduledByUserId set, broadcast,
 *   activity log, and `contact_status_changed` workflow trigger. The result was that the
 *   "When Lead Status Changes to scheduled" workflow trigger silently failed for several
 *   booking paths (the in-app booking flow never set the status; the public booking widget
 *   set the status but never fired the trigger; HCP estimate linking did neither).
 *
 *   This helper centralizes the entire "scheduled transition" so that every code path
 *   produces the same observable side effects, exactly once, with no possibility of a
 *   double-fire or a forgotten dispatch.
 *
 * Idempotency contract:
 *   If the contact is already in the `scheduled` state when this helper is called, the
 *   workflow trigger is NOT re-fired and no status_change activity is written. The DB
 *   row may still be touched to set fields like `isScheduled: true`, `scheduledByUserId`,
 *   etc., so callers can safely use this as their single update path.
 */
import { storage } from "../storage";
import { broadcastToContractor } from "../websocket";
import { workflowEngine } from "../workflow-engine";
import { toWorkflowEvent } from "../utils/workflow/entity-adapter";
import { createActivityAndBroadcast } from "../utils/activity";
import { auditLog } from "../utils/audit-log";
import { logger } from "../utils/logger";
import type { Contact } from "@shared/schema";
import type { UpdateContact } from "../storage-types";

const log = logger('ContactStatus');

export type ScheduleSource =
  | 'in_app_booking'
  | 'public_booking'
  | 'hcp_lead_converted'
  | 'hcp_estimate_link'
  | 'manual_status_update'
  | 'bulk_status_update'
  | 'ai_agent';

export interface MarkScheduledOptions {
  /** User who initiated the scheduling action (if known). */
  scheduledByUserId?: string | null;
  /** Where the scheduling came from — used in logs/audit only. */
  source: ScheduleSource;
  /** Optional extra contact fields to set in the same DB write. */
  extraUpdates?: Partial<UpdateContact>;
  /** Override the activity log content. Defaults to "Contact status changed to Scheduled". */
  activityContent?: string;
  /** Optional: actor user id to attribute the activity log entry to. */
  activityUserId?: string | null;
  /**
   * Optional: external source label for the activity log entry. Used by the
   * frontend to render a sensible attribution fallback ("Online Booking",
   * "System") when no human user id is set. Pass 'public_booking',
   * 'housecall-pro', etc.
   */
  activityExternalSource?: string | null;
}

export interface MarkScheduledResult {
  contact: Contact | undefined;
  /** True if this call was the one that flipped status from non-scheduled to scheduled. */
  statusChanged: boolean;
  /** True if a `contact_status_changed` workflow trigger was dispatched. */
  workflowDispatched: boolean;
}

/**
 * Mark a contact as scheduled. Idempotent: re-firing the workflow trigger is suppressed
 * when the contact is already in the scheduled state.
 */
export async function markContactScheduled(
  contactId: string,
  contractorId: string,
  opts: MarkScheduledOptions,
): Promise<MarkScheduledResult> {
  const existing = await storage.getContact(contactId, contractorId);
  if (!existing) {
    log.warn(`markContactScheduled: contact not found (id=${contactId}, contractor=${contractorId}, source=${opts.source})`);
    return { contact: undefined, statusChanged: false, workflowDispatched: false };
  }

  const wasScheduled = existing.status === 'scheduled';

  const updates: Partial<UpdateContact> = { ...(opts.extraUpdates ?? {}) };
  if (!wasScheduled) {
    updates.status = 'scheduled';
  }
  if (!existing.isScheduled) {
    updates.isScheduled = true;
  }
  if (opts.scheduledByUserId && !existing.scheduledByUserId) {
    updates.scheduledByUserId = opts.scheduledByUserId;
  }

  let updated: Contact | undefined = existing;
  if (Object.keys(updates).length > 0) {
    updated = await storage.updateContact(contactId, updates, contractorId);
    if (!updated) {
      log.warn(`markContactScheduled: update returned no row (id=${contactId})`);
      return { contact: undefined, statusChanged: false, workflowDispatched: false };
    }
    broadcastToContractor(contractorId, {
      type: 'contact_updated',
      contactId: updated.id,
      contactType: updated.type,
    });
  }

  if (wasScheduled) {
    log.debug(`markContactScheduled: contact ${contactId} already scheduled — skipping workflow trigger (source=${opts.source})`);
    auditLog({
      contractorId,
      userId: opts.activityUserId ?? null,
      action: 'contact.schedule_skipped_idempotent',
      entityType: 'contact',
      entityId: contactId,
      after: { source: opts.source, reason: 'already_scheduled' },
    }).catch(err => log.error('Failed to write idempotent-skip audit log', err));
    return { contact: updated, statusChanged: false, workflowDispatched: false };
  }

  // Activity log for the status flip.
  try {
    await createActivityAndBroadcast(
      contractorId,
      {
        type: 'status_change',
        title: 'Status Changed',
        content: opts.activityContent ?? 'Contact status changed to Scheduled',
        contactId,
        userId: opts.activityUserId ?? undefined,
        externalSource: opts.activityExternalSource ?? undefined,
      },
      { type: 'new_activity', contactId },
    );
  } catch (activityErr) {
    log.error('Failed to create status_change activity for scheduled transition', activityErr);
  }

  // Fire the workflow trigger exactly once for this transition.
  workflowEngine
    .triggerWorkflowsForEvent('contact_status_changed', toWorkflowEvent(updated), contractorId)
    .catch(error => {
      log.error('Error triggering workflows for scheduled status change', error);
      auditLog({
        contractorId,
        action: 'workflow.trigger_failure',
        entityType: 'contact',
        entityId: contactId,
        after: {
          event: 'contact_status_changed',
          source: opts.source,
          error: error instanceof Error ? error.message : String(error),
        },
      }).catch(auditErr => log.error('Failed to write audit log for workflow trigger failure', auditErr));
    });

  return { contact: updated, statusChanged: true, workflowDispatched: true };
}
