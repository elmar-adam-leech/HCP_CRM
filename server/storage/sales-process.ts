import {
  contacts,
  leads,
  estimates,
  salesProcesses,
  salesProcessSteps,
  salesProcessTaskInstances,
  type Lead,
  type Estimate,
  type SalesProcess,
  type SalesProcessStep,
  type SalesProcessTaskInstance,
  type InsertSalesProcessTaskInstance,
} from "@shared/schema";
import { leadStatusEnum, estimateStatusEnum } from "@shared/schema/enums";
import { db } from "../db";
import { and, asc, eq, gte, inArray, isNull, isNotNull, lte, notInArray, sql } from "drizzle-orm";

export interface TaskInstanceWithLead extends SalesProcessTaskInstance {
  lead: {
    id: string;
    contactId: string;
    status: string;
    source: string | null;
    createdAt: Date | null;
    name: string;
    email: string | null;
    phone: string | null;
  };
}

export interface TaskInstanceWithEstimate extends SalesProcessTaskInstance {
  estimate: {
    id: string;
    contactId: string;
    status: string;
    title: string | null;
    estimateNumber: string | null;
    name: string;
    email: string | null;
    phone: string | null;
  };
}

type LeadStatus = (typeof leadStatusEnum.enumValues)[number];
type EstimateStatus = (typeof estimateStatusEnum.enumValues)[number];
const DEFAULT_LEAD_TERMINAL_STATUSES: LeadStatus[] = ['converted', 'disqualified', 'lost'];

/**
 * Returns the canonical "lead_created" cadence for the tenant, creating it
 * if missing. Back-compat shim for the legacy single-cadence API and UI
 * paths that haven't been updated yet (Follow-ups page, lead detail).
 */
async function getOrCreateSalesProcess(contractorId: string): Promise<SalesProcess> {
  const existing = await db.select().from(salesProcesses)
    .where(and(
      eq(salesProcesses.contractorId, contractorId),
      eq(salesProcesses.triggerType, 'lead_created'),
      isNull(salesProcesses.archivedAt),
    ))
    .limit(1);
  if (existing[0]) return existing[0];
  const created = await db.insert(salesProcesses).values({
    contractorId,
    triggerType: 'lead_created',
    entityType: 'lead',
    targetStatus: null,
    name: 'New leads',
  }).returning();
  return created[0];
}

async function listCadences(contractorId: string): Promise<SalesProcess[]> {
  return db.select().from(salesProcesses)
    .where(and(
      eq(salesProcesses.contractorId, contractorId),
      isNull(salesProcesses.archivedAt),
    ))
    .orderBy(asc(salesProcesses.createdAt));
}

async function getCadenceById(id: string, contractorId: string): Promise<SalesProcess | undefined> {
  const r = await db.select().from(salesProcesses)
    .where(and(
      eq(salesProcesses.id, id),
      eq(salesProcesses.contractorId, contractorId),
      isNull(salesProcesses.archivedAt),
    ))
    .limit(1);
  return r[0];
}

async function createCadence(input: {
  contractorId: string;
  name: string;
  triggerType: string;
  targetStatus: string | null;
  entityType: string;
  active?: boolean;
}): Promise<SalesProcess> {
  const created = await db.insert(salesProcesses).values({
    contractorId: input.contractorId,
    name: input.name,
    triggerType: input.triggerType,
    targetStatus: input.targetStatus,
    entityType: input.entityType,
    active: input.active ?? false,
  }).returning();
  return created[0];
}

async function deleteCadence(id: string, contractorId: string): Promise<boolean> {
  // Soft-delete. Hard-deleting the cadence would cascade to steps, but
  // sales_process_task_instances.step_id is ON DELETE RESTRICT, so any
  // historical task would block the delete with an FK violation. Marking
  // the cadence archived (and forcing active=false so the cron stops
  // creating new instances) preserves history and lets the user re-create
  // a cadence with the same trigger/target_status pair (the unique index
  // is partial on archived_at IS NULL).
  const result = await db.update(salesProcesses)
    .set({ archivedAt: new Date(), active: false, updatedAt: new Date() })
    .where(and(
      eq(salesProcesses.id, id),
      eq(salesProcesses.contractorId, contractorId),
      isNull(salesProcesses.archivedAt),
    ))
    .returning();
  return result.length > 0;
}

async function getSalesProcessSteps(salesProcessId: string): Promise<SalesProcessStep[]> {
  return db.select().from(salesProcessSteps)
    .where(and(
      eq(salesProcessSteps.salesProcessId, salesProcessId),
      isNull(salesProcessSteps.archivedAt),
    ))
    .orderBy(asc(salesProcessSteps.displayOrder), asc(salesProcessSteps.dayOffset));
}

export interface SalesProcessWithSteps {
  process: SalesProcess;
  steps: SalesProcessStep[];
}

/**
 * BACK-COMPAT: returns the legacy "lead_created" cadence + steps for the
 * tenant. New multi-cadence callers should use `getCadenceWithSteps(id)`.
 */
async function getSalesProcessWithSteps(contractorId: string): Promise<SalesProcessWithSteps> {
  const process = await getOrCreateSalesProcess(contractorId);
  const steps = await getSalesProcessSteps(process.id);
  return { process, steps };
}

async function getCadenceWithSteps(id: string, contractorId: string): Promise<SalesProcessWithSteps | undefined> {
  const process = await getCadenceById(id, contractorId);
  if (!process) return undefined;
  const steps = await getSalesProcessSteps(process.id);
  return { process, steps };
}

interface UpsertStepInput {
  dayOffset: number;
  actionType: 'call' | 'text' | 'email';
  mode: 'manual' | 'auto';
  messageTemplate?: string | null;
  displayOrder: number;
}

interface UpsertProcessResult {
  process: SalesProcess;
  steps: SalesProcessStep[];
  removedStepIds: string[];
  changedStepIds: string[];
  wasActivated: boolean;
  previousStepCount: number;
}

/**
 * Replace a cadence's steps + name/active flag. Operates on a specific
 * cadence id — multi-cadence aware.
 */
async function upsertCadence(
  cadenceId: string,
  contractorId: string,
  input: { name?: string; active: boolean; steps: UpsertStepInput[] },
): Promise<UpsertProcessResult | undefined> {
  return db.transaction(async (tx) => {
    const existingRow = await tx.select().from(salesProcesses)
      .where(and(eq(salesProcesses.id, cadenceId), eq(salesProcesses.contractorId, contractorId)))
      .limit(1);
    const existing = existingRow[0];
    if (!existing) return undefined;

    const updated = await tx.update(salesProcesses)
      .set({
        name: input.name ?? existing.name,
        active: input.active,
        updatedAt: new Date(),
      })
      .where(eq(salesProcesses.id, existing.id))
      .returning();
    const process = updated[0];
    const wasActivated = !existing.active && input.active;

    const existingSteps = await tx.select().from(salesProcessSteps)
      .where(and(
        eq(salesProcessSteps.salesProcessId, process.id),
        isNull(salesProcessSteps.archivedAt),
      ));

    const incomingKeys = new Set(input.steps.map(s => `${s.dayOffset}|${s.actionType}`));
    const existingByKey = new Map(existingSteps.map(s => [`${s.dayOffset}|${s.actionType}`, s]));

    const removedStepIds: string[] = [];
    for (const ex of existingSteps) {
      const key = `${ex.dayOffset}|${ex.actionType}`;
      if (!incomingKeys.has(key)) removedStepIds.push(ex.id);
    }

    const changedStepIds: string[] = [];
    const finalSteps: SalesProcessStep[] = [];

    for (let i = 0; i < input.steps.length; i++) {
      const s = input.steps[i];
      const key = `${s.dayOffset}|${s.actionType}`;
      const ex = existingByKey.get(key);
      if (ex) {
        const modeChanged = ex.mode !== s.mode;
        const tplChanged = (ex.messageTemplate ?? null) !== (s.messageTemplate ?? null);
        const updatedRow = await tx.update(salesProcessSteps).set({
          mode: s.mode,
          messageTemplate: s.messageTemplate ?? null,
          displayOrder: s.displayOrder,
          updatedAt: new Date(),
        }).where(eq(salesProcessSteps.id, ex.id)).returning();
        finalSteps.push(updatedRow[0]);
        if (modeChanged || tplChanged) changedStepIds.push(ex.id);
        if (modeChanged) {
          await tx.update(salesProcessTaskInstances).set({ mode: s.mode })
            .where(and(
              eq(salesProcessTaskInstances.stepId, ex.id),
              eq(salesProcessTaskInstances.status, 'pending'),
            ));
        }
      } else {
        const created = await tx.insert(salesProcessSteps).values({
          salesProcessId: process.id,
          dayOffset: s.dayOffset,
          actionType: s.actionType,
          mode: s.mode,
          messageTemplate: s.messageTemplate ?? null,
          displayOrder: s.displayOrder,
        }).returning();
        finalSteps.push(created[0]);
        changedStepIds.push(created[0].id);
      }
    }

    if (removedStepIds.length > 0) {
      const skipped = await tx.update(salesProcessTaskInstances).set({
        status: 'skipped',
        completionReason: 'step_deleted',
        completedAt: new Date(),
      }).where(and(
        inArray(salesProcessTaskInstances.stepId, removedStepIds),
        eq(salesProcessTaskInstances.status, 'pending'),
      )).returning();
      for (const inst of skipped) {
        console.log(`[SalesProcess] sales_process instance_skipped tenantId=${inst.contractorId} entity=${inst.leadId ? `lead:${inst.leadId}` : `estimate:${inst.estimateId}`} stepId=${inst.stepId} instanceId=${inst.id} reason=step_deleted completedBy=system`);
      }
      await tx.update(salesProcessSteps).set({
        archivedAt: new Date(),
        updatedAt: new Date(),
      }).where(inArray(salesProcessSteps.id, removedStepIds));
    }

    return {
      process,
      steps: finalSteps,
      removedStepIds,
      changedStepIds,
      wasActivated,
      previousStepCount: existingSteps.length,
    };
  });
}

/**
 * BACK-COMPAT shim: replaces steps for the tenant's `lead_created` cadence.
 * Used by the legacy PUT /api/sales-process route.
 */
async function upsertSalesProcess(
  contractorId: string,
  input: { name?: string; active: boolean; steps: UpsertStepInput[] },
): Promise<UpsertProcessResult> {
  const process = await getOrCreateSalesProcess(contractorId);
  const result = await upsertCadence(process.id, contractorId, input);
  if (!result) throw new Error('Failed to upsert default sales process');
  return result;
}

async function listTaskInstances(
  contractorId: string,
  options: {
    from?: Date;
    to?: Date;
    leadId?: string;
    estimateId?: string;
    status?: 'pending' | 'completed' | 'skipped' | 'failed';
  } = {},
): Promise<SalesProcessTaskInstance[]> {
  const conds = [eq(salesProcessTaskInstances.contractorId, contractorId)];
  if (options.leadId) conds.push(eq(salesProcessTaskInstances.leadId, options.leadId));
  if (options.estimateId) conds.push(eq(salesProcessTaskInstances.estimateId, options.estimateId));
  if (options.status) conds.push(eq(salesProcessTaskInstances.status, options.status));
  if (options.from) conds.push(gte(salesProcessTaskInstances.dueAt, options.from));
  if (options.to) conds.push(lte(salesProcessTaskInstances.dueAt, options.to));
  return db.select().from(salesProcessTaskInstances)
    .where(and(...conds))
    .orderBy(asc(salesProcessTaskInstances.dueAt));
}

async function listTaskInstancesWithLeadSummary(
  contractorId: string,
  options: {
    from?: Date;
    to?: Date;
    leadId?: string;
    contactId?: string;
    statuses?: Array<'pending' | 'completed' | 'skipped' | 'failed'>;
  } = {},
): Promise<TaskInstanceWithLead[]> {
  // This back-compat join is lead-only by construction (innerJoin on
  // leads). Estimate-based tasks are filtered out — the legacy Follow-ups
  // page consumes this and only renders lead rows. New surfaces should
  // use listTaskInstances and join in the entity themselves.
  const conds = [
    eq(salesProcessTaskInstances.contractorId, contractorId),
    isNotNull(salesProcessTaskInstances.leadId),
  ];
  if (options.leadId) conds.push(eq(salesProcessTaskInstances.leadId, options.leadId));
  if (options.contactId) conds.push(eq(leads.contactId, options.contactId));
  if (options.statuses && options.statuses.length > 0) {
    conds.push(inArray(salesProcessTaskInstances.status, options.statuses));
  }
  if (options.from) conds.push(gte(salesProcessTaskInstances.dueAt, options.from));
  if (options.to) conds.push(lte(salesProcessTaskInstances.dueAt, options.to));
  const rows = await db
    .select({
      task: salesProcessTaskInstances,
      lead: leads,
      contact: contacts,
    })
    .from(salesProcessTaskInstances)
    .innerJoin(leads, eq(leads.id, salesProcessTaskInstances.leadId))
    .leftJoin(contacts, eq(contacts.id, leads.contactId))
    .where(and(...conds))
    .orderBy(asc(salesProcessTaskInstances.dueAt));
  return rows.map((r) => ({
    ...r.task,
    lead: {
      id: r.lead.id,
      contactId: r.lead.contactId,
      status: r.lead.status,
      source: r.lead.source ?? null,
      createdAt: r.lead.createdAt ?? null,
      name: r.contact?.name ?? '',
      email: r.contact?.emails?.[0] ?? null,
      phone: r.contact?.phones?.[0] ?? null,
    },
  }));
}

async function listEstimateTaskInstancesWithSummary(
  contractorId: string,
  options: {
    from?: Date;
    to?: Date;
    estimateId?: string;
    contactId?: string;
    statuses?: Array<'pending' | 'completed' | 'skipped' | 'failed'>;
  } = {},
): Promise<TaskInstanceWithEstimate[]> {
  // Symmetrical to listTaskInstancesWithLeadSummary, but joining estimates +
  // contacts so the Follow-ups view can render estimate-anchored manual
  // tasks (e.g. "follow up after Approved estimate") with the same
  // affordances — manual completion, recipient context, due-date grouping.
  const conds = [
    eq(salesProcessTaskInstances.contractorId, contractorId),
    isNotNull(salesProcessTaskInstances.estimateId),
  ];
  if (options.estimateId) conds.push(eq(salesProcessTaskInstances.estimateId, options.estimateId));
  if (options.contactId) conds.push(eq(estimates.contactId, options.contactId));
  if (options.statuses && options.statuses.length > 0) {
    conds.push(inArray(salesProcessTaskInstances.status, options.statuses));
  }
  if (options.from) conds.push(gte(salesProcessTaskInstances.dueAt, options.from));
  if (options.to) conds.push(lte(salesProcessTaskInstances.dueAt, options.to));
  const rows = await db
    .select({
      task: salesProcessTaskInstances,
      estimate: estimates,
      contact: contacts,
    })
    .from(salesProcessTaskInstances)
    .innerJoin(estimates, eq(estimates.id, salesProcessTaskInstances.estimateId))
    .leftJoin(contacts, eq(contacts.id, estimates.contactId))
    .where(and(...conds))
    .orderBy(asc(salesProcessTaskInstances.dueAt));
  return rows.map((r) => ({
    ...r.task,
    estimate: {
      id: r.estimate.id,
      contactId: r.estimate.contactId,
      status: r.estimate.status,
      title: r.estimate.title ?? null,
      estimateNumber: (r.estimate as { estimateNumber?: string | null }).estimateNumber ?? null,
      name: r.contact?.name ?? '',
      email: r.contact?.emails?.[0] ?? null,
      phone: r.contact?.phones?.[0] ?? null,
    },
  }));
}

async function countCompletedTasksSince(contractorId: string, since: Date): Promise<number> {
  const r = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(salesProcessTaskInstances)
    .where(and(
      eq(salesProcessTaskInstances.contractorId, contractorId),
      eq(salesProcessTaskInstances.status, 'completed'),
      gte(salesProcessTaskInstances.completedAt, since),
    ));
  return r[0]?.c ?? 0;
}

async function retryFailedTask(
  id: string,
  contractorId: string,
): Promise<SalesProcessTaskInstance | undefined> {
  const r = await db.update(salesProcessTaskInstances).set({
    status: 'pending',
    failureReason: null,
    attemptCount: 0,
    completedAt: null,
    completionReason: null,
    dueAt: new Date(),
  }).where(and(
    eq(salesProcessTaskInstances.id, id),
    eq(salesProcessTaskInstances.contractorId, contractorId),
    eq(salesProcessTaskInstances.status, 'failed'),
  )).returning();
  if (r[0]) {
    console.log(`[SalesProcess] sales_process instance_retry_requested tenantId=${r[0].contractorId} entity=${r[0].leadId ? `lead:${r[0].leadId}` : `estimate:${r[0].estimateId}`} stepId=${r[0].stepId} instanceId=${r[0].id}`);
  }
  return r[0];
}

async function getTaskInstance(id: string, contractorId: string): Promise<SalesProcessTaskInstance | undefined> {
  const r = await db.select().from(salesProcessTaskInstances)
    .where(and(
      eq(salesProcessTaskInstances.id, id),
      eq(salesProcessTaskInstances.contractorId, contractorId),
    ))
    .limit(1);
  return r[0];
}

async function bulkInsertTaskInstances(
  rows: InsertSalesProcessTaskInstance[],
  executor: DbExecutor = db,
): Promise<SalesProcessTaskInstance[]> {
  if (rows.length === 0) return [];
  return executor.insert(salesProcessTaskInstances).values(rows).returning();
}

type DbExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

async function getOpenLeadsForBackfill(contractorId: string, status?: string): Promise<Lead[]> {
  const conds = [
    eq(leads.contractorId, contractorId),
    eq(leads.archived, false),
    notInArray(leads.status, DEFAULT_LEAD_TERMINAL_STATUSES),
  ];
  if (status) {
    if (!(leadStatusEnum.enumValues as readonly string[]).includes(status)) {
      return [];
    }
    conds.push(eq(leads.status, status as LeadStatus));
  }
  return db.select().from(leads).where(and(...conds));
}

// Mirrors TERMINAL_ESTIMATE_STATUSES in the service layer. We exclude these
// even when the cadence's targetStatus matches one (e.g. an over-eager
// "estimate rejected" cadence) — terminal estimates by definition have no
// further engagement to schedule against, and including them would be both
// wasteful (insert + immediate skip via the cron's terminal short-circuit)
// and noisy on the activation toast.
const ESTIMATE_TERMINAL_STATUSES: readonly EstimateStatus[] = ['rejected'];

async function getEstimatesByContact(contactId: string, contractorId: string): Promise<Estimate[]> {
  return db.select().from(estimates).where(and(
    eq(estimates.contactId, contactId),
    eq(estimates.contractorId, contractorId),
  ));
}

async function getOpenEstimatesForBackfill(contractorId: string, status: string): Promise<Estimate[]> {
  if (!(estimateStatusEnum.enumValues as readonly string[]).includes(status)) return [];
  const typed = status as EstimateStatus;
  // Defensive: if the cadence's target status is itself terminal, never
  // backfill (the service layer also short-circuits, but this keeps the
  // query honest for direct callers).
  if (ESTIMATE_TERMINAL_STATUSES.includes(typed)) return [];
  return db.select().from(estimates).where(and(
    eq(estimates.contractorId, contractorId),
    eq(estimates.status, typed),
  ));
}

async function countOpenEstimatesForBackfill(contractorId: string, status: string): Promise<number> {
  if (!(estimateStatusEnum.enumValues as readonly string[]).includes(status)) return 0;
  const typed = status as EstimateStatus;
  if (ESTIMATE_TERMINAL_STATUSES.includes(typed)) return 0;
  const r = await db.select({ c: sql<number>`count(*)::int` })
    .from(estimates)
    .where(and(
      eq(estimates.contractorId, contractorId),
      eq(estimates.status, typed),
    ));
  return r[0]?.c ?? 0;
}

async function countOpenLeadsForBackfill(contractorId: string): Promise<number> {
  const r = await db.select({ c: sql<number>`count(*)::int` })
    .from(leads)
    .where(and(
      eq(leads.contractorId, contractorId),
      eq(leads.archived, false),
      notInArray(leads.status, DEFAULT_LEAD_TERMINAL_STATUSES),
    ));
  return r[0]?.c ?? 0;
}

/**
 * Count task instances already created for a given (cadence, entity)
 * pair. Used to suppress duplicate enrollment per spec (one cadence enrolls
 * a given entity at most once unless explicitly reset).
 */
async function countTaskInstancesForEntity(
  processId: string,
  entityType: 'lead' | 'estimate',
  entityId: string,
  contractorId: string,
): Promise<number> {
  const entityCond = entityType === 'lead'
    ? eq(salesProcessTaskInstances.leadId, entityId)
    : eq(salesProcessTaskInstances.estimateId, entityId);
  // Match on stepId IN (steps of this cadence) — task instances don't carry
  // processId directly so we join through steps.
  const stepRows = await db.select({ id: salesProcessSteps.id })
    .from(salesProcessSteps)
    .where(eq(salesProcessSteps.salesProcessId, processId));
  if (stepRows.length === 0) return 0;
  const stepIds = stepRows.map(s => s.id);
  const r = await db.select({ c: sql<number>`count(*)::int` })
    .from(salesProcessTaskInstances)
    .where(and(
      entityCond,
      eq(salesProcessTaskInstances.contractorId, contractorId),
      inArray(salesProcessTaskInstances.stepId, stepIds),
    ));
  return r[0]?.c ?? 0;
}

/**
 * BACK-COMPAT: total task count for a lead across ALL cadences. Used by
 * the legacy createLead path and the test suite.
 */
async function countTaskInstancesForLead(leadId: string, contractorId: string): Promise<number> {
  const r = await db.select({ c: sql<number>`count(*)::int` })
    .from(salesProcessTaskInstances)
    .where(and(
      eq(salesProcessTaskInstances.leadId, leadId),
      eq(salesProcessTaskInstances.contractorId, contractorId),
    ));
  return r[0]?.c ?? 0;
}

async function markTaskCompleted(
  id: string,
  contractorId: string,
  reason: 'manual' | 'activity_logged' | 'auto_sent',
  completedBy?: string | null,
): Promise<SalesProcessTaskInstance | undefined> {
  const r = await db.update(salesProcessTaskInstances).set({
    status: 'completed',
    completionReason: reason,
    completedAt: new Date(),
    completedBy: completedBy ?? null,
  }).where(and(
    eq(salesProcessTaskInstances.id, id),
    eq(salesProcessTaskInstances.contractorId, contractorId),
    eq(salesProcessTaskInstances.status, 'pending'),
  )).returning();
  if (r[0]) {
    console.log(`[SalesProcess] sales_process instance_completed tenantId=${r[0].contractorId} entity=${r[0].leadId ? `lead:${r[0].leadId}` : `estimate:${r[0].estimateId}`} stepId=${r[0].stepId} instanceId=${r[0].id} reason=${reason} completedBy=${completedBy ?? 'system'}`);
  }
  return r[0];
}

async function markTaskSkipped(
  id: string,
  contractorId: string,
  reason: 'manual' | 'lead_status_changed' | 'step_deleted',
  completedBy?: string | null,
): Promise<SalesProcessTaskInstance | undefined> {
  const r = await db.update(salesProcessTaskInstances).set({
    status: 'skipped',
    completionReason: reason,
    completedAt: new Date(),
    completedBy: completedBy ?? null,
  }).where(and(
    eq(salesProcessTaskInstances.id, id),
    eq(salesProcessTaskInstances.contractorId, contractorId),
    eq(salesProcessTaskInstances.status, 'pending'),
  )).returning();
  if (r[0]) {
    console.log(`[SalesProcess] sales_process instance_skipped tenantId=${r[0].contractorId} entity=${r[0].leadId ? `lead:${r[0].leadId}` : `estimate:${r[0].estimateId}`} stepId=${r[0].stepId} instanceId=${r[0].id} reason=${reason} completedBy=${completedBy ?? 'system'}`);
  }
  return r[0];
}

async function markTaskFailed(
  id: string,
  contractorId: string,
  failureReason: string,
): Promise<SalesProcessTaskInstance | undefined> {
  const r = await db.update(salesProcessTaskInstances).set({
    status: 'failed',
    failureReason,
    completedAt: new Date(),
  }).where(and(
    eq(salesProcessTaskInstances.id, id),
    eq(salesProcessTaskInstances.contractorId, contractorId),
    eq(salesProcessTaskInstances.status, 'pending'),
  )).returning();
  if (r[0]) {
    console.log(`[SalesProcess] sales_process instance_failed tenantId=${r[0].contractorId} entity=${r[0].leadId ? `lead:${r[0].leadId}` : `estimate:${r[0].estimateId}`} stepId=${r[0].stepId} instanceId=${r[0].id} reason=${failureReason} attempts=${r[0].attemptCount}`);
  }
  return r[0];
}

async function incrementAttemptCount(id: string, contractorId: string): Promise<void> {
  await db.update(salesProcessTaskInstances).set({
    attemptCount: sql`${salesProcessTaskInstances.attemptCount} + 1`,
  }).where(and(
    eq(salesProcessTaskInstances.id, id),
    eq(salesProcessTaskInstances.contractorId, contractorId),
  ));
}

async function rescheduleTaskForRetry(
  id: string,
  contractorId: string,
  nextDueAt: Date,
): Promise<void> {
  await db.update(salesProcessTaskInstances).set({
    dueAt: nextDueAt,
  }).where(and(
    eq(salesProcessTaskInstances.id, id),
    eq(salesProcessTaskInstances.contractorId, contractorId),
    eq(salesProcessTaskInstances.status, 'pending'),
  ));
}

async function skipPendingTasksForLead(
  leadId: string,
  contractorId: string,
  reason: 'lead_status_changed' | 'step_deleted',
): Promise<number> {
  const r = await db.update(salesProcessTaskInstances).set({
    status: 'skipped',
    completionReason: reason,
    completedAt: new Date(),
  }).where(and(
    eq(salesProcessTaskInstances.leadId, leadId),
    eq(salesProcessTaskInstances.contractorId, contractorId),
    eq(salesProcessTaskInstances.status, 'pending'),
  )).returning();
  for (const inst of r) {
    console.log(`[SalesProcess] sales_process instance_skipped tenantId=${inst.contractorId} leadId=${inst.leadId} stepId=${inst.stepId} instanceId=${inst.id} reason=${reason} completedBy=system`);
  }
  return r.length;
}

async function claimDueAutoTasks(
  now: Date,
  limit: number,
  contractorId?: string,
): Promise<SalesProcessTaskInstance[]> {
  const tenantFilter = contractorId
    ? sql`AND contractor_id = ${contractorId}`
    : sql``;
  const rows = await db.execute<SalesProcessTaskInstance>(sql`
    WITH claimed AS (
      SELECT id FROM sales_process_task_instances
      WHERE status = 'pending'
        AND mode = 'auto'
        AND due_at <= ${now}
        ${tenantFilter}
      ORDER BY due_at ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE sales_process_task_instances t
    SET attempt_count = t.attempt_count + 1
    FROM claimed
    WHERE t.id = claimed.id
    RETURNING t.*;
  `);
  return rows.rows as unknown as SalesProcessTaskInstance[];
}

export const salesProcessMethods = {
  getOrCreateSalesProcess,
  getSalesProcessSteps,
  getSalesProcessWithSteps,
  upsertSalesProcess,
  listCadences,
  getCadenceById,
  createCadence,
  deleteCadence,
  getCadenceWithSteps,
  upsertCadence,
  listTaskInstances,
  listTaskInstancesWithLeadSummary,
  listEstimateTaskInstancesWithSummary,
  countCompletedTasksSince,
  retryFailedTask,
  getTaskInstance,
  bulkInsertTaskInstances,
  getOpenLeadsForBackfill,
  getOpenEstimatesForBackfill,
  getEstimatesByContact,
  countOpenLeadsForBackfill,
  countOpenEstimatesForBackfill,
  countTaskInstancesForLead,
  countTaskInstancesForEntity,
  markTaskCompleted,
  markTaskSkipped,
  markTaskFailed,
  rescheduleTaskForRetry,
  incrementAttemptCount,
  skipPendingTasksForLead,
  claimDueAutoTasks,
};
