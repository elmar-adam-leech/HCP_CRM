import {
  type Workflow, type InsertWorkflow,
  type WorkflowStep, type InsertWorkflowStep,
  type WorkflowExecution, type InsertWorkflowExecution,
  type Contact, type Estimate, type Job,
  workflows, workflowSteps, workflowExecutions, contacts, estimates, jobs, userContractors,
  workflowApprovalStatusEnum,
} from "@shared/schema";
import { db } from "../db";
import { eq, and, desc, asc, lt, lte, inArray, sql } from "drizzle-orm";
import type { UpdateWorkflow, UpdateWorkflowStep, UpdateWorkflowExecution } from "../storage-types";

export interface EstimateWithContact extends Estimate {
  contact: Contact | undefined;
}

export interface JobWithContact extends Job {
  contact: Contact | undefined;
}

async function getWorkflows(contractorId: string, approvalStatus?: string): Promise<Workflow[]> {
  const conditions = [eq(workflows.contractorId, contractorId)];
  if (approvalStatus && approvalStatus !== 'all') {
    conditions.push(eq(workflows.approvalStatus, approvalStatus as typeof workflowApprovalStatusEnum.enumValues[number]));
  }
  return await db.select().from(workflows).where(and(...conditions)).orderBy(desc(workflows.createdAt)).limit(500);
}

async function getActiveWorkflows(contractorId: string): Promise<Workflow[]> {
  return await db.select().from(workflows).where(and(
    eq(workflows.contractorId, contractorId),
    eq(workflows.isActive, true)
  )).orderBy(desc(workflows.createdAt)).limit(500);
}

async function getActiveApprovedWorkflows(contractorId: string): Promise<Workflow[]> {
  return await db.select().from(workflows).where(and(
    eq(workflows.contractorId, contractorId),
    eq(workflows.isActive, true),
    eq(workflows.approvalStatus, 'approved')
  )).orderBy(desc(workflows.createdAt)).limit(500);
}

async function getWorkflowsPendingApproval(contractorId: string): Promise<Workflow[]> {
  return await db.select().from(workflows).where(and(
    eq(workflows.contractorId, contractorId),
    eq(workflows.approvalStatus, 'pending_approval')
  )).orderBy(desc(workflows.createdAt)).limit(500);
}

async function getWorkflow(id: string, contractorId: string): Promise<Workflow | undefined> {
  const result = await db.select().from(workflows).where(and(
    eq(workflows.id, id),
    eq(workflows.contractorId, contractorId)
  )).limit(1);
  return result[0];
}

async function createWorkflow(workflow: Omit<InsertWorkflow, 'contractorId'>, contractorId: string, userId: string): Promise<Workflow> {
  const userContractor = await db.select().from(userContractors).where(and(
    eq(userContractors.userId, userId),
    eq(userContractors.contractorId, contractorId)
  )).limit(1);

  const uc = userContractor[0];
  const isAdminOrManager = uc && (uc.role === 'admin' || uc.role === 'manager' || uc.role === 'super_admin');

  const result = await db.insert(workflows).values({
    ...workflow,
    contractorId,
    createdBy: userId,
    approvalStatus: isAdminOrManager ? 'approved' : 'pending_approval',
    approvedBy: isAdminOrManager ? userId : null,
    approvedAt: isAdminOrManager ? new Date() : null,
  }).returning();
  return result[0];
}

async function updateWorkflow(id: string, workflow: UpdateWorkflow, contractorId: string): Promise<Workflow | undefined> {
  const result = await db.update(workflows)
    .set({ ...workflow, updatedAt: new Date() })
    .where(and(eq(workflows.id, id), eq(workflows.contractorId, contractorId)))
    .returning();
  return result[0];
}

async function deleteWorkflow(id: string, contractorId: string): Promise<boolean> {
  const result = await db.delete(workflows).where(and(
    eq(workflows.id, id),
    eq(workflows.contractorId, contractorId)
  )).returning();
  return result.length > 0;
}

async function approveWorkflow(id: string, contractorId: string, approvedByUserId: string): Promise<Workflow | undefined> {
  const result = await db.update(workflows).set({
    approvalStatus: 'approved',
    approvedBy: approvedByUserId,
    approvedAt: new Date(),
    rejectionReason: null,
    updatedAt: new Date()
  }).where(and(eq(workflows.id, id), eq(workflows.contractorId, contractorId))).returning();
  return result[0];
}

async function rejectWorkflow(id: string, contractorId: string, rejectedByUserId: string, rejectionReason?: string): Promise<Workflow | undefined> {
  const result = await db.update(workflows).set({
    approvalStatus: 'rejected',
    approvedBy: rejectedByUserId,
    approvedAt: new Date(),
    rejectionReason: rejectionReason || null,
    updatedAt: new Date()
  }).where(and(eq(workflows.id, id), eq(workflows.contractorId, contractorId))).returning();
  return result[0];
}

async function getWorkflowSteps(workflowId: string): Promise<WorkflowStep[]> {
  return await db.select().from(workflowSteps).where(eq(workflowSteps.workflowId, workflowId)).orderBy(asc(workflowSteps.stepOrder)).limit(200);
}

async function getWorkflowStep(id: string): Promise<WorkflowStep | undefined> {
  const result = await db.select().from(workflowSteps).where(eq(workflowSteps.id, id)).limit(1);
  return result[0];
}

async function createWorkflowStep(step: InsertWorkflowStep): Promise<WorkflowStep> {
  const result = await db.insert(workflowSteps).values(step).returning();
  return result[0];
}

async function updateWorkflowStep(id: string, step: UpdateWorkflowStep): Promise<WorkflowStep | undefined> {
  const result = await db.update(workflowSteps).set({ ...step, updatedAt: new Date() }).where(eq(workflowSteps.id, id)).returning();
  return result[0];
}

async function deleteWorkflowStep(id: string): Promise<boolean> {
  const result = await db.delete(workflowSteps).where(eq(workflowSteps.id, id)).returning();
  return result.length > 0;
}

async function deleteWorkflowSteps(workflowId: string): Promise<boolean> {
  const result = await db.delete(workflowSteps).where(eq(workflowSteps.workflowId, workflowId)).returning();
  return result.length > 0;
}

async function bulkCreateWorkflowSteps(steps: InsertWorkflowStep[]): Promise<WorkflowStep[]> {
  if (steps.length === 0) return [];
  return await db.insert(workflowSteps).values(steps).returning();
}

async function replaceWorkflowSteps(workflowId: string, steps: InsertWorkflowStep[]): Promise<WorkflowStep[]> {
  return await db.transaction(async (tx) => {
    await tx.delete(workflowSteps).where(eq(workflowSteps.workflowId, workflowId));
    if (steps.length === 0) return [];
    return await tx.insert(workflowSteps).values(steps).returning();
  });
}

async function getWorkflowExecutions(workflowId: string, contractorId: string, limit: number = 50, status?: string | string[]): Promise<WorkflowExecution[]> {
  const conditions = [
    eq(workflowExecutions.workflowId, workflowId),
    eq(workflowExecutions.contractorId, contractorId),
  ];
  if (status) {
    const statuses = Array.isArray(status) ? status : [status];
    conditions.push(inArray(workflowExecutions.status, statuses as typeof workflowExecutions.status._.data[]));
  }
  return await db.select().from(workflowExecutions).where(and(...conditions)).orderBy(desc(workflowExecutions.createdAt)).limit(limit);
}

async function cancelWorkflowExecution(id: string, contractorId: string): Promise<WorkflowExecution | undefined> {
  const result = await db.update(workflowExecutions)
    .set({ status: 'cancelled', resumeAt: null, completedAt: new Date() })
    .where(and(
      eq(workflowExecutions.id, id),
      eq(workflowExecutions.contractorId, contractorId),
      inArray(workflowExecutions.status, ['running', 'suspended', 'pending'])
    ))
    .returning();
  return result[0];
}

async function getWorkflowExecution(id: string, contractorId: string): Promise<WorkflowExecution | undefined> {
  const result = await db.select().from(workflowExecutions).where(and(
    eq(workflowExecutions.id, id),
    eq(workflowExecutions.contractorId, contractorId)
  )).limit(1);
  return result[0];
}

async function getRecentWorkflowExecutions(contractorId: string, limit: number = 50): Promise<WorkflowExecution[]> {
  return await db.select().from(workflowExecutions).where(eq(workflowExecutions.contractorId, contractorId)).orderBy(desc(workflowExecutions.createdAt)).limit(limit);
}

/**
 * Return all executions that are still "running" but were started before the
 * given cutoff timestamp. These are zombie executions left behind when the
 * server restarted while a delay/wait action was in progress.
 *
 * @param olderThan - Only include executions created before this Date
 */
async function getStaleRunningExecutions(olderThan: Date): Promise<WorkflowExecution[]> {
  return await db.select().from(workflowExecutions).where(and(
    eq(workflowExecutions.status, 'running'),
    lt(workflowExecutions.createdAt, olderThan)
  )).limit(500);
}

async function getSuspendedExecutions(): Promise<WorkflowExecution[]> {
  return await db.select().from(workflowExecutions).where(and(
    eq(workflowExecutions.status, 'suspended'),
    lte(workflowExecutions.resumeAt, new Date())
  )).limit(100);
}

/**
 * Atomically claim a suspended execution by transitioning its status from
 * 'suspended' → 'running' in a single UPDATE … WHERE status = 'suspended'.
 *
 * This is the double-execution guard for the suspended-execution poller:
 * because the UPDATE is atomic at the DB level, at most ONE poller cycle can
 * ever claim a given execution — even when multiple server processes or rapid
 * back-to-back poll cycles see the same row in their SELECT results. Any
 * caller that loses the race receives `undefined` and must skip that execution.
 *
 * @returns The updated execution row if the claim succeeded, or undefined if
 *          another caller already claimed (or completed) the execution.
 */
async function claimSuspendedExecution(id: string, contractorId: string): Promise<WorkflowExecution | undefined> {
  const result = await db
    .update(workflowExecutions)
    .set({ status: 'running' })
    .where(and(
      eq(workflowExecutions.id, id),
      eq(workflowExecutions.contractorId, contractorId),
      eq(workflowExecutions.status, 'suspended')
    ))
    .returning();
  return result[0];
}

async function createWorkflowExecution(execution: Omit<InsertWorkflowExecution, 'contractorId'>, contractorId: string): Promise<WorkflowExecution> {
  const result = await db.insert(workflowExecutions).values({ ...execution, contractorId }).returning();
  return result[0];
}

async function updateWorkflowExecution(id: string, execution: UpdateWorkflowExecution, contractorId: string): Promise<WorkflowExecution | undefined> {
  const result = await db.update(workflowExecutions).set(execution).where(and(
    eq(workflowExecutions.id, id),
    eq(workflowExecutions.contractorId, contractorId)
  )).returning();
  return result[0];
}

async function getEstimateWithContact(id: string, contractorId: string): Promise<EstimateWithContact | undefined> {
  const result = await db.select().from(estimates).leftJoin(contacts, eq(estimates.contactId, contacts.id)).where(and(eq(estimates.id, id), eq(estimates.contractorId, contractorId))).limit(1);
  if (!result[0]) return undefined;
  const { estimates: estimate, contacts: contact } = result[0];
  return { ...estimate, contact: contact || undefined };
}

async function getJobWithContact(id: string, contractorId: string): Promise<JobWithContact | undefined> {
  const result = await db.select().from(jobs).leftJoin(contacts, eq(jobs.contactId, contacts.id)).where(and(eq(jobs.id, id), eq(jobs.contractorId, contractorId))).limit(1);
  if (!result[0]) return undefined;
  const { jobs: job, contacts: contact } = result[0];
  return { ...job, contact: contact || undefined };
}

export type ContactWorkflowEnrollment = {
  executionId: string;
  workflowId: string;
  workflowName: string;
  status: string;
  currentStep: number | null;
  startedAt: Date | null;
};

async function getActiveExecutionsForContact(contactId: string, contractorId: string): Promise<ContactWorkflowEnrollment[]> {
  const rows = await db
    .select({
      executionId: workflowExecutions.id,
      workflowId: workflowExecutions.workflowId,
      workflowName: workflows.name,
      status: workflowExecutions.status,
      currentStep: workflowExecutions.currentStep,
      startedAt: workflowExecutions.startedAt,
    })
    .from(workflowExecutions)
    .innerJoin(workflows, eq(workflowExecutions.workflowId, workflows.id))
    .where(and(
      eq(workflowExecutions.contractorId, contractorId),
      inArray(workflowExecutions.status, ['pending', 'running', 'suspended']),
      sql`(${workflowExecutions.triggerData}::jsonb ->> 'id' = ${contactId} OR ${workflowExecutions.triggerData}::jsonb ->> 'contactId' = ${contactId})`
    ))
    .orderBy(desc(workflowExecutions.createdAt))
    .limit(50);
  return rows;
}

type BulkContactWorkflowEnrollment = ContactWorkflowEnrollment & { contactId: string };

async function getActiveExecutionsForContacts(contactIds: string[], contractorId: string): Promise<Record<string, ContactWorkflowEnrollment[]>> {
  if (contactIds.length === 0) return {};

  const rows = await db
    .select({
      executionId: workflowExecutions.id,
      workflowId: workflowExecutions.workflowId,
      workflowName: workflows.name,
      status: workflowExecutions.status,
      currentStep: workflowExecutions.currentStep,
      startedAt: workflowExecutions.startedAt,
      contactId: sql<string>`COALESCE(${workflowExecutions.triggerData}::jsonb ->> 'contactId', ${workflowExecutions.triggerData}::jsonb ->> 'id')`.as('contactId'),
    })
    .from(workflowExecutions)
    .innerJoin(workflows, eq(workflowExecutions.workflowId, workflows.id))
    .where(and(
      eq(workflowExecutions.contractorId, contractorId),
      inArray(workflowExecutions.status, ['pending', 'running', 'suspended']),
      sql`(${workflowExecutions.triggerData}::jsonb ->> 'id' = ANY(${contactIds}) OR ${workflowExecutions.triggerData}::jsonb ->> 'contactId' = ANY(${contactIds}))`
    ))
    .orderBy(desc(workflowExecutions.createdAt));

  const result: Record<string, ContactWorkflowEnrollment[]> = {};
  for (const row of rows as BulkContactWorkflowEnrollment[]) {
    const cid = row.contactId;
    if (!cid) continue;
    if (!result[cid]) result[cid] = [];
    result[cid].push({
      executionId: row.executionId,
      workflowId: row.workflowId,
      workflowName: row.workflowName,
      status: row.status,
      currentStep: row.currentStep,
      startedAt: row.startedAt,
    });
  }
  return result;
}

export const workflowMethods = {
  getWorkflows,
  getActiveWorkflows,
  getActiveApprovedWorkflows,
  getWorkflowsPendingApproval,
  getWorkflow,
  createWorkflow,
  updateWorkflow,
  deleteWorkflow,
  approveWorkflow,
  rejectWorkflow,
  getWorkflowSteps,
  getWorkflowStep,
  createWorkflowStep,
  bulkCreateWorkflowSteps,
  replaceWorkflowSteps,
  updateWorkflowStep,
  deleteWorkflowStep,
  deleteWorkflowSteps,
  getWorkflowExecutions,
  cancelWorkflowExecution,
  getWorkflowExecution,
  getRecentWorkflowExecutions,
  getStaleRunningExecutions,
  getSuspendedExecutions,
  claimSuspendedExecution,
  createWorkflowExecution,
  updateWorkflowExecution,
  getActiveExecutionsForContact,
  getActiveExecutionsForContacts,
  getEstimateWithContact,
  getJobWithContact,
};
