import {
  contacts,
  leads,
  salesProcesses,
  salesProcessSteps,
  salesProcessTaskInstances,
  type Lead,
  type SalesProcess,
  type SalesProcessStep,
  type SalesProcessTaskInstance,
  type InsertSalesProcessTaskInstance,
} from "@shared/schema";
import { db } from "../db";
import { and, asc, eq, gte, inArray, isNull, lte, notInArray, sql } from "drizzle-orm";

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

async function getOrCreateSalesProcess(contractorId: string): Promise<SalesProcess> {
  const existing = await db.select().from(salesProcesses)
    .where(eq(salesProcesses.contractorId, contractorId))
    .limit(1);
  if (existing[0]) return existing[0];
  const created = await db.insert(salesProcesses).values({ contractorId }).returning();
  return created[0];
}

async function getSalesProcessSteps(salesProcessId: string): Promise<SalesProcessStep[]> {
  // Soft-deleted (archived) steps are filtered out everywhere — they only
  // remain in the DB to satisfy the FK from historical task instances.
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

async function getSalesProcessWithSteps(contractorId: string): Promise<SalesProcessWithSteps> {
  const process = await getOrCreateSalesProcess(contractorId);
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
  /** Steps removed during this PUT — caller should mark their pending tasks skipped. */
  removedStepIds: string[];
  /** Steps that were added or whose dayOffset/actionType/mode meaningfully changed; caller may re-materialize for open leads. */
  changedStepIds: string[];
  wasActivated: boolean;
  /**
   * Number of LIVE (non-archived) steps the process had before this upsert.
   * Lets the route layer detect the "first non-empty step list on an
   * already-active process" backfill trigger.
   */
  previousStepCount: number;
}

async function upsertSalesProcess(
  contractorId: string,
  input: { name?: string; active: boolean; steps: UpsertStepInput[] },
): Promise<UpsertProcessResult> {
  return db.transaction(async (tx) => {
    const existingRow = await tx.select().from(salesProcesses)
      .where(eq(salesProcesses.contractorId, contractorId))
      .limit(1);
    const existing = existingRow[0];

    let process: SalesProcess;
    if (existing) {
      const updated = await tx.update(salesProcesses)
        .set({
          name: input.name ?? existing.name,
          active: input.active,
          updatedAt: new Date(),
        })
        .where(eq(salesProcesses.id, existing.id))
        .returning();
      process = updated[0];
    } else {
      const created = await tx.insert(salesProcesses).values({
        contractorId,
        name: input.name ?? "Default sales process",
        active: input.active,
      }).returning();
      process = created[0];
    }

    const wasActivated = (!existing || !existing.active) && input.active;

    // Only consider non-archived (live) steps as candidates for matching.
    // Archived steps are deliberately ignored so the same (day, action) can
    // be re-added; they remain in the DB only to satisfy historical FK refs.
    const existingSteps = await tx.select().from(salesProcessSteps)
      .where(and(
        eq(salesProcessSteps.salesProcessId, process.id),
        isNull(salesProcessSteps.archivedAt),
      ));

    // Match existing steps to incoming steps by (dayOffset, actionType) — that
    // is the natural identity of a step. Anything left over is removed.
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
        const updated = await tx.update(salesProcessSteps).set({
          mode: s.mode,
          messageTemplate: s.messageTemplate ?? null,
          displayOrder: s.displayOrder,
          updatedAt: new Date(),
        }).where(eq(salesProcessSteps.id, ex.id)).returning();
        finalSteps.push(updated[0]);
        if (modeChanged || tplChanged) changedStepIds.push(ex.id);
        // When a step's mode flips (e.g. auto→manual after the manager
        // realizes auto-sends are misfiring), propagate to all PENDING
        // instances. Otherwise the cron's claim filter (mode='auto') would
        // continue dispatching outbound messages from the old config.
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

    // Removed steps: skip their pending instances and SOFT-DELETE the step
    // row (set archived_at). We don't hard-delete because historical task
    // instances FK-restrict-reference the row; the partial unique index on
    // (process, day, action) WHERE archived_at IS NULL keeps the
    // (day, action) slot free so the manager can re-add the same step.
    if (removedStepIds.length > 0) {
      const skipped = await tx.update(salesProcessTaskInstances).set({
        status: 'skipped',
        completionReason: 'step_deleted',
        completedAt: new Date(),
      }).where(and(
        inArray(salesProcessTaskInstances.stepId, removedStepIds),
        eq(salesProcessTaskInstances.status, 'pending'),
      )).returning();
      // Per-instance structured log for the bulk step-deletion skip path
      // (observability spec: every lifecycle transition gets a single line).
      for (const inst of skipped) {
        console.log(`[SalesProcess] sales_process instance_skipped tenantId=${inst.contractorId} leadId=${inst.leadId} stepId=${inst.stepId} instanceId=${inst.id} reason=step_deleted completedBy=system`);
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
      // Number of LIVE (non-archived) steps the process had BEFORE this
      // upsert. Lets the route layer detect the "first non-empty step list
      // on an already-active process" backfill trigger.
      previousStepCount: existingSteps.length,
    };
  });
}

async function listTaskInstances(
  contractorId: string,
  options: {
    from?: Date;
    to?: Date;
    leadId?: string;
    status?: 'pending' | 'completed' | 'skipped' | 'failed';
  } = {},
): Promise<SalesProcessTaskInstance[]> {
  const conds = [eq(salesProcessTaskInstances.contractorId, contractorId)];
  if (options.leadId) conds.push(eq(salesProcessTaskInstances.leadId, options.leadId));
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
    statuses?: Array<'pending' | 'completed' | 'skipped' | 'failed'>;
  } = {},
): Promise<TaskInstanceWithLead[]> {
  const conds = [eq(salesProcessTaskInstances.contractorId, contractorId)];
  if (options.leadId) conds.push(eq(salesProcessTaskInstances.leadId, options.leadId));
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

async function countCompletedTasksSince(
  contractorId: string,
  since: Date,
): Promise<number> {
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

/**
 * Move a failed task back to pending so the cron will retry it on the next
 * tick. Resets attemptCount and clears failureReason. Only operates on
 * `failed` rows — no-op if the task has been completed/skipped/etc.
 */
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
    console.log(`[SalesProcess] sales_process instance_retry_requested tenantId=${r[0].contractorId} leadId=${r[0].leadId} stepId=${r[0].stepId} instanceId=${r[0].id}`);
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

/**
 * Insert task instance rows. Accepts an optional `executor` (a Drizzle
 * transaction handle) so the caller can stitch this insert into a larger
 * transaction — used by createLead so lead-insert + task-materialization
 * commit/rollback together.
 */
async function bulkInsertTaskInstances(
  rows: InsertSalesProcessTaskInstance[],
  executor: typeof db = db,
): Promise<SalesProcessTaskInstance[]> {
  if (rows.length === 0) return [];
  return executor.insert(salesProcessTaskInstances).values(rows).returning();
}

/**
 * Open leads = not in a terminal status and not archived. Used by the
 * backfill pass when a manager activates the cadence so existing in-flight
 * leads pick it up.
 */
async function getOpenLeadsForBackfill(contractorId: string): Promise<Lead[]> {
  return db.select().from(leads).where(and(
    eq(leads.contractorId, contractorId),
    eq(leads.archived, false),
    notInArray(leads.status, ['converted', 'disqualified']),
  ));
}

/**
 * Cheap COUNT(*) used by the activation route to decide whether to run
 * backfill synchronously (small tenants) or detach into the background
 * (large tenants). Avoids materializing the full Lead[] just to size it.
 */
async function countOpenLeadsForBackfill(contractorId: string): Promise<number> {
  const r = await db.select({ c: sql<number>`count(*)::int` })
    .from(leads)
    .where(and(
      eq(leads.contractorId, contractorId),
      eq(leads.archived, false),
      notInArray(leads.status, ['converted', 'disqualified']),
    ));
  return r[0]?.c ?? 0;
}

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
  // Atomic flip: only succeeds when status is still pending.
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
    // Single-line structured log per task #506 observability requirement.
    console.log(`[SalesProcess] sales_process instance_completed tenantId=${r[0].contractorId} leadId=${r[0].leadId} stepId=${r[0].stepId} instanceId=${r[0].id} reason=${reason} completedBy=${completedBy ?? 'system'}`);
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
    console.log(`[SalesProcess] sales_process instance_skipped tenantId=${r[0].contractorId} leadId=${r[0].leadId} stepId=${r[0].stepId} instanceId=${r[0].id} reason=${reason} completedBy=${completedBy ?? 'system'}`);
  }
  return r[0];
}

async function markTaskFailed(
  id: string,
  contractorId: string,
  failureReason: string,
): Promise<SalesProcessTaskInstance | undefined> {
  // Guard `status='pending'` so a concurrent manual complete/skip racing
  // with the cron's failure path can't be overwritten — terminal states
  // are immutable. Without this guard, a rep clicking "Complete" at the
  // exact moment the cron's send permanently fails could see their
  // completed task silently flipped to 'failed'.
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
    console.log(`[SalesProcess] sales_process instance_failed tenantId=${r[0].contractorId} leadId=${r[0].leadId} stepId=${r[0].stepId} instanceId=${r[0].id} reason=${failureReason} attempts=${r[0].attemptCount}`);
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

/**
 * Push a soft-failed task's dueAt forward by `delayMs` so the cron's next
 * tick won't immediately reclaim it. Implements exponential backoff between
 * retries (caller computes the delay).
 */
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
  // Use returning(*) so we can emit one structured log per skipped
  // instance — required by the observability spec for bulk skip paths
  // (lead status change → terminal, step deletion).
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

/**
 * Atomically claim up to `limit` due auto-mode pending instances for the
 * cron worker. Flips them to a transient state so a parallel tick cannot
 * pick up the same row. We keep them as `pending` but bump attemptCount in
 * a single UPDATE ... RETURNING — the cron then sends and finalizes.
 */
/**
 * Atomically claim due auto tasks. When `contractorId` is provided the
 * claim is strictly tenant-scoped (used by the manager-triggered
 * /run-now endpoint to avoid dispatching another tenant's tasks). When
 * omitted, the unattended cron picks up due rows across all tenants.
 */
async function claimDueAutoTasks(
  now: Date,
  limit: number,
  contractorId?: string,
): Promise<SalesProcessTaskInstance[]> {
  // Postgres-specific: use a CTE to lock rows and bump attemptCount in one
  // statement. No `FOR UPDATE SKIP LOCKED` ergonomics in drizzle yet, so we
  // emit raw SQL.
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
  listTaskInstances,
  listTaskInstancesWithLeadSummary,
  countCompletedTasksSince,
  retryFailedTask,
  getTaskInstance,
  bulkInsertTaskInstances,
  getOpenLeadsForBackfill,
  countOpenLeadsForBackfill,
  countTaskInstancesForLead,
  markTaskCompleted,
  markTaskSkipped,
  markTaskFailed,
  rescheduleTaskForRetry,
  incrementAttemptCount,
  skipPendingTasksForLead,
  claimDueAutoTasks,
};
