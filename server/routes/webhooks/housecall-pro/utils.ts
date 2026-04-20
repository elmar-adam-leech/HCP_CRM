import { utcToLocalDateStr } from "../../../services/availability-cache";

/**
 * Events that can change who is busy on a given day.
 * Split into two categories:
 *
 * POINT_IN_TIME_EVENTS: the payload contains the scheduled time so we can
 *   invalidate only the affected date(s).
 *
 * RESCHEDULE_EVENTS: the appointment may have moved from a *different* date
 *   that is not present in the new payload.  We fall back to a tenant-wide
 *   invalidation so the old date is also cleared.
 */
export const POINT_IN_TIME_EVENTS = new Set([
  'estimate.scheduled',
  'estimate.deleted',
  'job.scheduled',
  'job.created',
  'job.canceled',
  'job.completed',
  'job.deleted',
]);

export const RESCHEDULE_EVENTS = new Set([
  'estimate.updated',
  'job.updated',
]);

/**
 * Extract YYYY-MM-DD date strings (in the contractor's timezone) from an HCP
 * event payload.  Returns an empty array when no date can be determined — the
 * caller performs a broad tenant-level invalidation in that case.
 */
export function extractDatesFromPayload(data: any, timezone: string): string[] {
  const dates = new Set<string>();

  const candidates: Array<string | undefined | null> = [
    data?.scheduled_start,
    data?.scheduled_end,
    data?.schedule?.scheduled_start,
    data?.schedule?.scheduled_end,
    data?.start_time,
    data?.end_time,
    data?.starts_at,
    data?.ends_at,
  ];

  for (const ts of candidates) {
    if (ts) {
      const d = new Date(ts);
      if (!isNaN(d.getTime())) {
        dates.add(utcToLocalDateStr(d, timezone));
      }
    }
  }

  return Array.from(dates);
}

/**
 * Discriminates the result of a per-prefix handler:
 *   'not-handled' — handler did not recognize the event_type
 *   'continue'    — handler ran; dispatch should run availability invalidation + mark processed
 *   'stop'        — handler ran AND already finalized the webhook (e.g. early-return);
 *                   dispatch must skip the rest of the post-processing pipeline.
 */
export type HandlerResult = 'not-handled' | 'continue' | 'stop';
