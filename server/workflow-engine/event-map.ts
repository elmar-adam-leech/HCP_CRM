/**
 * Event mapping for the workflow engine.
 *
 * Each event type maps to an { entity, event } pair stored on workflow
 * `triggerConfig`. The trigger-matcher compares incoming events against
 * stored triggerConfig values to find subscribers.
 *
 * Trigger payload conventions (extra fields beyond the entity record):
 *
 *   estimate_option_approved / estimate_option_rejected:
 *     payload includes `approved_option` / `rejected_option`:
 *       { id, name, option_number, total_amount, approval_status_changed_at }
 *
 *   payment_received / deposit_received:
 *     payload includes `payment`:
 *       { amount, method, paid_at, is_deposit }
 *
 *   estimate_stale:
 *     payload is the enriched estimate at the time the staleness check resolved.
 */
export const EVENT_MAPPING: Record<string, { entity: string; event: string }> = {
  'contact_created':            { entity: 'lead',     event: 'created' },
  'contact_updated':            { entity: 'lead',     event: 'updated' },
  'contact_status_changed':     { entity: 'lead',     event: 'status_changed' },
  'estimate_created':           { entity: 'estimate', event: 'created' },
  'estimate_updated':           { entity: 'estimate', event: 'updated' },
  'estimate_status_changed':    { entity: 'estimate', event: 'status_changed' },
  'estimate_option_approved':   { entity: 'estimate', event: 'option_approved' },
  'estimate_option_rejected':   { entity: 'estimate', event: 'option_rejected' },
  'estimate_stale':             { entity: 'estimate', event: 'stale' },
  'job_created':                { entity: 'job',      event: 'created' },
  'job_updated':                { entity: 'job',      event: 'updated' },
  'job_status_changed':         { entity: 'job',      event: 'status_changed' },
  'job_paid':                   { entity: 'job',      event: 'paid' },
  'payment_received':           { entity: 'job',      event: 'payment_received' },
  'deposit_received':           { entity: 'job',      event: 'deposit_received' },
};

export type eventType =
  | 'contact_created'
  | 'contact_updated'
  | 'contact_status_changed'
  | 'estimate_created'
  | 'estimate_updated'
  | 'estimate_status_changed'
  | 'estimate_option_approved'
  | 'estimate_option_rejected'
  | 'estimate_stale'
  | 'job_created'
  | 'job_updated'
  | 'job_status_changed'
  | 'job_paid'
  | 'payment_received'
  | 'deposit_received';
