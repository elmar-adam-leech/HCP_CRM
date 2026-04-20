import type { HcpEstimate, HcpJob, HcpRawLineItem } from './hcp-types';
import type { HcpLineItem } from '@shared/schema';
import { db } from '../db';
import { employees, userContractors } from '@shared/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { logger } from '../utils/logger';

const mapLog = logger('HcpMappers');

/**
 * Maps a Housecall Pro estimate to this CRM's estimate status.
 *
 * HCP represents estimate state across THREE sources:
 *   `work_status`              — the technician workflow state (e.g. "completed", "scheduled")
 *   `status`                   — the customer-facing sales state  (e.g. "approved", "sent")
 *   `options[].approval_status` — per-option approval (e.g. "approved")
 *
 * All three are checked so the mapping is robust regardless of which one HCP
 * populates for a given estimate version.
 *
 * Key non-obvious mapping decisions:
 *   option approval_status "approved" → 'approved':  If any option is approved and
 *     the estimate is not in a terminal state, the estimate is considered approved.
 *   "completed" work_status → 'approved':  In HCP, work marked "completed" means
 *     the customer accepted and the job was done — that's our "approved" state.
 *   "expired"/"deleted"/"void"/"voided" → 'rejected':  These terminal states map
 *     to our "rejected" bucket so they don't clutter the Pending view.
 *   "scheduled" work_status → 'scheduled':  HCP marks an estimate "scheduled" when an
 *     appointment is booked to present it — now mapped as a first-class status.
 *   "in_progress" work_status → 'in_progress':  HCP marks an estimate "in_progress" when
 *     the estimate has been accepted and the associated job is actively running.
 */
/**
 * Normalize an HCP option approval_status string and decide whether it
 * indicates a rejection. HCP emits variants like "declined", "pro declined",
 * "customer declined", "expired" (and historically the underscored forms
 * "pro_declined", "customer_declined"). This predicate handles all of them
 * by lowercasing, collapsing whitespace and underscores, and checking for
 * the substrings "declined", "rejected", "canceled"/"cancelled", or
 * "expired" / "void".
 */
export function isHcpDeclinedOptionStatus(s: string | null | undefined): boolean {
  if (!s) return false;
  const norm = s.toLowerCase().replace(/[_\s]+/g, ' ').trim();
  if (norm === 'approved' || norm === 'pro approved' || norm === 'customer approved') return false;
  return /\b(declined|rejected|canceled|cancelled|expired|void(?:ed)?)\b/.test(norm);
}

/** Same idea for the top-level estimate `status` / `work_status` strings. */
export function isHcpRejectedEstimateStatus(s: string | null | undefined): boolean {
  if (!s) return false;
  const norm = s.toLowerCase().replace(/[_\s]+/g, ' ').trim();
  return /\b(canceled|cancelled|rejected|declined|expired|deleted|void(?:ed)?)\b/.test(norm);
}

/** True when an HCP option approval_status indicates explicit approval. */
export function isHcpApprovedOptionStatus(s: string | null | undefined): boolean {
  if (!s) return false;
  const norm = s.toLowerCase().replace(/[_\s]+/g, ' ').trim();
  return norm === 'approved' || norm === 'pro approved' || norm === 'customer approved';
}

/**
 * Predicate replacing the historical `HCP_EXCLUDED_ESTIMATE_STATUSES` array.
 * Returns true if the HCP `status`/`work_status` string indicates the
 * estimate should be hidden from scheduling visibility (terminated,
 * completed, unscheduled, or any rejection-like variant including the
 * space-separated `"pro declined"` / `"customer declined"` forms).
 */
export function isHcpExcludedEstimateStatus(s: string | null | undefined): boolean {
  if (!s) return false;
  const norm = s.toLowerCase().replace(/[_\s]+/g, ' ').trim();
  if (norm === 'completed' || norm === 'unscheduled') return true;
  return isHcpRejectedEstimateStatus(s) || isHcpDeclinedOptionStatus(s);
}

export function mapHcpEstimateStatus(hcpEstimate: { status?: string; work_status?: string; options?: Array<{ approval_status?: string }> }): 'approved' | 'rejected' | 'scheduled' | 'sent' | 'in_progress' {
  const ws = (hcpEstimate.work_status || '').toLowerCase();
  const st = (hcpEstimate.status || '').toLowerCase();
  if (isHcpRejectedEstimateStatus(ws) || isHcpRejectedEstimateStatus(st)) return 'rejected';
  const opts = Array.isArray(hcpEstimate.options) ? hcpEstimate.options : [];
  const hasApproved = opts.some(o => isHcpApprovedOptionStatus(o.approval_status));
  if (hasApproved) return 'approved';
  // New rule: if no option is approved but at least one is rejection-like,
  // treat the parent estimate as rejected.
  if (opts.length > 0 && opts.some(o => isHcpDeclinedOptionStatus(o.approval_status))) return 'rejected';
  if (['completed','approved','accepted'].some(v => ws === v || st === v)) return 'approved';
  if (ws === 'in_progress') return 'in_progress';
  if (ws === 'scheduled') return 'scheduled';
  if (['sent','dispatched','awaiting_approval','awaiting_review','in_review','client_sent'].some(v => ws === v || st === v)) return 'sent';
  if (['pending','draft','needs_scheduling','unscheduled'].some(v => ws === v || st === v)) return 'scheduled';
  return 'scheduled';
}

export type EstimateStatus = 'approved' | 'rejected' | 'scheduled' | 'sent' | 'in_progress';

/**
 * Forward-progression order used when reconciling HCP polling/webhook updates
 * with the local status. Polling moves an estimate forward through these
 * steps; it never moves the status backwards. (`rejected` is terminal and
 * handled separately.)
 */
const STATUS_ORDER: Record<EstimateStatus, number> = {
  scheduled: 0,
  sent: 1,
  in_progress: 2,
  approved: 3,
  rejected: 99,
};

/**
 * Merge an HCP-derived estimate status with the existing local status,
 * applying the rules that protect manual user changes and prevent the
 * polling sync from silently downgrading or regressing the local status.
 *
 * Rules (in priority order):
 *   1. A terminal `rejected` from HCP always wins (covers cancelled / declined).
 *   2. If the user has manually set the status in the CRM UI
 *      (`manuallySet === true`), the local status is preserved — HCP can no
 *      longer overwrite it (except via rule 1).
 *   3. Polling/webhook updates are forward-only. If the mapped HCP status is
 *      not strictly more advanced than the local status (per `STATUS_ORDER`),
 *      the local status is kept. This blocks both the historical
 *      `* -> scheduled` regression and other unintended downgrades like
 *      `approved -> sent` or `in_progress -> sent`.
 *   4. Otherwise the mapped HCP status wins.
 */
export function resolveHcpEstimateStatus(
  mapped: EstimateStatus,
  existingLocalStatus: EstimateStatus,
  manuallySet: boolean,
): EstimateStatus {
  if (mapped === 'rejected') return 'rejected';
  if (manuallySet) return existingLocalStatus;
  if (STATUS_ORDER[mapped] <= STATUS_ORDER[existingLocalStatus]) {
    return existingLocalStatus;
  }
  return mapped;
}

export function mapHcpJobStatus(workStatus: string): 'completed' | 'cancelled' | 'scheduled' | 'in_progress' {
  const normalized = (workStatus || '').trim().toLowerCase().replace(/\s+/g, '_');
  switch (normalized) {
    case 'completed':
    case 'paid':
    case 'invoice_paid':
    case 'invoiced':
      return 'completed';
    case 'canceled':
    case 'cancelled':
    case 'cancellation_requested':
      return 'cancelled';
    case 'scheduled':
    case 'needs_scheduling':
      return 'scheduled';
    case 'started':
    case 'in_progress':
    case 'on_my_way':
      return 'in_progress';
    default:
      return 'in_progress';
  }
}

/**
 * Extracts the best available dollar amount from an HCP estimate response.
 * HCP returns total_amount in cents (same as job endpoints).
 * Prefers the approved option's total_amount, falls back to the first option.
 */
export function extractHcpAmount(e: HcpEstimate): number {
  if (Array.isArray(e.options) && e.options.length > 0) {
    const approved = e.options.find(o => o.approval_status === 'approved');
    const pick = approved || e.options[0];
    const amt = (Number(pick.total_amount) || 0) / 100;
    if (amt > 0) return amt;
  }
  const raw = e.total ?? e.total_price ?? e.estimate_total ?? e.amount ?? 0;
  const amt = (typeof raw === 'number' && raw > 0) ? raw / 100 : 0;
  return amt;
}

/**
 * Derives the best available display title from an HCP job response.
 * Falls back through invoice_number → description → generic label.
 */
export function extractHcpJobTitle(job: HcpJob): string {
  if (job.invoice_number) return `Job #${job.invoice_number}`;
  return job.description || 'Job from Housecall Pro';
}

/**
 * Extracts the primary scheduled employee ID from an HCP estimate.
 *
 * HCP stores the assigned employee across multiple overlapping fields
 * depending on the API version and endpoint:
 *   1. Top-level `employee_id` / `assigned_employee_id` (legacy)
 *   2. `assigned_employees[0].id` (v2 top-level array)
 *   3. `options[].dispatched_employees[0].id` (per-option dispatching)
 *   4. `options[].schedule.dispatched_employees[0].id` (schedule-nested)
 *
 * Returns the first match found, or null if none is present.
 */
export function extractHcpScheduledEmployeeId(input: unknown): string | null {
  const e = input as Record<string, unknown>;
  if (!e || typeof e !== 'object') return null;
  if (typeof e.employee_id === 'string' && e.employee_id) return e.employee_id;
  if (typeof e.assigned_employee_id === 'string' && e.assigned_employee_id) return e.assigned_employee_id;
  if (Array.isArray(e.assigned_employees) && e.assigned_employees.length > 0) {
    const first = e.assigned_employees[0] as Record<string, unknown>;
    if (first && typeof first.id === 'string') return first.id;
  }
  if (Array.isArray(e.options)) {
    for (const opt of e.options) {
      const o = opt as Record<string, unknown>;
      if (Array.isArray(o.dispatched_employees) && o.dispatched_employees.length > 0) {
        const emp = o.dispatched_employees[0] as Record<string, unknown>;
        if (typeof emp.id === 'string') return emp.id;
      }
      const sched = o.schedule as Record<string, unknown> | undefined;
      if (sched && Array.isArray(sched.dispatched_employees) && sched.dispatched_employees.length > 0) {
        const emp = sched.dispatched_employees[0] as Record<string, unknown>;
        if (typeof emp.id === 'string') return emp.id;
      }
    }
  }
  return null;
}

/**
 * Derives the best available display title from an HCP estimate response.
 * Falls back through several fields in priority order.
 */
export function extractHcpEstimateTitle(e: HcpEstimate): string {
  const number = e.number || e.estimate_number;
  if (number) {
    return `Estimate #${number}`;
  }
  return (
    e.name ||
    (e.description && e.description !== '' ? e.description : null) ||
    `Estimate #${e.id}`
  );
}

/**
 * Coerces a raw HCP line-item amount (cents, possibly string) into dollars.
 * Returns 0 for missing/non-numeric input.
 */
function centsToDollars(raw: number | string | undefined): number {
  if (raw === undefined || raw === null) return 0;
  const n = typeof raw === 'string' ? Number(raw) : raw;
  if (!Number.isFinite(n)) return 0;
  return n / 100;
}

const ALLOWED_LINE_ITEM_KINDS = new Set(['labor', 'material', 'service', 'fee', 'discount']);

/**
 * Builds the local representation of HCP line items, drawing from either an
 * estimate (where line items live under each option), a job (top-level
 * `line_items`), or any object with a `line_items` array. Filters out junk
 * entries (no id and no name), coerces amounts from cents to dollars, and
 * normalises the `kind` field to our enum (other strings are dropped).
 */
export function buildHcpLineItems(input: unknown): HcpLineItem[] | undefined {
  const src = input as { line_items?: HcpRawLineItem[]; options?: Array<{ line_items?: HcpRawLineItem[] }> } | null | undefined;
  return _buildHcpLineItemsImpl(src);
}

function _buildHcpLineItemsImpl(input: { line_items?: HcpRawLineItem[]; options?: Array<{ line_items?: HcpRawLineItem[] }> } | null | undefined): HcpLineItem[] | undefined {
  if (!input) return undefined;
  const collected: HcpRawLineItem[] = [];
  if (Array.isArray(input.line_items)) collected.push(...input.line_items);
  if (Array.isArray((input as { options?: Array<{ line_items?: HcpRawLineItem[] }> }).options)) {
    for (const opt of (input as { options?: Array<{ line_items?: HcpRawLineItem[] }> }).options ?? []) {
      if (Array.isArray(opt?.line_items)) collected.push(...opt.line_items);
    }
  }
  if (collected.length === 0) return undefined;

  const cleaned: HcpLineItem[] = [];
  for (const raw of collected) {
    if (!raw || typeof raw !== 'object') continue;
    const id = raw.id || raw.uuid;
    const name = raw.name || raw.description;
    if (!id || !name) continue;

    const quantity = (() => {
      const q = typeof raw.quantity === 'string' ? Number(raw.quantity) : raw.quantity;
      return Number.isFinite(q) && q !== undefined ? Number(q) : 1;
    })();
    const unit_price = centsToDollars(raw.unit_price ?? raw.unit_cost);
    const total = centsToDollars(raw.total ?? raw.total_amount ?? raw.amount);

    const kindRaw = (raw.kind || raw.type || '').toString().toLowerCase();
    const kind = ALLOWED_LINE_ITEM_KINDS.has(kindRaw) ? kindRaw : undefined;

    cleaned.push({
      id,
      name,
      description: raw.description,
      quantity,
      unit_price,
      total,
      kind,
      service_item_id: raw.service_item_id,
    });
  }
  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * Resolves the CRM user (users.id) for the salesperson on an HCP entity.
 *
 * Looks up the first assigned HCP employee in the local `employees` table for
 * the tenant, then follows `employees.user_contractor_id` →
 * `user_contractors.user_id`. Returns null when:
 *   - No assigned employee was provided
 *   - The HCP employee is not in the local table yet
 *   - The local employee row has no `user_contractor_id` set
 *   - The linked `user_contractor` row no longer exists
 *
 * Tolerant: any DB error is logged and returns null so the caller never fails
 * sync over a missing salesperson link.
 */
export async function resolveSalespersonForHcpEntity(
  tenantId: string,
  hcpEntityInput: unknown,
): Promise<string | null> {
  const hcpEntity = hcpEntityInput as { assigned_employees?: Array<{ id?: string }>; employee_id?: string; assigned_employee_id?: string } | null | undefined;
  if (!hcpEntity) return null;
  // Spec: salesperson attribution comes from `assigned_employees[0].id` first.
  // Only fall back to the legacy single-employee fields when the array is
  // missing/empty so that the v2 ordering wins whenever HCP supplies it.
  const candidateIds: string[] = [];
  if (Array.isArray(hcpEntity.assigned_employees)) {
    for (const ae of hcpEntity.assigned_employees) {
      if (ae && typeof ae.id === 'string') candidateIds.push(ae.id);
    }
  }
  if (candidateIds.length === 0 && hcpEntity.employee_id) candidateIds.push(hcpEntity.employee_id);
  if (candidateIds.length === 0 && hcpEntity.assigned_employee_id) candidateIds.push(hcpEntity.assigned_employee_id);
  if (candidateIds.length === 0) return null;
  const primary = candidateIds[0];
  if (!primary) return null;

  try {
    const rows = await db
      .select({ userContractorId: employees.userContractorId })
      .from(employees)
      .where(and(
        eq(employees.contractorId, tenantId),
        eq(employees.externalSource, 'housecall-pro'),
        eq(employees.externalId, primary),
      ))
      .limit(1);
    const userContractorId = rows[0]?.userContractorId;
    if (!userContractorId) return null;

    const ucRows = await db
      .select({ userId: userContractors.userId })
      .from(userContractors)
      .where(eq(userContractors.id, userContractorId))
      .limit(1);
    return ucRows[0]?.userId ?? null;
  } catch (err) {
    mapLog.warn(`[salesperson-resolver] failed to resolve user for HCP employee ${primary} (tenant ${tenantId})`, err);
    return null;
  }
}

/**
 * Looks up several HCP employee ids → CRM user ids in one round-trip. Used by
 * the backfill path when scanning every estimate/job for a tenant. Returns a
 * map keyed by the HCP employee id; entries with no link are omitted.
 */
export async function resolveSalespersonMapForHcpEmployees(
  tenantId: string,
  hcpEmployeeIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = Array.from(new Set(hcpEmployeeIds.filter(Boolean)));
  if (unique.length === 0) return out;
  try {
    const empRows = await db
      .select({ externalId: employees.externalId, userContractorId: employees.userContractorId })
      .from(employees)
      .where(and(
        eq(employees.contractorId, tenantId),
        eq(employees.externalSource, 'housecall-pro'),
        inArray(employees.externalId, unique),
      ));
    const ucIds = empRows.map(r => r.userContractorId).filter((v): v is string => !!v);
    if (ucIds.length === 0) return out;
    const ucRows = await db
      .select({ id: userContractors.id, userId: userContractors.userId })
      .from(userContractors)
      .where(inArray(userContractors.id, ucIds));
    const ucMap = new Map(ucRows.map(r => [r.id, r.userId] as const));
    for (const e of empRows) {
      if (!e.externalId || !e.userContractorId) continue;
      const userId = ucMap.get(e.userContractorId);
      if (userId) out.set(e.externalId, userId);
    }
  } catch (err) {
    mapLog.warn(`[salesperson-resolver] batch resolution failed for tenant ${tenantId}`, err);
  }
  return out;
}
