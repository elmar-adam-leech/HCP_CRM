import type { Express, Response } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { requireManagerOrAdmin, type AuthedRequest } from "../auth-service";
import { asyncHandler } from "../utils/async-handler";
import { parseIntParam } from "../utils/validate-body";
import { backfillOpenLeads, backfillForCadence } from "../services/sales-process";
import { runDueAutoTasksOnce } from "../services/sales-process-cron";
import { createCadenceSchema, entityTypeForTrigger, type SalesProcessTriggerType } from "@shared/schema";
import { leadStatusEnum, estimateStatusEnum } from "@shared/schema/enums";

const stepInputSchema = z.object({
  // dayOffset is "days since lead created"; per spec it must be a positive
  // integer (Day 1, Day 4, Day 7, …). Day 0 (immediate-on-create) is not a
  // valid cadence touchpoint — that's just the initial outreach.
  dayOffset: z.number().int().min(1).max(365),
  actionType: z.enum(['call', 'text', 'email']),
  mode: z.enum(['manual', 'auto']),
  messageTemplate: z.string().nullable().optional(),
  // Task #729 — optional rep coaching surfaced on the Follow-Ups page.
  callScript: z.string().max(5000).nullable().optional(),
  guidance: z.string().max(5000).nullable().optional(),
  displayOrder: z.number().int().min(0).default(0),
});

// Per-cadence "early stop" status whitelists. The UI hides implicit
// terminals from the picker, but we accept them here as a no-op (they
// always stop the cadence regardless of this column). Sourced from the
// shared pgEnum so the route can never drift from the DB column type.
const LEAD_STOP_STATUSES = leadStatusEnum.enumValues;
const ESTIMATE_STOP_STATUSES = estimateStatusEnum.enumValues;

const upsertProcessSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  active: z.boolean(),
  steps: z.array(stepInputSchema).max(50),
  // Optional. Validated against the cadence's entityType after we look the
  // cadence up (per-entity-type enum). Accept array of strings here.
  stopStatuses: z.array(z.string()).max(20).optional(),
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
  // BACK-COMPAT: returns the canonical `lead_created` cadence + steps.
  app.get("/api/sales-process", asyncHandler(async (req: AuthedRequest, res: Response) => {
    const data = await storage.getSalesProcessWithSteps(req.user.contractorId);
    res.json(data);
  }));

  // List every cadence configured for the tenant.
  app.get("/api/sales-process/cadences", asyncHandler(async (req: AuthedRequest, res: Response) => {
    const cadences = await storage.listCadences(req.user.contractorId);
    res.json(cadences);
  }));

  // Create a new cadence. The discriminated schema enforces that `lead_created`
  // never carries a target_status and that *_status_changed always does.
  app.post("/api/sales-process/cadences", requireManagerOrAdmin, asyncHandler(async (req: AuthedRequest, res: Response) => {
    const parsed = createCadenceSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid cadence', details: parsed.error.flatten() });
      return;
    }
    const trigger = parsed.data.triggerType as SalesProcessTriggerType;
    const targetStatus = trigger === 'lead_created' ? null : (parsed.data as { targetStatus: string }).targetStatus;
    const entityType = entityTypeForTrigger(trigger);
    const defaultName = trigger === 'lead_created'
      ? 'New leads'
      : trigger === 'lead_status_changed'
        ? `Lead status → ${targetStatus}`
        : `Estimate status → ${targetStatus}`;
    // Validate optional stopStatuses against the entity-type enum derived
    // from the trigger (task #725). Same rules as the upsert route.
    let createStopStatuses: string[] | null = null;
    if (parsed.data.stopStatuses && parsed.data.stopStatuses.length > 0) {
      const allowed = entityType === 'estimate' ? ESTIMATE_STOP_STATUSES : LEAD_STOP_STATUSES;
      const invalid = parsed.data.stopStatuses.filter(s => !allowed.includes(s as never));
      if (invalid.length > 0) {
        res.status(400).json({ error: `Invalid stop statuses for ${entityType} cadence: ${invalid.join(', ')}` });
        return;
      }
      createStopStatuses = Array.from(new Set(parsed.data.stopStatuses));
    }
    try {
      const cadence = await storage.createCadence({
        contractorId: req.user.contractorId,
        name: parsed.data.name?.trim() || defaultName,
        triggerType: trigger,
        targetStatus,
        entityType,
        active: parsed.data.active ?? false,
        stopStatuses: createStopStatuses,
      });
      res.status(201).json(cadence);
    } catch (err: unknown) {
      // Unique-violation on (contractor_id, trigger_type, COALESCE(target_status, '')) → 409.
      const code = (err as { code?: string }).code;
      if (code === '23505') {
        res.status(409).json({ error: 'A cadence already exists for that trigger.' });
        return;
      }
      throw err;
    }
  }));

  app.get("/api/sales-process/cadences/:id", asyncHandler(async (req: AuthedRequest, res: Response) => {
    const data = await storage.getCadenceWithSteps(req.params.id, req.user.contractorId);
    if (!data) {
      res.status(404).json({ error: 'Cadence not found' });
      return;
    }
    res.json(data);
  }));

  app.put("/api/sales-process/cadences/:id", requireManagerOrAdmin, asyncHandler(async (req: AuthedRequest, res: Response) => {
    const parsed = upsertProcessSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid cadence', details: parsed.error.flatten() });
      return;
    }
    const normalizedSteps = parsed.data.steps.map((s, i) => ({ ...s, displayOrder: i }));
    // Validate `stopStatuses` against this cadence's entityType. We must
    // look the cadence up first because the schema doesn't know whether
    // we're editing a lead or estimate cadence.
    let stopStatuses: string[] | undefined;
    if (parsed.data.stopStatuses !== undefined) {
      const cadence = await storage.getCadenceById(req.params.id, req.user.contractorId);
      if (!cadence) {
        res.status(404).json({ error: 'Cadence not found' });
        return;
      }
      const allowed = cadence.entityType === 'estimate' ? ESTIMATE_STOP_STATUSES : LEAD_STOP_STATUSES;
      const invalid = parsed.data.stopStatuses.filter(s => !allowed.includes(s as never));
      if (invalid.length > 0) {
        res.status(400).json({ error: `Invalid stop statuses for ${cadence.entityType} cadence: ${invalid.join(', ')}` });
        return;
      }
      // Dedupe while preserving order.
      stopStatuses = Array.from(new Set(parsed.data.stopStatuses));
    }
    const result = await storage.upsertCadence(req.params.id, req.user.contractorId, {
      name: parsed.data.name,
      active: parsed.data.active,
      steps: normalizedSteps,
      stopStatuses,
    });
    if (!result) {
      res.status(404).json({ error: 'Cadence not found' });
      return;
    }
    const becameNonEmpty = !result.wasActivated
      && result.process.active
      && result.previousStepCount === 0
      && result.steps.length > 0;
    let backfill = { leadsTouched: 0, tasksCreated: 0 };
    let backfillStarted = false;
    if (result.wasActivated || becameNonEmpty) {
      // Same scaling contract as the legacy endpoint: small tenants get a
      // synchronous backfill so the toast shows real numbers; larger tenants
      // detach to avoid blocking the request.
      const tenantId = req.user.contractorId;
      // Entity-aware sizing: estimate cadences should not be sized by lead
      // count and vice versa. The "open" set for a cadence is exactly what
      // the matching backfill helper would touch.
      const openCount = result.process.entityType === 'estimate' && result.process.targetStatus
        ? await storage.countOpenEstimatesForBackfill(tenantId, result.process.targetStatus)
        : await storage.countOpenLeadsForBackfill(tenantId);
      const SYNC_THRESHOLD = 100;
      if (openCount <= SYNC_THRESHOLD) {
        backfill = await backfillForCadence(result.process.id, tenantId);
      } else {
        backfillStarted = true;
        void backfillForCadence(result.process.id, tenantId).catch((err) => {
          console.error(`[SalesProcess] async backfill failed tenantId=${tenantId} cadenceId=${result.process.id}`, err);
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

  app.delete("/api/sales-process/cadences/:id", requireManagerOrAdmin, asyncHandler(async (req: AuthedRequest, res: Response) => {
    const ok = await storage.deleteCadence(req.params.id, req.user.contractorId);
    if (!ok) {
      res.status(404).json({ error: 'Cadence not found' });
      return;
    }
    res.json({ ok: true });
  }));

  // PUT — replace the whole process + steps. Returns backfill counts when
  // activation occurred so the manager sees the impact immediately.
  app.put("/api/sales-process", requireManagerOrAdmin, asyncHandler(async (req: AuthedRequest, res: Response) => {
    const parsed = upsertProcessSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid sales process', details: parsed.error.flatten() });
      return;
    }
    // Normalize displayOrder to mirror array order, ignoring whatever the
    // client sent — the canonical order is "as listed in the request body".
    const normalizedSteps = parsed.data.steps.map((s, i) => ({ ...s, displayOrder: i }));
    // Legacy default cadence is always entityType=lead. Validate
    // stopStatuses against the lead enum so the field is no longer
    // silently dropped (task #725 review fix).
    let legacyStopStatuses: string[] | undefined;
    if (parsed.data.stopStatuses !== undefined) {
      const invalid = parsed.data.stopStatuses.filter(s => !LEAD_STOP_STATUSES.includes(s as never));
      if (invalid.length > 0) {
        res.status(400).json({ error: `Invalid stop statuses for lead cadence: ${invalid.join(', ')}` });
        return;
      }
      legacyStopStatuses = Array.from(new Set(parsed.data.stopStatuses));
    }
    const result = await storage.upsertSalesProcess(req.user.contractorId, {
      name: parsed.data.name,
      active: parsed.data.active,
      steps: normalizedSteps,
      stopStatuses: legacyStopStatuses,
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

  // GET pending/due tasks for the Follow-ups view. When `withLead=1` is
  // passed (the Follow-ups Sales Process view's only consumer), join in the
  // lead + contact summary fields so the UI can render rows in a single
  // round trip.
  app.get("/api/sales-process/tasks", asyncHandler(async (req: AuthedRequest, res: Response) => {
    const leadId = typeof req.query.leadId === 'string' ? req.query.leadId : undefined;
    const estimateId = typeof req.query.estimateId === 'string' ? req.query.estimateId : undefined;
    const contactId = typeof req.query.contactId === 'string' ? req.query.contactId : undefined;
    const from = typeof req.query.from === 'string' ? new Date(req.query.from) : undefined;
    const to = typeof req.query.to === 'string' ? new Date(req.query.to) : undefined;
    const fromDate = from && !isNaN(from.getTime()) ? from : undefined;
    const toDate = to && !isNaN(to.getTime()) ? to : undefined;
    const validStatuses = ['pending', 'completed', 'skipped', 'failed'] as const;
    type Status = typeof validStatuses[number];
    // `status` accepts a comma-separated list (e.g. "pending,failed"), or a
    // single value, or omitted (returns all statuses).
    let statuses: Status[] | undefined;
    if (typeof req.query.status === 'string' && req.query.status.length > 0) {
      const parsed = req.query.status
        .split(',')
        .map((s) => s.trim())
        .filter((s): s is Status => (validStatuses as readonly string[]).includes(s));
      if (parsed.length > 0) statuses = parsed;
    }
    // Paging is opt-in: callers that pass `paged=1` (or `limit`/`offset`)
    // get the `{ items, total, hasMore }` envelope. Callers that omit
    // those params keep the legacy raw-array response, so the various
    // older surfaces (lead detail to-do list, settings invalidations,
    // service-internal callers) don't need to migrate at the same time.
    const wantsPaged =
      req.query.paged === '1' ||
      req.query.paged === 'true' ||
      req.query.limit !== undefined ||
      req.query.offset !== undefined;
    let limitVal: number | undefined;
    let offsetVal: number | undefined;
    if (wantsPaged) {
      const parsedLimit = parseIntParam(req.query.limit as string | undefined, 50, 200);
      if (parsedLimit === null || parsedLimit < 1) {
        res.status(400).json({ message: "Invalid 'limit' parameter: must be a positive number" });
        return;
      }
      const parsedOffset = parseIntParam(req.query.offset as string | undefined, 0);
      if (parsedOffset === null || parsedOffset < 0) {
        res.status(400).json({ message: "Invalid 'offset' parameter: must be a non-negative number" });
        return;
      }
      limitVal = parsedLimit;
      offsetVal = parsedOffset;
    }
    // ?withEstimate=1 returns the estimate-anchored equivalent of withLead=1.
    if (req.query.withEstimate === '1' || req.query.withEstimate === 'true') {
      const result = await storage.listEstimateTaskInstancesWithSummary(req.user.contractorId, {
        estimateId,
        contactId,
        statuses,
        from: fromDate,
        to: toDate,
        limit: limitVal,
        offset: offsetVal,
      });
      if (wantsPaged) {
        res.json({
          items: result.items,
          total: result.total,
          hasMore: (offsetVal ?? 0) + result.items.length < result.total,
        });
      } else {
        res.json(result.items);
      }
      return;
    }
    if (req.query.withLead === '1' || req.query.withLead === 'true') {
      const result = await storage.listTaskInstancesWithLeadSummary(req.user.contractorId, {
        leadId,
        contactId,
        statuses,
        from: fromDate,
        to: toDate,
        limit: limitVal,
        offset: offsetVal,
      });
      if (wantsPaged) {
        res.json({
          items: result.items,
          total: result.total,
          hasMore: (offsetVal ?? 0) + result.items.length < result.total,
        });
      } else {
        res.json(result.items);
      }
      return;
    }
    const tasks = await storage.listTaskInstances(req.user.contractorId, {
      status: statuses && statuses.length === 1 ? statuses[0] : undefined,
      leadId,
      estimateId,
      from: fromDate,
      to: toDate,
    });
    res.json(tasks);
  }));

  // Count of tasks completed since a given timestamp — powers the empty
  // "All caught up — N completed today" state on the Follow-ups page.
  app.get("/api/sales-process/tasks/completed-count", asyncHandler(async (req: AuthedRequest, res: Response) => {
    const sinceRaw = typeof req.query.since === 'string' ? new Date(req.query.since) : undefined;
    const since = sinceRaw && !isNaN(sinceRaw.getTime()) ? sinceRaw : new Date(new Date().setHours(0, 0, 0, 0));
    const count = await storage.countCompletedTasksSince(req.user.contractorId, since);
    res.json({ count });
  }));

  app.post("/api/sales-process/tasks/:id/complete", asyncHandler(async (req: AuthedRequest, res: Response) => {
    const updated = await storage.markTaskCompleted(
      req.params.id,
      req.user.contractorId,
      'manual',
      req.user.userId,
    );
    if (updated) {
      res.json(updated);
      return;
    }
    // Per spec: completing an already-terminal (completed/skipped/failed)
    // task is a no-op rather than a 404 — avoids confusing error toasts on
    // double-click / stale UI / race with cron auto-send.
    const current = await storage.getTaskInstance(req.params.id, req.user.contractorId);
    if (!current) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }
    res.json(current);
  }));

  // Reset a permanently-failed task back to pending so the cron retries it.
  // Only operates on `failed` rows; if the task is in any other state we
  // return its current state so the UI can resync without an error toast.
  app.post("/api/sales-process/tasks/:id/retry", asyncHandler(async (req: AuthedRequest, res: Response) => {
    const updated = await storage.retryFailedTask(req.params.id, req.user.contractorId);
    if (updated) {
      res.json(updated);
      return;
    }
    const current = await storage.getTaskInstance(req.params.id, req.user.contractorId);
    if (!current) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }
    res.json(current);
  }));

  // Reschedule a pending task to a new dueAt — lets reps push a touchpoint
  // out a day or two ("lead asked me to call back tomorrow") instead of
  // having to skip work just to clear the queue. Only operates on `pending`
  // rows; calling on a terminal task is a no-op (returns the current row).
  app.post("/api/sales-process/tasks/:id/reschedule", asyncHandler(async (req: AuthedRequest, res: Response) => {
    const bodySchema = z.object({
      dueAt: z.string().refine((s) => !isNaN(new Date(s).getTime()), {
        message: 'dueAt must be a valid ISO date string',
      }),
    });
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid reschedule', details: parsed.error.flatten() });
      return;
    }
    const nextDueAt = new Date(parsed.data.dueAt);
    // Reject scheduling into the past — rescheduling is a forward action.
    // We allow "now" (1 minute of slack) so quick "later today" presets
    // computed client-side don't race the server clock.
    if (nextDueAt.getTime() < Date.now() - 60_000) {
      res.status(400).json({ error: 'New due date must be in the future.' });
      return;
    }
    const updated = await storage.rescheduleTask(
      req.params.id,
      req.user.contractorId,
      nextDueAt,
      req.user.userId,
    );
    if (updated) {
      res.json(updated);
      return;
    }
    const current = await storage.getTaskInstance(req.params.id, req.user.contractorId);
    if (!current) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }
    res.json(current);
  }));

  app.post("/api/sales-process/tasks/:id/skip", asyncHandler(async (req: AuthedRequest, res: Response) => {
    const updated = await storage.markTaskSkipped(
      req.params.id,
      req.user.contractorId,
      'manual',
      req.user.userId,
    );
    if (updated) {
      res.json(updated);
      return;
    }
    // No-op on already-terminal tasks (same rationale as complete endpoint).
    const current = await storage.getTaskInstance(req.params.id, req.user.contractorId);
    if (!current) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }
    res.json(current);
  }));

  // Bulk skip / complete — lets a rep clean up a backlog of stale tasks in
  // a single POST instead of one POST per row. Both endpoints accept up to
  // 200 task IDs at a time (caps payload size and bounds the per-request
  // work — even a power user catching up on a backlog is unlikely to
  // select more than that at once). The whole batch is routed through ONE
  // transactional storage call (storage.bulkMarkTasksTerminal) so a
  // mid-batch DB error rolls back every row touched by the request.
  // Per-id outcomes are returned so the UI can re-show only the rows that
  // truly didn't apply: rows that were already terminal in another tab
  // are reported as ok (matching the single-row endpoint's no-op
  // behavior), and cross-tenant / deleted IDs are reported as
  // `error: 'not_found'`. Both routes are tenant-scoped via
  // req.user.contractorId, so a leaked task ID from another tenant simply
  // appears as "not_found" — there's no IDOR risk. Authenticated routes
  // are already covered by the global apiRateLimiter; the 200-id cap is
  // the per-call work bound. See task #747.
  const bulkBodySchema = z.object({
    ids: z.array(z.string().min(1)).min(1).max(200),
  });

  type BulkResult = {
    results: Array<{ id: string; ok: boolean; error?: string }>;
    succeeded: number;
    failed: number;
  };

  async function runBulkTaskAction(
    req: AuthedRequest,
    res: Response,
    action: 'complete' | 'skip',
  ): Promise<void> {
    const parsed = bulkBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid bulk request', details: parsed.error.flatten() });
      return;
    }
    const ids = Array.from(new Set(parsed.data.ids));
    const out: BulkResult = { results: [], succeeded: 0, failed: 0 };
    // ATOMIC: the entire batch runs inside one drizzle transaction
    // (see storage.bulkMarkTasksTerminal). A mid-batch DB failure
    // rolls back every row touched by this request, so the client
    // never observes a partially-applied bulk action. "already
    // terminal" rows are reported as ok (matching the single-row
    // endpoint), and cross-tenant / deleted IDs report not_found.
    try {
      const target = action === 'complete' ? 'completed' : 'skipped';
      const outcomes = await storage.bulkMarkTasksTerminal(
        ids,
        req.user.contractorId,
        target,
        'manual',
        req.user.userId,
      );
      for (const id of ids) {
        const o = outcomes.get(id);
        if (o === 'updated' || o === 'already_terminal') {
          out.results.push({ id, ok: true });
          out.succeeded += 1;
        } else {
          out.results.push({ id, ok: false, error: 'not_found' });
          out.failed += 1;
        }
      }
    } catch (err) {
      // Transaction rolled back — no rows changed. Surface a single
      // batch-level failure so the UI can re-show every selected row.
      const msg = err instanceof Error ? err.message : 'error';
      for (const id of ids) out.results.push({ id, ok: false, error: msg });
      out.failed = ids.length;
    }
    res.json(out);
  }

  app.post("/api/sales-process/tasks/bulk-complete", asyncHandler(async (req: AuthedRequest, res: Response) => {
    await runBulkTaskAction(req, res, 'complete');
  }));

  app.post("/api/sales-process/tasks/bulk-skip", asyncHandler(async (req: AuthedRequest, res: Response) => {
    await runBulkTaskAction(req, res, 'skip');
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
