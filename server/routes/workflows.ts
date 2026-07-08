import type { Express, Response } from "express";
import { storage } from "../storage";
import { insertWorkflowSchema, insertWorkflowStepSchema, workflowActionTypeEnum, auditLogs, contacts } from "@shared/schema";
import { requireManagerOrAdmin, type AuthedRequest } from "../auth-service";
import { workflowEngine } from "../workflow-engine";
import { asyncHandler } from "../utils/async-handler";
import { broadcastToContractor } from "../websocket";
import { auditLog } from "../utils/audit-log";
import { db } from "../db";
import { and, desc, eq, inArray } from "drizzle-orm";

import { parseBody } from "../utils/validate-body";
import { logger } from '../utils/logger';
import { enrichTestTriggerData } from "../utils/workflow/test-trigger-enrichment";
import { invalidateWorkflowStepsCache } from "../services/cache";

const log = logger('WorkflowRoutes');

const ALLOWED_ACTION_TYPES = new Set([
  'trigger',
  ...workflowActionTypeEnum.enumValues,
]);

export function registerWorkflowRoutes(app: Express): void {
  app.get("/api/workflows", asyncHandler(async (req: AuthedRequest, res: Response) => {
    const approvalStatus = req.query.approvalStatus as string | undefined;
    const workflows = await storage.getWorkflows(req.user.contractorId, approvalStatus);
    res.json(workflows);
  }));

  app.get("/api/workflows/active", asyncHandler(async (req: AuthedRequest, res: Response) => {
    const workflows = await storage.getActiveWorkflows(req.user.contractorId);
    res.json(workflows);
  }));

  app.get("/api/workflows/pending-approval", requireManagerOrAdmin, asyncHandler(async (req: AuthedRequest, res: Response) => {
    const workflows = await storage.getWorkflowsPendingApproval(req.user.contractorId);
    res.json(workflows);
  }));

  /**
   * Entity search powering the WorkflowTestDialog picker. The dialog needs to
   * let the user pick a real lead/contact/estimate/job by name to test against
   * — typing a UUID into a JSON textarea was the original UX bug. Returns a
   * minimal {id, name, subtitle} shape so the picker doesn't have to know the
   * full entity schema for each type.
   */
  app.get("/api/workflows/test-entities", asyncHandler(async (req: AuthedRequest, res: Response) => {
    const entityType = String(req.query.entityType ?? 'lead');
    const search = String(req.query.search ?? '').trim();
    const limit = Math.min(20, Math.max(1, parseInt(String(req.query.limit ?? '10'), 10) || 10));
    const contractorId = req.user.contractorId;

    if (entityType === 'lead' || entityType === 'contact' || entityType === 'customer') {
      const type = entityType === 'customer' ? 'customer' : entityType === 'contact' ? undefined : 'lead';
      const result = await storage.getContactsPaginated(contractorId, {
        limit,
        search: search || undefined,
        type: type as 'lead' | 'customer' | undefined,
      });
      res.json((result.data ?? []).map(c => ({
        id: c.id,
        name: c.name,
        subtitle: c.emails?.[0] || c.phones?.[0] || '',
      })));
      return;
    }
    if (entityType === 'estimate') {
      const result = await storage.getEstimatesPaginated(contractorId, { limit, search: search || undefined });
      res.json((result.data ?? []).map((e: { id: string; title?: string | null; status?: string | null }) => ({
        id: e.id,
        name: e.title || `Estimate ${e.id.slice(0, 8)}`,
        subtitle: e.status ?? '',
      })));
      return;
    }
    if (entityType === 'job') {
      const result = await storage.getJobsPaginated(contractorId, { limit, search: search || undefined });
      res.json((result.data ?? []).map((j: { id: string; title?: string | null; status?: string | null }) => ({
        id: j.id,
        name: j.title || `Job ${j.id.slice(0, 8)}`,
        subtitle: j.status ?? '',
      })));
      return;
    }
    res.json([]);
  }));

  app.get("/api/workflows/:id", asyncHandler(async (req: AuthedRequest, res: Response) => {
    const workflow = await storage.getWorkflow(req.params.id, req.user.contractorId);
    if (!workflow) {
      res.status(404).json({ error: 'Workflow not found' });
      return;
    }
    res.json(workflow);
  }));

  app.post("/api/workflows", requireManagerOrAdmin, asyncHandler(async (req: AuthedRequest, res: Response) => {
    const validation = parseBody(insertWorkflowSchema, req, res);
    if (!validation) return;

    const userContractor = await storage.getUserContractor(req.user.userId, req.user.contractorId);
    const isElevatedRole = userContractor && ['admin', 'manager', 'super_admin'].includes(userContractor.role);
    const workflowData = isElevatedRole
      ? { ...validation, approvalStatus: 'approved' as const }
      : validation;

    const workflow = await storage.createWorkflow(
      workflowData,
      req.user.contractorId,
      req.user.userId
    );
    broadcastToContractor(req.user.contractorId, { type: 'workflow_created', workflowId: workflow.id });
    auditLog({
      contractorId: req.user.contractorId,
      userId: req.user.userId,
      action: 'workflow.create',
      entityType: 'workflow',
      entityId: workflow.id,
      after: { name: workflow.name, approvalStatus: workflow.approvalStatus, isActive: workflow.isActive },
    }).catch(err => log.error('Failed to write audit log for workflow creation', err));
    res.status(201).json(workflow);
  }));

  app.patch("/api/workflows/:id", requireManagerOrAdmin, asyncHandler(async (req: AuthedRequest, res: Response) => {
    const validation = parseBody(insertWorkflowSchema.partial(), req, res);
    if (!validation) return;

    if (validation.isActive === true) {
      const existingWorkflow = await storage.getWorkflow(req.params.id, req.user.contractorId);
      if (!existingWorkflow) {
        res.status(404).json({ error: 'Workflow not found' });
        return;
      }

      if (existingWorkflow.approvalStatus !== 'approved') {
        res.status(403).json({
          error: 'Cannot activate workflow',
          message: existingWorkflow.approvalStatus === 'pending_approval'
            ? 'This workflow requires admin approval before it can be activated'
            : 'This workflow has been rejected and cannot be activated'
        });
        return;
      }
    }

    const workflow = await storage.updateWorkflow(
      req.params.id,
      validation,
      req.user.contractorId
    );
    if (!workflow) {
      res.status(404).json({ error: 'Workflow not found' });
      return;
    }
    broadcastToContractor(req.user.contractorId, { type: 'workflow_updated', workflowId: workflow.id });
    auditLog({
      contractorId: req.user.contractorId,
      userId: req.user.userId,
      action: 'workflow.update',
      entityType: 'workflow',
      entityId: workflow.id,
      after: validation as Record<string, unknown>,
    }).catch(err => log.error('Failed to write audit log for workflow update', err));
    res.json(workflow);
  }));

  app.delete("/api/workflows/:id", requireManagerOrAdmin, asyncHandler(async (req: AuthedRequest, res: Response) => {
    const deleted = await storage.deleteWorkflow(req.params.id, req.user.contractorId);
    if (!deleted) {
      res.status(404).json({ error: 'Workflow not found' });
      return;
    }
    invalidateWorkflowStepsCache(req.params.id);
    broadcastToContractor(req.user.contractorId, { type: 'workflow_deleted', workflowId: req.params.id });
    auditLog({
      contractorId: req.user.contractorId,
      userId: req.user.userId,
      action: 'workflow.delete',
      entityType: 'workflow',
      entityId: req.params.id,
    }).catch(err => log.error('Failed to write audit log for workflow deletion', err));
    res.json({ success: true });
  }));

  app.post("/api/workflows/:id/approve", requireManagerOrAdmin, asyncHandler(async (req: AuthedRequest, res: Response) => {
    const existingWorkflow = await storage.getWorkflow(req.params.id, req.user.contractorId);
    if (!existingWorkflow) {
      res.status(404).json({ error: 'Workflow not found' });
      return;
    }

    const workflow = await storage.approveWorkflow(req.params.id, req.user.contractorId, req.user.userId);
    if (!workflow) {
      res.status(404).json({ error: 'Workflow not found' });
      return;
    }

    broadcastToContractor(req.user.contractorId, { type: 'workflow_updated', workflowId: workflow.id });
    auditLog({
      contractorId: req.user.contractorId,
      userId: req.user.userId,
      action: 'workflow.approve',
      entityType: 'workflow',
      entityId: workflow.id,
      before: { approvalStatus: existingWorkflow.approvalStatus },
      after: { approvalStatus: 'approved' },
    }).catch(err => log.error('Failed to write audit log for workflow approval', err));
    res.json(workflow);
  }));

  app.post("/api/workflows/:id/reject", requireManagerOrAdmin, asyncHandler(async (req: AuthedRequest, res: Response) => {
    const existingWorkflow = await storage.getWorkflow(req.params.id, req.user.contractorId);
    if (!existingWorkflow) {
      res.status(404).json({ error: 'Workflow not found' });
      return;
    }

    const { rejectionReason } = req.body;
    const workflow = await storage.rejectWorkflow(req.params.id, req.user.contractorId, req.user.userId, rejectionReason);
    if (!workflow) {
      res.status(404).json({ error: 'Workflow not found' });
      return;
    }

    broadcastToContractor(req.user.contractorId, { type: 'workflow_updated', workflowId: workflow.id });
    auditLog({
      contractorId: req.user.contractorId,
      userId: req.user.userId,
      action: 'workflow.reject',
      entityType: 'workflow',
      entityId: workflow.id,
      before: { approvalStatus: existingWorkflow.approvalStatus },
      after: { approvalStatus: 'rejected', rejectionReason: rejectionReason ?? null },
    }).catch(err => log.error('Failed to write audit log for workflow rejection', err));
    res.json(workflow);
  }));

  app.get("/api/workflows/:workflowId/steps", asyncHandler(async (req: AuthedRequest, res: Response) => {
    const workflow = await storage.getWorkflow(req.params.workflowId, req.user.contractorId);
    if (!workflow) {
      res.status(404).json({ error: 'Workflow not found' });
      return;
    }

    const steps = await storage.getWorkflowSteps(req.params.workflowId);
    res.json(steps);
  }));

  app.post("/api/workflows/:workflowId/steps", requireManagerOrAdmin, asyncHandler(async (req: AuthedRequest, res: Response) => {
    const workflow = await storage.getWorkflow(req.params.workflowId, req.user.contractorId);
    if (!workflow) {
      res.status(404).json({ error: 'Workflow not found' });
      return;
    }

    const validation = insertWorkflowStepSchema.safeParse({ ...req.body, workflowId: req.params.workflowId });
    if (!validation.success) {
      res.status(400).json({ error: 'Invalid workflow step data', details: validation.error });
      return;
    }

    const step = await storage.createWorkflowStep(validation.data);
    invalidateWorkflowStepsCache(req.params.workflowId);
    broadcastToContractor(req.user.contractorId, { type: 'workflow_updated', workflowId: req.params.workflowId });
    res.status(201).json(step);
  }));

  app.put("/api/workflows/:workflowId/steps", requireManagerOrAdmin, asyncHandler(async (req: AuthedRequest, res: Response) => {
    const workflow = await storage.getWorkflow(req.params.workflowId, req.user.contractorId);
    if (!workflow) {
      res.status(404).json({ error: 'Workflow not found' });
      return;
    }

    const { steps } = req.body;
    if (!Array.isArray(steps)) {
      res.status(400).json({ error: 'steps must be an array' });
      return;
    }

    const validatedSteps: Array<ReturnType<typeof insertWorkflowStepSchema.parse>> = [];
    for (const stepData of steps) {
      const validation = insertWorkflowStepSchema.safeParse({ ...stepData, workflowId: req.params.workflowId });
      if (!validation.success) {
        res.status(400).json({ error: 'Invalid workflow step data', details: validation.error });
        return;
      }
      if (!ALLOWED_ACTION_TYPES.has(validation.data.actionType)) {
        res.status(400).json({ error: `Invalid actionType: "${validation.data.actionType}"` });
        return;
      }
      validatedSteps.push(validation.data);
    }

    const createdSteps = await storage.replaceWorkflowSteps(req.params.workflowId, validatedSteps);
    invalidateWorkflowStepsCache(req.params.workflowId);

    broadcastToContractor(req.user.contractorId, { type: 'workflow_updated', workflowId: req.params.workflowId });
    res.json(createdSteps);
  }));

  app.patch("/api/workflow-steps/:id", requireManagerOrAdmin, asyncHandler(async (req: AuthedRequest, res: Response) => {
    const existingStep = await storage.getWorkflowStep(req.params.id);
    if (!existingStep) {
      res.status(404).json({ error: 'Workflow step not found' });
      return;
    }

    const workflow = await storage.getWorkflow(existingStep.workflowId, req.user.contractorId);
    if (!workflow) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    const validation = parseBody(insertWorkflowStepSchema.omit({ workflowId: true }).partial(), req, res);
    if (!validation) return;

    const step = await storage.updateWorkflowStep(req.params.id, validation);
    if (!step) {
      res.status(404).json({ error: 'Workflow step not found' });
      return;
    }
    invalidateWorkflowStepsCache(existingStep.workflowId);
    broadcastToContractor(req.user.contractorId, { type: 'workflow_updated', workflowId: existingStep.workflowId });
    res.json(step);
  }));

  app.delete("/api/workflow-steps/:id", requireManagerOrAdmin, asyncHandler(async (req: AuthedRequest, res: Response) => {
    const existingStep = await storage.getWorkflowStep(req.params.id);
    if (!existingStep) {
      res.status(404).json({ error: 'Workflow step not found' });
      return;
    }

    const workflow = await storage.getWorkflow(existingStep.workflowId, req.user.contractorId);
    if (!workflow) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    const deleted = await storage.deleteWorkflowStep(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: 'Workflow step not found' });
      return;
    }
    invalidateWorkflowStepsCache(existingStep.workflowId);
    broadcastToContractor(req.user.contractorId, { type: 'workflow_updated', workflowId: existingStep.workflowId });
    res.json({ success: true });
  }));

  app.get("/api/workflows/:workflowId/executions", asyncHandler(async (req: AuthedRequest, res: Response) => {
    const workflow = await storage.getWorkflow(req.params.workflowId, req.user.contractorId);
    if (!workflow) {
      res.status(404).json({ error: 'Workflow not found' });
      return;
    }

    const limit = req.query.limit ? parseInt(req.query.limit as string) : 50;
    const status = req.query.status as string | string[] | undefined;
    const executions = await storage.getWorkflowExecutions(req.params.workflowId, req.user.contractorId, limit, status);
    const parsedExecutions = executions.map(e => {
      const triggerData = e.triggerData ? (() => { try { return JSON.parse(e.triggerData!); } catch { return {}; } })() : {};
      return {
        ...e,
        stepLogs: e.executionLog ? JSON.parse(e.executionLog) : [],
        contactName: triggerData.name || triggerData.firstName
          ? [triggerData.firstName, triggerData.lastName].filter(Boolean).join(' ') || triggerData.name || null
          : null,
        contactEmail: triggerData.email || null,
      };
    });
    res.json(parsedExecutions);
  }));

  app.post("/api/workflow-executions/:id/cancel", asyncHandler(async (req: AuthedRequest, res: Response) => {
    const execution = await storage.getWorkflowExecution(req.params.id, req.user.contractorId);
    if (!execution) {
      res.status(404).json({ error: 'Workflow execution not found' });
      return;
    }

    const cancelled = await storage.cancelWorkflowExecution(req.params.id, req.user.contractorId);
    if (!cancelled) {
      res.status(409).json({ error: 'Execution cannot be cancelled (already completed, failed, or cancelled)' });
      return;
    }

    auditLog({
      contractorId: req.user.contractorId,
      userId: req.user.userId,
      action: 'workflow_execution.cancel',
      entityType: 'workflow_execution',
      entityId: req.params.id,
      before: { status: execution.status },
      after: { status: 'cancelled' },
    }).catch(err => log.error('Failed to write audit log for execution cancellation', err));

    res.json(cancelled);
  }));

  app.get("/api/contacts/:contactId/workflow-enrollments", asyncHandler(async (req: AuthedRequest, res: Response) => {
    const enrollments = await storage.getActiveExecutionsForContact(req.params.contactId, req.user.contractorId);
    res.json(enrollments);
  }));

  app.post("/api/contacts/bulk/workflow-enrollments", asyncHandler(async (req: AuthedRequest, res: Response) => {
    const { contactIds } = req.body;
    if (!Array.isArray(contactIds) || contactIds.length === 0) {
      res.json({});
      return;
    }
    const unique = [...new Set(contactIds.filter((id: unknown) => typeof id === 'string' && id.length > 0))];
    const capped = unique.slice(0, 200);
    const enrollments = await storage.getActiveExecutionsForContacts(capped, req.user.contractorId);
    res.json(enrollments);
  }));

  app.get("/api/workflow-executions/recent", asyncHandler(async (req: AuthedRequest, res: Response) => {
    const limit = req.query.limit ? parseInt(req.query.limit as string) : 50;
    const executions = await storage.getRecentWorkflowExecutions(req.user.contractorId, limit);
    res.json(executions);
  }));

  app.get("/api/workflow-executions/:id", asyncHandler(async (req: AuthedRequest, res: Response) => {
    const execution = await storage.getWorkflowExecution(req.params.id, req.user.contractorId);
    if (!execution) {
      res.status(404).json({ error: 'Workflow execution not found' });
      return;
    }

    res.json({
      ...execution,
      stepLogs: execution.executionLog ? JSON.parse(execution.executionLog) : [],
    });
  }));

  // Recent trigger dispatch decisions for a single workflow.
  //
  // Surfaces the `workflow.trigger_dispatch` audit trail (written by trigger-matcher)
  // as a per-workflow feed. For each contact_status_changed dispatch we either
  // matched-and-ran this workflow, or we considered it and skipped it with a reason.
  // This is the "why didn't my workflow run?" diagnostic.
  app.get("/api/workflows/:workflowId/dispatch-decisions", asyncHandler(async (req: AuthedRequest, res: Response) => {
    const workflow = await storage.getWorkflow(req.params.workflowId, req.user.contractorId);
    if (!workflow) {
      res.status(404).json({ error: 'Workflow not found' });
      return;
    }

    const limit = Math.min(100, Math.max(1, parseInt((req.query.limit as string) || '25', 10) || 25));

    // Pull a generous slice of recent dispatch logs for this contractor and filter
    // in-memory for ones that referenced this workflow. The audit volume per
    // contractor is bounded (only contact_status_changed events, capped to 50
    // skipped entries per row), so this is cheap relative to a JSON-path index.
    const SCAN_LIMIT = 500;
    const rows = await db.select({
      id: auditLogs.id,
      entityId: auditLogs.entityId,
      after: auditLogs.after,
      createdAt: auditLogs.createdAt,
    })
      .from(auditLogs)
      .where(and(
        eq(auditLogs.contractorId, req.user.contractorId),
        eq(auditLogs.action, 'workflow.trigger_dispatch'),
      ))
      .orderBy(desc(auditLogs.createdAt))
      .limit(SCAN_LIMIT);

    type DispatchAfter = {
      event?: string;
      entity?: string;
      entityName?: string | null;
      targetStatus?: string | null;
      matchedWorkflowIds?: string[];
      skipped?: { workflowId: string; workflowName: string; reason: string }[];
    };

    const decisions: {
      id: string;
      createdAt: Date;
      entityId: string | null;
      entityName: string | null;
      entityType: string | null;     // 'contact' | 'estimate' | 'job' (for deep-link routing on the client)
      eventType: string | null;      // e.g. 'contact_created', 'estimate_status_changed'
      status: 'matched' | 'skipped';
      reason: string | null;
      targetStatus: string | null;
      executionId: string | null;
    }[] = [];

    // Contact entity ids we still need to backfill names for. Newer audit rows
    // embed entityName in the payload, but rows written before that change don't
    // — so we still do the contacts lookup as a fallback (only for contact rows).
    const contactIdsNeedingName: string[] = [];

    for (const row of rows) {
      const after = (row.after ?? {}) as DispatchAfter;
      const matched = (after.matchedWorkflowIds ?? []).includes(req.params.workflowId);
      const skipEntry = matched
        ? null
        : (after.skipped ?? []).find(s => s.workflowId === req.params.workflowId) ?? null;

      if (!matched && !skipEntry) continue;

      // Prefer the entity recorded with the trigger payload. Older audit rows
      // were only ever written for contact_status_changed events (the previous
      // code path hard-coded entityType to 'contact'), so when after.entity is
      // missing it is safe to default to 'contact'.
      const entityType = after.entity
        ? (after.entity === 'lead' ? 'contact' : after.entity)
        : 'contact';

      const decision = {
        id: row.id,
        createdAt: row.createdAt,
        entityId: row.entityId,
        entityName: after.entityName ?? null,
        entityType,
        eventType: after.event ?? null,
        status: matched ? 'matched' as const : 'skipped' as const,
        reason: matched ? null : (skipEntry?.reason ?? null),
        targetStatus: after.targetStatus ?? null,
        executionId: null as string | null, // filled in below for matched rows
      };
      decisions.push(decision);

      if (!decision.entityName && decision.entityId && entityType === 'contact') {
        contactIdsNeedingName.push(decision.entityId);
      }

      if (decisions.length >= limit) break;
    }

    // Backfill contact names for older audit rows (and for the rare row where
    // the contact was renamed since the dispatch — fresher data wins).
    if (contactIdsNeedingName.length > 0) {
      const uniqueIds = Array.from(new Set(contactIdsNeedingName));
      const contactRows = await db.select({ id: contacts.id, name: contacts.name })
        .from(contacts)
        .where(and(eq(contacts.contractorId, req.user.contractorId), inArray(contacts.id, uniqueIds)));
      const nameById = new Map(contactRows.map(c => [c.id, c.name]));
      decisions.forEach(d => {
        if (!d.entityName && d.entityId && d.entityType === 'contact') {
          d.entityName = nameById.get(d.entityId) ?? null;
        }
      });
    }

    // For matched rows, look up the execution that this dispatch produced so the UI
    // can deep-link to the run. We match on workflow + contractor and parse the
    // triggerData JSON to pick the execution whose triggerData.id == entityId and
    // whose createdAt is within a small window of the dispatch decision.
    const matchedRows = decisions.filter(d => d.status === 'matched' && d.entityId);
    if (matchedRows.length > 0) {
      const earliest = matchedRows.reduce((min, d) => d.createdAt < min ? d.createdAt : min, matchedRows[0].createdAt);
      // Look back a few seconds before the earliest decision to handle clock skew.
      const since = new Date(earliest.getTime() - 5_000);
      const recentExecs = await storage.getRecentWorkflowExecutions(req.user.contractorId, 200);
      const candidates = recentExecs.filter(e =>
        e.workflowId === req.params.workflowId &&
        e.createdAt &&
        new Date(e.createdAt) >= since
      );
      const parsed = candidates.map(e => {
        let triggerId: string | null = null;
        try {
          const td = e.triggerData ? JSON.parse(e.triggerData) : {};
          triggerId = typeof td.id === 'string' ? td.id : null;
        } catch { /* ignore */ }
        return { id: e.id, createdAt: e.createdAt ? new Date(e.createdAt) : null, triggerId };
      });
      // One-to-one assignment: each execution can be linked to at most one decision.
      // Process decisions oldest-first so the earliest dispatch claims the earliest
      // matching execution. This avoids wrong links when the same contact triggers
      // the workflow multiple times in quick succession.
      const claimed = new Set<string>();
      const orderedMatched = [...matchedRows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      for (const d of orderedMatched) {
        const dispatchTimeMs = d.createdAt.getTime();
        const fits = parsed
          .filter(p =>
            p.triggerId === d.entityId &&
            p.createdAt &&
            !claimed.has(p.id) &&
            // Execution must be created after the dispatch (with 5s skew tolerance).
            p.createdAt.getTime() >= dispatchTimeMs - 5_000
          )
          .sort((a, b) => a.createdAt!.getTime() - b.createdAt!.getTime());
        const pick = fits[0];
        if (pick && pick.createdAt && pick.createdAt.getTime() - dispatchTimeMs <= 60_000) {
          d.executionId = pick.id;
          claimed.add(pick.id);
        }
      }
    }

    res.json(decisions);
  }));


  app.post("/api/workflows/:workflowId/execute", requireManagerOrAdmin, asyncHandler(async (req: AuthedRequest, res: Response) => {
    const workflow = await storage.getWorkflow(req.params.workflowId, req.user.contractorId);
    if (!workflow) {
      res.status(404).json({ error: 'Workflow not found' });
      return;
    }

    if (workflow.approvalStatus !== 'approved') {
      res.status(403).json({
        error: 'Cannot execute workflow',
        message: workflow.approvalStatus === 'pending_approval'
          ? 'This workflow requires admin approval before it can be executed'
          : 'This workflow has been rejected and cannot be executed'
      });
      return;
    }

    let triggerData = req.body.triggerData || {};
    if (typeof triggerData !== 'object' || triggerData === null || Array.isArray(triggerData)) {
      res.status(400).json({ error: 'Invalid triggerData - must be a valid object' });
      return;
    }

    // Enrich trigger data from DB so a manual Test run produces the same
    // payload a live trigger event would. See test-trigger-enrichment.ts and
    // toWorkflowEvent in entity-adapter.ts for the rationale.
    triggerData = await enrichTestTriggerData(triggerData, req.user.contractorId, storage);

    let triggerDataStr: string;
    try {
      triggerDataStr = JSON.stringify(triggerData);
      JSON.parse(triggerDataStr);
    } catch (e) {
      res.status(400).json({ error: 'Invalid triggerData - contains non-serializable values' });
      return;
    }

    const execution = await storage.createWorkflowExecution(
      {
        workflowId: req.params.workflowId,
        status: 'pending',
        triggerData: triggerDataStr,
      },
      req.user.contractorId
    );

    workflowEngine.executeWorkflow(execution.id, req.user.contractorId).catch(error => {
      log.error(`[Workflow API] Error executing workflow ${execution.id}:`, error);
    });

    res.status(201).json(execution);
  }));
}
