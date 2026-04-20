import { storage } from "../../../storage";
import { db } from "../../../db";
import { webhookEvents } from "@shared/schema";
import { eq } from "drizzle-orm";
import { logger } from "../../../utils/logger";
import { invalidateAndRecompute } from "../../../services/availability-cache";
import { getAvailabilityForDate } from "../../../scheduling/availability";
import {
  POINT_IN_TIME_EVENTS,
  RESCHEDULE_EVENTS,
  extractDatesFromPayload,
  type HandlerResult,
} from "./utils";
import { handleLeadEvent } from "./handlers/leads";
import { handleEstimateEvent } from "./handlers/estimates";
import { handleJobEvent } from "./handlers/jobs";
import { handleCustomerEvent } from "./handlers/customers";

const log = logger('HCPWebhook');

/**
 * Dispatch an HCP webhook event to the appropriate handler, then run the
 * post-processing pipeline (availability cache invalidation + mark processed).
 *
 * Mirrors the behaviour of the original `processHcpEvent` exactly: the only
 * structural change is splitting the giant if/else chain into per-prefix
 * handlers selected here.
 */
export async function processHcpEvent(
  contractorId: string,
  event_type: string,
  data: any,
  webhookEventId: string | undefined,
  occurredAt?: Date,
): Promise<void> {
  let result: HandlerResult = 'not-handled';

  if (event_type.startsWith('lead.')) {
    result = await handleLeadEvent(contractorId, event_type, data, webhookEventId);
  } else if (event_type.startsWith('estimate.')) {
    result = await handleEstimateEvent(contractorId, event_type, data, webhookEventId, occurredAt);
  } else if (event_type.startsWith('job.')) {
    result = await handleJobEvent(contractorId, event_type, data, webhookEventId);
  } else if (event_type.startsWith('customer.')) {
    result = await handleCustomerEvent(contractorId, event_type, data, webhookEventId);
  }

  if (result === 'stop') {
    return;
  }

  if (result === 'not-handled') {
    log.info(`Unhandled event type: ${event_type}`);
  }

  // Invalidate the availability cache for any schedule-affecting event so
  // that the booking calendar always reflects the latest HCP state.
  const isPointInTime = POINT_IN_TIME_EVENTS.has(event_type) || event_type.startsWith('job.appointment.');
  const isReschedule = RESCHEDULE_EVENTS.has(event_type);
  if (isPointInTime || isReschedule) {
    // Resolve contractor timezone so date extraction and recompute use the
    // correct local calendar day rather than UTC.
    const contractorRow = await storage.getContractor(contractorId);
    const timezone = (contractorRow && 'timezone' in contractorRow && typeof contractorRow.timezone === 'string' ? contractorRow.timezone : null) ?? 'America/New_York';

    if (isReschedule) {
      // Reschedule events (estimate.updated, job.updated) may have moved the
      // appointment from a date not present in the new payload.  Perform a
      // tenant-wide invalidation to ensure the old date is also cleared.
      log.info(`[availability-cache] Webhook ${event_type} (reschedule) → tenant-wide invalidation tenant=${contractorId}`);
      invalidateAndRecompute(contractorId, timezone, getAvailabilityForDate, null);
    } else {
      const affectedDates = extractDatesFromPayload(data, timezone);
      log.info(`[availability-cache] Webhook ${event_type} → invalidating tenant=${contractorId} tz=${timezone} dates=${affectedDates.length > 0 ? affectedDates.join(',') : 'all'}`);
      invalidateAndRecompute(
        contractorId,
        timezone,
        getAvailabilityForDate,
        affectedDates.length > 0 ? affectedDates : null
      );
    }
  }

  if (webhookEventId) {
    await db.update(webhookEvents)
      .set({ processed: true })
      .where(eq(webhookEvents.id, webhookEventId));
  }
}
