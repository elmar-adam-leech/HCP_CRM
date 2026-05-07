import { storage } from "../storage";
import { db } from "../db";
import type {
  Activity,
  InsertSalesProcessTaskInstance,
  Lead,
  SalesProcess,
  SalesProcessStep,
  SalesProcessTaskInstance,
} from "@shared/schema";
import { logger } from "../utils/logger";

/** Drizzle transaction handle, narrowed to what we need (insert/select/update). */
export type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const log = logger("SalesProcess");

// Lead statuses that stop cadence (won/lost/disqualified).
const TERMINAL_LEAD_STATUSES: ReadonlyArray<string> = ['converted', 'disqualified', 'lost'];
// Estimate statuses that stop cadence (rejected only — `approved` is a positive
// terminal but a tenant may want a "Estimate → Approved" cadence to follow up
// with thank-you / scheduling steps, so we don't block it here).
const TERMINAL_ESTIMATE_STATUSES: ReadonlyArray<string> = ['rejected'];

export function isTerminalLeadStatus(status: string | null | undefined): boolean {
  return !!status && TERMINAL_LEAD_STATUSES.includes(status);
}

export function isTerminalEstimateStatus(status: string | null | undefined): boolean {
  return !!status && TERMINAL_ESTIMATE_STATUSES.includes(status);
}

/**
 * Effective stop set for a cadence: implicit terminals (always-on for the
 * cadence's entity type) merged with the user-configured `stopStatuses`.
 * Used by every "should this cadence keep running for this entity?" check.
 */
export function getCadenceStopSet(cadence: Pick<SalesProcess, 'entityType' | 'stopStatuses'>): Set<string> {
  const implicit = cadence.entityType === 'estimate'
    ? TERMINAL_ESTIMATE_STATUSES
    : TERMINAL_LEAD_STATUSES;
  const configured = cadence.stopStatuses ?? [];
  return new Set([...implicit, ...configured]);
}

export function shouldStopCadenceForStatus(
  cadence: Pick<SalesProcess, 'entityType' | 'stopStatuses'>,
  status: string | null | undefined,
): boolean {
  if (!status) return false;
  return getCadenceStopSet(cadence).has(status);
}

/** Activity types that can satisfy a sales-process step. */
function activityTypeToStepActionType(activityType: string): 'call' | 'text' | 'email' | null {
  switch (activityType) {
    case 'call': return 'call';
    case 'sms': return 'text';
    case 'email': return 'email';
    default: return null;
  }
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;
function computeDueAt(anchorAt: Date, dayOffset: number): Date {
  if (dayOffset <= 0) return new Date(anchorAt);
  return new Date(anchorAt.getTime() + dayOffset * MS_PER_DAY);
}

interface EntityContext {
  entityType: 'lead' | 'estimate';
  entityId: string;
  contractorId: string;
  /** Anchor for dayOffset math. Lead: createdAt. Estimate: status-change timestamp (now). */
  anchorAt: Date;
  /** Whether the entity is in a terminal state — short-circuits materialization. */
  terminal: boolean;
}

function buildInstancesForEntity(
  process: SalesProcess,
  steps: SalesProcessStep[],
  ctx: EntityContext,
): InsertSalesProcessTaskInstance[] {
  if (!process.active || steps.length === 0) return [];
  if (ctx.terminal) return [];

  const out: InsertSalesProcessTaskInstance[] = [];
  for (const step of steps) {
    out.push({
      contractorId: ctx.contractorId,
      leadId: ctx.entityType === 'lead' ? ctx.entityId : null,
      estimateId: ctx.entityType === 'estimate' ? ctx.entityId : null,
      stepId: step.id,
      actionType: step.actionType,
      mode: step.mode,
      dueAt: computeDueAt(ctx.anchorAt, step.dayOffset),
      status: 'pending',
    });
  }
  return out;
}

/**
 * Materialize task instances for a single (cadence, entity) pair.
 * Idempotent: no-ops when instances already exist for this pair.
 */
export async function materializeForEntity(
  process: SalesProcess,
  steps: SalesProcessStep[],
  ctx: EntityContext,
  reason: 'lead_created' | 'lead_status_changed' | 'estimate_status_changed' | 'process_backfill',
  tx?: DbTx,
): Promise<number> {
  if (!process.active || steps.length === 0) return 0;
  const existing = await storage.countTaskInstancesForEntity(
    process.id, ctx.entityType, ctx.entityId, ctx.contractorId,
  );
  if (existing > 0) return 0;
  const rows = buildInstancesForEntity(process, steps, ctx);
  if (rows.length === 0) return 0;
  const inserted = await storage.bulkInsertTaskInstances(rows, tx);
  for (const inst of inserted) {
    log.info(`sales_process instance_created tenantId=${inst.contractorId} entity=${inst.leadId ? `lead:${inst.leadId}` : `estimate:${inst.estimateId}`} processId=${process.id} stepId=${inst.stepId} instanceId=${inst.id} actionType=${inst.actionType} mode=${inst.mode} dueAt=${inst.dueAt.toISOString()} reason=${reason}`);
  }
  return inserted.length;
}

/**
 * BACK-COMPAT shim used by createLead's transactional materialization. Routes
 * through the legacy `lead_created` cadence for the tenant.
 */
export async function materializeForLead(lead: Lead, tx?: DbTx): Promise<number> {
  const cadences = await storage.listCadences(lead.contractorId);
  const matching = cadences.filter(c => c.active && c.triggerType === 'lead_created');
  let total = 0;
  for (const cad of matching) {
    const steps = await storage.getSalesProcessSteps(cad.id);
    total += await materializeForEntity(cad, steps, {
      entityType: 'lead',
      entityId: lead.id,
      contractorId: lead.contractorId,
      anchorAt: lead.createdAt ?? new Date(),
      terminal: shouldStopCadenceForStatus(cad, lead.status),
    }, 'lead_created', tx);
  }
  return total;
}

/**
 * Route a lead create or status-change event to all matching active cadences.
 */
export async function enrollLead(
  leadId: string,
  contractorId: string,
  opts: { reason: 'created' | 'status_changed'; newStatus?: string | null; oldStatus?: string | null },
): Promise<number> {
  const lead = await storage.getLead(leadId, contractorId);
  if (!lead) return 0;
  if (isTerminalLeadStatus(lead.status)) return 0;

  const cadences = await storage.listCadences(contractorId);
  const matching = cadences.filter(c => {
    if (!c.active || c.entityType !== 'lead') return false;
    if (opts.reason === 'created') return c.triggerType === 'lead_created';
    if (opts.reason === 'status_changed') {
      return c.triggerType === 'lead_status_changed'
        && c.targetStatus != null
        && c.targetStatus === opts.newStatus;
    }
    return false;
  });
  let total = 0;
  for (const cad of matching) {
    const steps = await storage.getSalesProcessSteps(cad.id);
    // For a status-change enrollment we anchor dayOffset to "now" (the
    // moment of transition) rather than lead.createdAt — the cadence is a
    // reaction to the new status, not a re-run of the original timeline.
    const anchorAt = opts.reason === 'created'
      ? (lead.createdAt ?? new Date())
      : new Date();
    total += await materializeForEntity(cad, steps, {
      entityType: 'lead',
      entityId: lead.id,
      contractorId,
      anchorAt,
      terminal: shouldStopCadenceForStatus(cad, lead.status),
    }, opts.reason === 'created' ? 'lead_created' : 'lead_status_changed');
  }
  return total;
}

/**
 * Route an estimate status-change event to all matching active cadences.
 */
export async function enrollEstimate(
  estimateId: string,
  contractorId: string,
  opts: { reason: 'status_changed'; newStatus: string },
): Promise<number> {
  const estimate = await storage.getEstimate(estimateId, contractorId);
  if (!estimate) return 0;
  // Don't enroll into a terminal estimate — there's nothing left to follow
  // up on, and the cron's terminal short-circuit would skip the rows we'd
  // create anyway. Saves a write+skip cycle.
  if (isTerminalEstimateStatus(estimate.status)) return 0;

  const cadences = await storage.listCadences(contractorId);
  const matching = cadences.filter(c =>
    c.active
    && c.entityType === 'estimate'
    && c.triggerType === 'estimate_status_changed'
    && c.targetStatus === opts.newStatus
  );
  let total = 0;
  for (const cad of matching) {
    const steps = await storage.getSalesProcessSteps(cad.id);
    total += await materializeForEntity(cad, steps, {
      entityType: 'estimate',
      entityId: estimate.id,
      contractorId,
      anchorAt: new Date(),
      terminal: shouldStopCadenceForStatus(cad, estimate.status),
    }, 'estimate_status_changed');
  }
  return total;
}

/**
 * BACK-COMPAT: legacy backfill for the tenant's `lead_created` cadence.
 * Used by the legacy PUT /api/sales-process route.
 */
export async function backfillOpenLeads(contractorId: string): Promise<{ leadsTouched: number; tasksCreated: number }> {
  const { process, steps } = await storage.getSalesProcessWithSteps(contractorId);
  return runLeadCadenceBackfill(process, steps, contractorId);
}

async function runLeadCadenceBackfill(
  process: SalesProcess,
  steps: SalesProcessStep[],
  contractorId: string,
  status?: string,
): Promise<{ leadsTouched: number; tasksCreated: number }> {
  if (!process.active || steps.length === 0) return { leadsTouched: 0, tasksCreated: 0 };
  const stopSet = Array.from(getCadenceStopSet(process));
  const openLeads = await storage.getOpenLeadsForBackfill(contractorId, status, stopSet);
  let leadsTouched = 0;
  let tasksCreated = 0;
  for (const lead of openLeads) {
    // Belt-and-suspenders: storage query already filters the stop set out
    // in SQL, but in-memory recheck guards against direct/legacy callers.
    if (shouldStopCadenceForStatus(process, lead.status)) continue;
    const inserted = await materializeForEntity(process, steps, {
      entityType: 'lead',
      entityId: lead.id,
      contractorId,
      anchorAt: lead.createdAt ?? new Date(),
      terminal: false,
    }, 'process_backfill');
    if (inserted > 0) {
      leadsTouched += 1;
      tasksCreated += inserted;
    }
  }
  return { leadsTouched, tasksCreated };
}

async function runEstimateCadenceBackfill(
  process: SalesProcess,
  steps: SalesProcessStep[],
  contractorId: string,
  targetStatus: string,
): Promise<{ leadsTouched: number; tasksCreated: number }> {
  if (!process.active || steps.length === 0) return { leadsTouched: 0, tasksCreated: 0 };
  const stopSet = Array.from(getCadenceStopSet(process));
  const openEstimates = await storage.getOpenEstimatesForBackfill(contractorId, targetStatus, stopSet);
  let entitiesTouched = 0;
  let tasksCreated = 0;
  for (const est of openEstimates) {
    if (shouldStopCadenceForStatus(process, est.status)) continue;
    const inserted = await materializeForEntity(process, steps, {
      entityType: 'estimate',
      entityId: est.id,
      contractorId,
      anchorAt: new Date(),
      terminal: false,
    }, 'process_backfill');
    if (inserted > 0) {
      entitiesTouched += 1;
      tasksCreated += inserted;
    }
  }
  // We reuse the {leadsTouched, tasksCreated} shape for response stability;
  // the field name is historical (UI shows "entities").
  return { leadsTouched: entitiesTouched, tasksCreated };
}

/**
 * Cadence-aware backfill: routes to lead or estimate enrollment based on
 * the cadence's trigger.
 */
export async function backfillForCadence(
  cadenceId: string,
  contractorId: string,
): Promise<{ leadsTouched: number; tasksCreated: number }> {
  const data = await storage.getCadenceWithSteps(cadenceId, contractorId);
  if (!data) return { leadsTouched: 0, tasksCreated: 0 };
  const { process, steps } = data;
  if (process.triggerType === 'lead_created') {
    return runLeadCadenceBackfill(process, steps, contractorId);
  }
  if (process.triggerType === 'lead_status_changed' && process.targetStatus) {
    return runLeadCadenceBackfill(process, steps, contractorId, process.targetStatus);
  }
  if (process.triggerType === 'estimate_status_changed' && process.targetStatus) {
    return runEstimateCadenceBackfill(process, steps, contractorId, process.targetStatus);
  }
  return { leadsTouched: 0, tasksCreated: 0 };
}

// Lead transitioned to terminal status: skip pending cadence tasks.
export async function onLeadStatusChanged(
  leadId: string,
  contractorId: string,
  newStatus: string | null | undefined,
  oldStatus: string | null | undefined,
): Promise<void> {
  if (newStatus === oldStatus) return;
  if (isTerminalLeadStatus(newStatus)) {
    // Implicit terminal: stop ALL pending tasks for this lead across every
    // cadence — no need to walk per-cadence stop sets.
    await storage.skipPendingTasksForLead(leadId, contractorId, 'lead_status_changed');
    return;
  }
  // Non-terminal change: per-cadence early stop. Walk every active lead
  // cadence and skip pending instances for any whose configured
  // `stopStatuses` includes the new status. Then route to enrollment.
  const cadences = await storage.listCadences(contractorId);
  for (const cad of cadences) {
    if (!cad.active || cad.entityType !== 'lead') continue;
    if (shouldStopCadenceForStatus(cad, newStatus)) {
      await storage.skipPendingTasksForLead(leadId, contractorId, 'lead_status_changed', cad.id);
    }
  }
  await enrollLead(leadId, contractorId, {
    reason: 'status_changed',
    newStatus: newStatus ?? null,
    oldStatus: oldStatus ?? null,
  });
}

export async function onEstimateStatusChanged(
  estimateId: string,
  contractorId: string,
  newStatus: string | null | undefined,
  oldStatus: string | null | undefined,
): Promise<void> {
  if (!newStatus || newStatus === oldStatus) return;
  if (isTerminalEstimateStatus(newStatus)) {
    // Implicit terminal: stop ALL pending tasks for this estimate.
    await storage.skipPendingTasksForEstimate(estimateId, contractorId, 'lead_status_changed');
    return;
  }
  // Per-cadence early stop, mirroring onLeadStatusChanged.
  const cadences = await storage.listCadences(contractorId);
  for (const cad of cadences) {
    if (!cad.active || cad.entityType !== 'estimate') continue;
    if (shouldStopCadenceForStatus(cad, newStatus)) {
      await storage.skipPendingTasksForEstimate(estimateId, contractorId, 'lead_status_changed', cad.id);
    }
  }
  await enrollEstimate(estimateId, contractorId, { reason: 'status_changed', newStatus });
}

// Activities satisfying a step must occur within ±2 days of the dueAt.
const ACTIVITY_MATCH_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;

export async function onActivityCreated(activity: Activity): Promise<SalesProcessTaskInstance | undefined> {
  if (!activity.contactId) return undefined;
  const stepActionType = activityTypeToStepActionType(activity.type);
  if (!stepActionType) return undefined;

  // Skip activities the auto-send path wrote, to avoid loopback.
  const meta = activity.metadata as { source?: string } | null | undefined;
  if (meta && meta.source === 'sales_process') return undefined;

  const activityAt = activity.createdAt ?? new Date();

  // Pull every candidate task across BOTH lead- and estimate-cadences for
  // this contact, then pick the closest in time. Doing it in a single pool
  // avoids the bug where a contact has a recently-converted lead AND an
  // open estimate-cadence task — the lead-only path would have completed a
  // stale lead task and ignored the estimate task entirely.
  const [leads, estimatesForContact] = await Promise.all([
    storage.getLeadsByContact(activity.contactId, activity.contractorId),
    storage.getEstimatesByContact(activity.contactId, activity.contractorId),
  ]);

  const candidates: SalesProcessTaskInstance[] = [];

  // Lead-scoped: most-recently-created non-terminal lead only (preserves
  // the original "don't cross-contaminate stale leads" guarantee).
  const targetLead = leads
    .filter(l => !isTerminalLeadStatus(l.status))
    .sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0))[0];
  if (targetLead) {
    const pendingForLead = await storage.listTaskInstances(activity.contractorId, {
      leadId: targetLead.id,
      status: 'pending',
    });
    candidates.push(...pendingForLead);
  }

  // Estimate-scoped: every non-terminal estimate for this contact. Multiple
  // open estimates are uncommon but legitimate (re-quote scenarios), so we
  // include them all and let the time-window match disambiguate.
  for (const est of estimatesForContact) {
    if (isTerminalEstimateStatus(est.status)) continue;
    const pendingForEstimate = await storage.listTaskInstances(activity.contractorId, {
      estimateId: est.id,
      status: 'pending',
    });
    candidates.push(...pendingForEstimate);
  }

  if (candidates.length === 0) return undefined;

  const matches = candidates
    .filter(t => t.actionType === stepActionType
      && Math.abs(t.dueAt.getTime() - activityAt.getTime()) <= ACTIVITY_MATCH_WINDOW_MS)
    // Prefer the closest-in-time match, then fall back to earliest dueAt.
    .sort((a, b) => {
      const da = Math.abs(a.dueAt.getTime() - activityAt.getTime());
      const db = Math.abs(b.dueAt.getTime() - activityAt.getTime());
      return da - db || a.dueAt.getTime() - b.dueAt.getTime();
    });
  if (matches.length === 0) return undefined;
  return await storage.markTaskCompleted(
    matches[0].id,
    activity.contractorId,
    'activity_logged',
    activity.userId ?? null,
  );
}
