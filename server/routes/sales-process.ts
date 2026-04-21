import type { Express, Response } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { requireManagerOrAdmin, type AuthedRequest } from "../auth-service";
import { asyncHandler } from "../utils/async-handler";
import { backfillOpenLeads } from "../services/sales-process";
import { runDueAutoTasksOnce } from "../services/sales-process-cron";

const stepInputSchema = z.object({
  // dayOffset is "days since lead created"; per spec it must be a positive
  // integer (Day 1, Day 4, Day 7, …). Day 0 (immediate-on-create) is not a
  // valid cadence touchpoint — that's just the initial outreach.
  dayOffset: z.number().int().min(1).max(365),
  actionType: z.enum(['call', 'text', 'email']),
  mode: z.enum(['manual', 'auto']),
  messageTemplate: z.string().nullable().optional(),
  displayOrder: z.number().int().min(0).default(0),
});

const upsertProcessSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  active: z.boolean(),
  steps: z.array(stepInputSchema).max(50),
}).superRefine((data, ctx) => {
  // Auto steps for call/text/email need a template only for text/email; calls
  // can't be auto-dialed by us, so reject them up front.
  for (let i = 0; i < data.steps.length; i++) {
    const s = data.steps[i];
    if (s.mode === 'auto') {
      if (s.actionType === 'call') {
        ctx.addIssue({
          code: 'custom',
          path: ['steps', i, 'mode'],
          message: 'Calls cannot be set to auto — calls are always manual.',
        });
      } else if (!s.messageTemplate || s.messageTemplate.trim().length === 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['steps', i, 'messageTemplate'],
          message: 'Auto steps require a message template.',
        });
      }
    }
  }
  // Disallow exact duplicates of (dayOffset, actionType) — the unique index
  // would also catch this, but a clean validation error is friendlier.
  const seen = new Set<string>();
  for (let i = 0; i < data.steps.length; i++) {
    const key = `${data.steps[i].dayOffset}|${data.steps[i].actionType}`;
    if (seen.has(key)) {
      ctx.addIssue({
        code: 'custom',
        path: ['steps', i],
        message: 'Duplicate step: same day and action type.',
      });
    }
    seen.add(key);
  }
});

export function registerSalesProcessRoutes(app: Express): void {
  // GET — anyone in the tenant can read the cadence; managers edit.
  app.get("/api/sales-process", asyncHandler(async (req: AuthedRequest, res: Response) => {
    const data = await storage.getSalesProcessWithSteps(req.user.contractorId);
    res.json(data);
  }));

  // PUT — replace the whole process + steps. Returns backfill counts when
  // activation occurred so the manager sees the impact immediately.
  app.put("/api/sales-process", requireManagerOrAdmin, asyncHandler(async (req: AuthedRequest, res: Response) => {
    const parsed = upsertProcessSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid sales process', details: parsed.error.flatten() });
    }
    // Normalize displayOrder to mirror array order, ignoring whatever the
    // client sent — the canonical order is "as listed in the request body".
    const normalizedSteps = parsed.data.steps.map((s, i) => ({ ...s, displayOrder: i }));
    const result = await storage.upsertSalesProcess(req.user.contractorId, {
      name: parsed.data.name,
      active: parsed.data.active,
      steps: normalizedSteps,
    });

    // Backfill triggers per spec:
    //  (a) the process just transitioned inactive→active (`wasActivated`), OR
    //  (b) the process is already-active and a step list went from empty
    //      → non-empty for the first time. (b) covers the manager who flips
    //      "active" first, saves with no steps, then comes back later to
    //      author the cadence. Without (b) those open leads would never get
    //      tasks materialized.
    const becameNonEmpty = !result.wasActivated
      && result.process.active
      && result.previousStepCount === 0
      && result.steps.length > 0;
    let backfill = { leadsTouched: 0, tasksCreated: 0 };
    let backfillStarted = false;
    if (result.wasActivated || becameNonEmpty) {
      // Scaling contract: small tenants get an immediate, synchronous
      // backfill (so the manager sees task counts in the response toast).
      // Large tenants would block the request for many seconds while
      // hundreds of leads × N steps materialize, so above the threshold we
      // fire-and-forget and tell the UI a backfill was started in the
      // background. The cron will pick up any past-due auto sends on its
      // next tick regardless of which path ran.
      const tenantId = req.user.contractorId;
      const openCount = await storage.countOpenLeadsForBackfill(tenantId);
      const SYNC_THRESHOLD = 100;
      if (openCount <= SYNC_THRESHOLD) {
        backfill = await backfillOpenLeads(tenantId);
      } else {
        backfillStarted = true;
        // Detach: we intentionally don't await, but log failures so they
        // don't disappear into the void.
        void backfillOpenLeads(tenantId).catch((err) => {
          console.error(`[SalesProcess] async backfill failed tenantId=${tenantId}`, err);
        });
      }
    }

    res.json({
      process: result.process,
      steps: result.steps,
      removedStepIds: result.removedStepIds,
      changedStepIds: result.changedStepIds,
      wasActivated: result.wasActivated,
      backfill,
      backfillStarted,
    });
  }));

  // GET pending/due tasks for the Follow-ups view.
  app.get("/api/sales-process/tasks", asyncHandler(async (req: AuthedRequest, res: Response) => {
    const status = req.query.status as 'pending' | 'completed' | 'skipped' | 'failed' | undefined;
    const leadId = typeof req.query.leadId === 'string' ? req.query.leadId : undefined;
    const from = typeof req.query.from === 'string' ? new Date(req.query.from) : undefined;
    const to = typeof req.query.to === 'string' ? new Date(req.query.to) : undefined;
    const tasks = await storage.listTaskInstances(req.user.contractorId, {
      status,
      leadId,
      from: from && !isNaN(from.getTime()) ? from : undefined,
      to: to && !isNaN(to.getTime()) ? to : undefined,
    });
    res.json(tasks);
  }));

  app.post("/api/sales-process/tasks/:id/complete", asyncHandler(async (req: AuthedRequest, res: Response) => {
    const updated = await storage.markTaskCompleted(
      req.params.id,
      req.user.contractorId,
      'manual',
      req.user.userId,
    );
    if (updated) return res.json(updated);
    // Per spec: completing an already-terminal (completed/skipped/failed)
    // task is a no-op rather than a 404 — avoids confusing error toasts on
    // double-click / stale UI / race with cron auto-send.
    const current = await storage.getTaskInstance(req.params.id, req.user.contractorId);
    if (!current) return res.status(404).json({ error: 'Task not found' });
    return res.json(current);
  }));

  app.post("/api/sales-process/tasks/:id/skip", asyncHandler(async (req: AuthedRequest, res: Response) => {
    const updated = await storage.markTaskSkipped(
      req.params.id,
      req.user.contractorId,
      'manual',
      req.user.userId,
    );
    if (updated) return res.json(updated);
    // No-op on already-terminal tasks (same rationale as complete endpoint).
    const current = await storage.getTaskInstance(req.params.id, req.user.contractorId);
    if (!current) return res.status(404).json({ error: 'Task not found' });
    return res.json(current);
  }));

  // Manager debug endpoint: force a cron tick FOR THE CALLER'S TENANT ONLY.
  // SECURITY: this is a write-trigger (causes outbound SMS/email sends), so
  // we must scope strictly to req.user.contractorId — otherwise a manager in
  // tenant A could cause tenant B's due auto tasks to dispatch.
  app.post("/api/sales-process/run-now", requireManagerOrAdmin, asyncHandler(async (req: AuthedRequest, res: Response) => {
    const result = await runDueAutoTasksOnce({ limit: 50, contractorId: req.user.contractorId });
    res.json(result);
  }));
}
