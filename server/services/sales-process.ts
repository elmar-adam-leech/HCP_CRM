import { storage } from "../storage";
import { db } from "../db";
import type {
  Activity,
  InsertSalesProcessTaskInstance,
  Lead,
  SalesProcess,
  SalesProcessStep,
} from "@shared/schema";
import { logger } from "../utils/logger";

/** Drizzle transaction handle, narrowed to what we need (insert/select/update). */
export type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const log = logger("SalesProcess");

// Lead statuses that stop cadence (won/lost/disqualified).
const TERMINAL_LEAD_STATUSES: ReadonlyArray<string> = ['converted', 'disqualified', 'lost'];

export function isTerminalLeadStatus(status: string | null | undefined): boolean {
  return !!status && TERMINAL_LEAD_STATUSES.includes(status);
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

// dueAt = lead.createdAt + dayOffset days (preserves time-of-day).
const MS_PER_DAY = 24 * 60 * 60 * 1000;
function computeDueAt(leadCreatedAt: Date, dayOffset: number): Date {
  if (dayOffset <= 0) return new Date(leadCreatedAt);
  return new Date(leadCreatedAt.getTime() + dayOffset * MS_PER_DAY);
}

function buildInstancesForLead(
  process: SalesProcess,
  steps: SalesProcessStep[],
  lead: Lead,
): InsertSalesProcessTaskInstance[] {
  if (!process.active || steps.length === 0) return [];
  if (isTerminalLeadStatus(lead.status)) return [];

  const out: InsertSalesProcessTaskInstance[] = [];
  const leadCreatedAt = lead.createdAt ?? new Date();

  for (const step of steps) {
    out.push({
      contractorId: lead.contractorId,
      leadId: lead.id,
      stepId: step.id,
      actionType: step.actionType,
      mode: step.mode,
      dueAt: computeDueAt(leadCreatedAt, step.dayOffset),
      status: 'pending',
    });
  }
  return out;
}

// Materialize task instances for a single newly-created lead.
export async function materializeForLead(lead: Lead, tx?: DbTx): Promise<number> {
  const { process, steps } = await storage.getSalesProcessWithSteps(lead.contractorId);
  if (!process.active) return 0;
  const existing = await storage.countTaskInstancesForLead(lead.id, lead.contractorId);
  if (existing > 0) return 0;
  const rows = buildInstancesForLead(process, steps, lead);
  if (rows.length === 0) return 0;
  const inserted = await storage.bulkInsertTaskInstances(rows, tx);
  for (const inst of inserted) {
    log.info(`sales_process instance_created tenantId=${inst.contractorId} leadId=${inst.leadId} stepId=${inst.stepId} instanceId=${inst.id} actionType=${inst.actionType} mode=${inst.mode} dueAt=${inst.dueAt.toISOString()} reason=lead_created`);
  }
  return inserted.length;
}

// Backfill open leads when the process is first activated.
export async function backfillOpenLeads(contractorId: string): Promise<{ leadsTouched: number; tasksCreated: number }> {
  const { process, steps } = await storage.getSalesProcessWithSteps(contractorId);
  if (!process.active || steps.length === 0) {
    return { leadsTouched: 0, tasksCreated: 0 };
  }
  const openLeads = await storage.getOpenLeadsForBackfill(contractorId);
  let leadsTouched = 0;
  let tasksCreated = 0;
  for (const lead of openLeads) {
    const existing = await storage.countTaskInstancesForLead(lead.id, contractorId);
    if (existing > 0) continue;
    const rows = buildInstancesForLead(process, steps, lead);
    if (rows.length === 0) continue;
    const inserted = await storage.bulkInsertTaskInstances(rows);
    if (inserted.length > 0) {
      leadsTouched += 1;
      tasksCreated += inserted.length;
      for (const inst of inserted) {
        log.info(`sales_process instance_created tenantId=${inst.contractorId} leadId=${inst.leadId} stepId=${inst.stepId} instanceId=${inst.id} actionType=${inst.actionType} mode=${inst.mode} dueAt=${inst.dueAt.toISOString()} reason=process_backfill`);
      }
    }
  }
  return { leadsTouched, tasksCreated };
}

// Lead transitioned to terminal status: skip pending cadence tasks.
export async function onLeadStatusChanged(
  leadId: string,
  contractorId: string,
  newStatus: string | null | undefined,
  oldStatus: string | null | undefined,
): Promise<void> {
  if (newStatus === oldStatus) return;
  if (!isTerminalLeadStatus(newStatus)) return;
  await storage.skipPendingTasksForLead(leadId, contractorId, 'lead_status_changed');
}

// Activities satisfying a step must occur within ±2 days of the dueAt.
const ACTIVITY_MATCH_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;

export async function onActivityCreated(activity: Activity): Promise<void> {
  if (!activity.contactId) return;
  const stepActionType = activityTypeToStepActionType(activity.type);
  if (!stepActionType) return;

  // Skip activities the auto-send path wrote, to avoid loopback.
  const meta = activity.metadata as { source?: string } | null | undefined;
  if (meta && meta.source === 'sales_process') return;

  const activityAt = activity.createdAt ?? new Date();
  const leads = await storage.getLeadsByContact(activity.contactId, activity.contractorId);
  if (leads.length === 0) return;
  // Activity rows carry contactId only; for multi-lead contacts we
  // resolve to the most recently created non-terminal lead.
  const targetLead = leads
    .filter(l => !isTerminalLeadStatus(l.status))
    .sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0))[0];
  if (!targetLead) return;

  const pending = await storage.listTaskInstances(activity.contractorId, {
    leadId: targetLead.id,
    status: 'pending',
  });
  const matches = pending
    .filter(t => t.actionType === stepActionType
      && Math.abs(t.dueAt.getTime() - activityAt.getTime()) <= ACTIVITY_MATCH_WINDOW_MS)
    .sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime());
  if (matches.length === 0) return;
  await storage.markTaskCompleted(
    matches[0].id,
    activity.contractorId,
    'activity_logged',
    activity.userId ?? null,
  );
}
