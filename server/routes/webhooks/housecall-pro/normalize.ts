import { logger } from "../../../utils/logger";

const log = logger('HCPWebhook');

/**
 * Normalize the raw HCP webhook body into a consistent { event_type, data } shape.
 *
 * HCP sends `event` (not `event_type`) and wraps the entity under a top-level key
 * matching its type (e.g. `lead`, `customer`, `estimate`, `job`).
 * For lead events the customer contact info is further nested under `lead.customer`,
 * so we flatten those fields to the root of `data` so processHcpEvent can read them
 * with `data.first_name`, `data.email`, etc. as it always has.
 */
export function normalizeHcpPayload(body: any): { event_type: string | undefined; data: any; occurredAt?: Date } {
  const event_type: string | undefined = body?.event_type || body?.event;

  // HCP envelopes typically carry an ISO timestamp on the root under one of
  // these keys. We expose it so handlers can record exactly when the event
  // happened in HCP (e.g. approval_status_changed_at) instead of using
  // wall-clock time, which lags behind for queued or replayed webhooks.
  const occurredRaw = body?.occurred_at || body?.created_at || body?.timestamp;
  let occurredAt: Date | undefined;
  if (typeof occurredRaw === 'string' || typeof occurredRaw === 'number') {
    const d = new Date(occurredRaw);
    if (!Number.isNaN(d.getTime())) occurredAt = d;
  }

  if (!event_type) {
    return { event_type: undefined, data: body?.data ?? {}, occurredAt };
  }

  let data: any;

  if (event_type.startsWith('lead.')) {
    const lead = body.lead ?? body.data ?? {};
    const cust = lead.customer ?? {};
    data = {
      ...lead,
      first_name: cust.first_name ?? lead.first_name,
      last_name: cust.last_name ?? lead.last_name,
      email: cust.email ?? lead.email,
      phone: cust.mobile_number ?? cust.home_number ?? cust.work_number ?? cust.phone_number ?? lead.phone,
      source: lead.lead_source ?? lead.source,
      note: lead.notes ?? lead.note,
    };
  } else if (event_type.startsWith('customer.')) {
    data = body.customer ?? body.data ?? {};
  } else if (event_type.startsWith('estimate.')) {
    data = body.estimate ?? body.data ?? {};
  } else if (event_type.startsWith('job.')) {
    data = body.job ?? body.job_appointment ?? body.data ?? {};
  } else {
    data = body.data ?? {};
  }

  return { event_type, data, occurredAt };
}

/**
 * Detects HouseCall Pro's webhook URL verification ping. When a user clicks
 * Save in the HCP webhook configuration UI, HCP fires a single test POST with
 * body `{"foo":"bar"}` and no signature header / no URL token. We need to
 * 200 it before the auth chain runs, otherwise the user sees a 401 in the UI
 * and cannot save the URL.
 *
 * Returns true only when the body is an object with NO recognizable event
 * fields. Any payload carrying `event_type` / `event` / `lead` / `customer`
 * / `estimate` / `job` / `data` is treated as a real event and goes through
 * the existing HMAC + URL-token verification chain unchanged.
 */
export function isHcpVerificationPing(parsedBody: any): boolean {
  if (!parsedBody || typeof parsedBody !== 'object' || Array.isArray(parsedBody)) {
    return false;
  }
  const eventFields = ['event_type', 'event', 'lead', 'customer', 'estimate', 'job', 'data'];
  for (const field of eventFields) {
    if (field in parsedBody) {
      return false;
    }
  }
  return true;
}

// Re-export log for parity with original module's named logger usage.
export { log };
