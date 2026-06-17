/**
 * WorkflowEngine — event-driven automation engine.
 *
 * Architecture overview:
 *   - Trigger model: external code calls `triggerWorkflowsForEvent(eventType, entityData, contractorId)`
 *     after any entity mutation (contact created, job status changed, etc.).
 *   - Action model: each WorkflowStep maps to a discrete action handler in `server/workflow-actions/`.
 *     Steps with the same `stepOrder` are executed in parallel via `Promise.all`; groups at
 *     different step orders run sequentially to preserve causality.
 *   - Singleton: `WorkflowEngine.getInstance()` returns the single application-wide instance.
 *
 * Delay / wait_until actions:
 *   These actions persist a "suspended" execution row with a `resumeAt` timestamp and return
 *   immediately — no in-memory timer is held. The `startSuspendedPoller()` loop (30 s interval)
 *   picks them up once the timestamp passes. See `server/workflow-actions/delay.ts` for details.
 *
 * How to add a new action type:
 *   1. Create `server/workflow-actions/<action>.ts` exporting `handle<Action>(step, params, context)`.
 *   2. Add a `case '<action>':` entry in `step-executor.ts`.
 *   3. Register the node type mapping in `client/src/lib/workflow-utils.ts` (`ACTION_TO_NODE`).
 *
 * Module layout:
 *   - types.ts          — StepLog, StepGroupOutcome, re-exports of ExecutionContext / StepResult
 *   - event-map.ts      — EVENT_MAPPING constant and eventType union
 *   - context-builder.ts — buildExecutionContext() shared helper (removes duplication)
 *   - step-executor.ts  — executeStep() + extractConfig() standalone functions
 *   - step-runner.ts    — runStepGroups() standalone function
 *   - trigger-matcher.ts — matchAndEnrichWorkflows() standalone function
 *   - poller.ts         — SuspendedExecutionPoller class
 *   - recovery.ts       — recoverZombieExecutions() standalone function
 */
import { storage } from "../storage";
import { broadcastToContractor } from "../websocket";
import { getWorkflowStepsCached } from "../services/cache";
import { logger } from "../utils/logger";

import type { StepLog } from "./types";
export type { ExecutionContext, StepResult } from "./types";

import { buildExecutionContext } from "./context-builder";
import { runStepGroups } from "./step-runner";
import { matchAndEnrichWorkflows } from "./trigger-matcher";
import { SuspendedExecutionPoller } from "./poller";
import { recoverZombieExecutions } from "./recovery";
import type { eventType } from "./event-map";

const log = logger('WorkflowEngine');

export class WorkflowEngine {
  private static instance: WorkflowEngine;
  private _poller: SuspendedExecutionPoller;

  private constructor() {
    this._poller = new SuspendedExecutionPoller(
      (executionId, contractorId) => this.resumeSuspendedWorkflow(executionId, contractorId)
    );
  }

  static getInstance(): WorkflowEngine {
    if (!WorkflowEngine.instance) {
      WorkflowEngine.instance = new WorkflowEngine();
    }
    return WorkflowEngine.instance;
  }

  /**
   * Execute a workflow to completion given an already-created execution record.
   *
   * High-level flow:
   *   1. Load the execution + parent workflow. Bail early if missing/inactive/unapproved.
   *   2. Load workflow steps from cache (60s TTL) — avoids a DB hit on every trigger.
   *   3. Delegate to `runStepGroups` which groups steps by `stepOrder`, runs each group
   *      in parallel via Promise.all, and handles suspend / fail-fast / variable merging.
   *
   * Broadcasting: Sends WebSocket events to the contractor's browser for real-time
   * workflow progress updates (workflow_started, workflow_completed, workflow_failed).
   *
   * @param executionId  - ID of the WorkflowExecution row created by the trigger.
   * @param contractorId - Tenant identifier used for all storage calls (security boundary).
   */
  async executeWorkflow(executionId: string, contractorId: string): Promise<void> {
    try {
      const execution = await storage.getWorkflowExecution(executionId, contractorId);
      if (!execution) {
        log.error(`Execution ${executionId} not found for contractor ${contractorId}`);
        return;
      }

      const workflow = await storage.getWorkflow(execution.workflowId, contractorId);
      if (!workflow) {
        log.error(`Workflow ${execution.workflowId} not found`);
        await this.updateExecutionStatus(executionId, contractorId, 'failed', 'Workflow not found');
        return;
      }

      if (!workflow.isActive) {
        log.info(`Workflow ${workflow.id} is not active, skipping execution`);
        await this.updateExecutionStatus(executionId, contractorId, 'failed', 'Workflow is not active');
        return;
      }

      if (workflow.approvalStatus !== 'approved') {
        log.info(`Workflow ${workflow.id} is not approved (status: ${workflow.approvalStatus}), skipping execution`);
        await this.updateExecutionStatus(executionId, contractorId, 'failed', `Workflow is not approved (status: ${workflow.approvalStatus})`);
        return;
      }

      const steps = await getWorkflowStepsCached(workflow.id);
      if (!steps || steps.length === 0) {
        log.info(`Workflow ${workflow.id} has no steps`);
        await this.updateExecutionStatus(executionId, contractorId, 'completed', 'No steps to execute');
        return;
      }

      const triggerData = execution.triggerData ? JSON.parse(execution.triggerData) : {};
      const triggerConfig = workflow.triggerConfig ? JSON.parse(workflow.triggerConfig) : {};

      const context = await buildExecutionContext({
        workflowId: workflow.id,
        executionId: execution.id,
        contractorId: execution.contractorId,
        workflowCreatorId: workflow.createdBy,
        triggerData,
        triggerConfig,
      });

      await this.updateExecutionStatus(executionId, contractorId, 'running');

      broadcastToContractor(execution.contractorId, {
        type: 'workflow_started',
        executionId: execution.id,
        workflowId: workflow.id,
        workflowName: workflow.name
      });

      log.info(`Starting execution ${executionId} for workflow "${workflow.name}"`);

      const stepLogs: StepLog[] = [];
      const outcome = await runStepGroups(steps, stepLogs, context, executionId, contractorId);

      await storage.updateWorkflowExecution(executionId, { executionLog: JSON.stringify(stepLogs) }, contractorId);

      switch (outcome.kind) {
        case 'cancelled':
          log.info(`Execution ${executionId} was cancelled during execution; status already set by cancel endpoint`);
          return;

        case 'suspended':
          await storage.updateWorkflowExecution(executionId, {
            currentStep: outcome.stepOrder,
            resumeAt: outcome.resumeAt,
            status: 'suspended',
          }, contractorId);
          log.info(`Execution ${executionId} suspended until ${outcome.resumeAt.toISOString()}`);
          return;

        case 'failed':
          await this.updateExecutionStatusIfNotCancelled(executionId, contractorId, 'failed', outcome.errorMessages);
          broadcastToContractor(execution.contractorId, {
            type: 'workflow_failed',
            executionId: execution.id,
            workflowId: workflow.id,
            workflowName: workflow.name,
            error: outcome.errorMessages
          });
          return;

        case 'completed':
          await this.updateExecutionStatusIfNotCancelled(executionId, contractorId, 'completed');
          broadcastToContractor(execution.contractorId, {
            type: 'workflow_completed',
            executionId: execution.id,
            workflowId: workflow.id,
            workflowName: workflow.name
          });
          log.info(`Execution ${executionId} completed successfully`);
          return;
      }
    } catch (error) {
      log.error('Error executing workflow', error);
      await this.updateExecutionStatusIfNotCancelled(executionId, contractorId, 'failed', error instanceof Error ? error.message : 'Unknown error');
    }
  }

  /**
   * Trigger workflows that match a business event (e.g. contact_created, estimate_updated).
   *
   * Flow:
   *   1. Map the eventType to its { entity, event } shape via matchAndEnrichWorkflows.
   *   2. Fetch all active + approved workflows from the DB (single query).
   *   3. Filter in-memory by trigger config (entity, event, status, tags).
   *   4. Enrich the entity data with related records (contact, etc.) ONCE — before
   *      the loop — so the enrichment DB call is O(1) regardless of how many
   *      workflows match.
   *   5. Create an execution record for each matching workflow and fire them off
   *      asynchronously (non-blocking).
   *
   * Scale note: getActiveApprovedWorkflows filters on (contractor_id, is_active, approval_status).
   * A composite index workflows_active_approved_idx on those three columns is added in db.ts
   * so this query uses an index seek rather than a full table scan per event.
   */
  async triggerWorkflowsForEvent(
    eventType: eventType,
    entityData: Record<string, unknown>,
    contractorId: string
  ): Promise<void> {
    try {
      const result = await matchAndEnrichWorkflows(eventType, entityData, contractorId);
      if (!result) return;

      const { matchingWorkflows, enrichedData } = result;

      // Stale-trigger fan-out (#437): when an estimate is created, schedule
      // suspended executions for any active estimate_stale workflows. The
      // poller picks them up after `staleDays` days and resumeSuspendedWorkflow
      // gates execution on the estimate still being un-acted-upon.
      if (eventType === 'estimate_created') {
        await this.scheduleStaleEstimateExecutions(enrichedData, contractorId).catch(err =>
          log.error('Failed to schedule estimate_stale executions', err));
      }
      // When an estimate option is approved/rejected, cancel any pending
      // stale executions for that estimate so we don't ping the customer
      // about a no-response after they've already responded.
      if (eventType === 'estimate_option_approved' || eventType === 'estimate_option_rejected') {
        await this.cancelPendingStaleExecutions(String(enrichedData.id ?? ''), contractorId).catch(err =>
          log.error('Failed to cancel stale executions', err));
      }

      for (const { workflow } of matchingWorkflows) {
        try {
          const execution = await storage.createWorkflowExecution(
            {
              workflowId: workflow.id,
              status: 'pending',
              triggerData: JSON.stringify(enrichedData),
            },
            contractorId
          );

          log.info(`Triggered workflow "${workflow.name}" (ID: ${workflow.id}) for ${eventType}`);

          this.executeWorkflow(execution.id, contractorId).catch(error => {
            log.error(`Error executing workflow ${execution.id}`, error);
          });

          // Nudge the suspended-execution poller in case this workflow has delay steps
          this.nudgePoller();
        } catch (error) {
          // The execution record could not be created (e.g. transient DB error).
          // Retry is NOT safe without per-step idempotency keys: a retry would produce
          // a new executionId, so we cannot detect whether a previous attempt's action
          // steps already ran (e.g. an email was already sent to the customer).
          //
          // DEFERRED: Implement safe retry once every action step is assigned a
          // stable idempotency key (e.g. hash of workflowId + stepOrder + triggerData).
          // Until then, re-running steps risks double-sending messages.
          // On-call: use the logged workflowId + eventType to manually re-trigger.
          log.warn(
            `Skipping retry for workflow "${workflow.name}" (ID: ${workflow.id}): retries are unsafe without per-step idempotency keys. Event: ${eventType}, contractor: ${contractorId}`,
            { workflowId: workflow.id, workflowName: workflow.name, eventType, contractorId }
          );
          log.error(
            `Failed to create WorkflowExecution for workflow "${workflow.name}" (ID: ${workflow.id}) — event: ${eventType}, contractorId: ${contractorId}`,
            { error, workflowId: workflow.id, workflowName: workflow.name, eventType, contractorId }
          );
          // Best-effort: persist a failed execution row so this failure is auditable
          // in the workflow execution history. A second DB error here is swallowed
          // so the outer loop can continue processing other workflows.
          storage.createWorkflowExecution({
            workflowId: workflow.id,
            status: 'failed',
            triggerData: JSON.stringify({ eventType }),
            errorMessage: `Failed to create execution: ${error instanceof Error ? error.message : String(error)}`,
          }, contractorId).catch(secondaryErr => {
            log.error(
              `Failed to persist failure record for workflow "${workflow.name}" (ID: ${workflow.id})`,
              { secondaryErr }
            );
          });
        }
      }
    } catch (error) {
      log.error('Error in triggerWorkflowsForEvent', error);
    }
  }

  /**
   * Resume a suspended execution by re-running all steps after the saved currentStep.
   */
  async resumeSuspendedWorkflow(executionId: string, contractorId: string): Promise<void> {
    try {
      const execution = await storage.getWorkflowExecution(executionId, contractorId);
      // Accept both 'suspended' and 'running' here:
      // - 'running'   → the poller atomically claimed the execution via claimSuspendedExecution()
      //                 before calling this function, so status is already 'running'.
      // - 'suspended' → called directly (e.g. in tests) without going through the poller.
      // Any other terminal status (completed/failed/cancelled) means the execution was
      // already resolved by a concurrent path and we should bail without touching it.
      if (!execution || (execution.status !== 'suspended' && execution.status !== 'running')) return;

      const workflow = await storage.getWorkflow(execution.workflowId, contractorId);
      if (!workflow || !workflow.isActive || workflow.approvalStatus !== 'approved') {
        await storage.updateWorkflowExecution(executionId, {
          status: 'failed',
          errorMessage: 'Workflow inactive or unapproved at resume time',
          completedAt: new Date(),
        }, contractorId);
        return;
      }

      const allSteps = await getWorkflowStepsCached(workflow.id);
      if (!allSteps || allSteps.length === 0) {
        await this.updateExecutionStatus(executionId, contractorId, 'completed');
        return;
      }

      const resumeFromOrder = (execution.currentStep ?? -1) + 1;
      const remainingSteps = allSteps.filter(s => s.stepOrder >= resumeFromOrder);
      if (remainingSteps.length === 0) {
        await this.updateExecutionStatus(executionId, contractorId, 'completed');
        return;
      }

      const triggerData = execution.triggerData ? JSON.parse(execution.triggerData) : {};
      const triggerConfig = workflow.triggerConfig ? JSON.parse(workflow.triggerConfig) : {};

      // Stale-trigger gate (#437): re-validate the estimate is still
      // un-acted-upon before firing the workflow body. If approved/rejected
      // in the meantime, mark the execution cancelled and bail.
      if (triggerData?.__staleCheck?.estimateId) {
        try {
          const fresh = await storage.getEstimate(String(triggerData.__staleCheck.estimateId), contractorId);
          if (!fresh || fresh.status === 'approved' || fresh.status === 'rejected') {
            await storage.updateWorkflowExecution(executionId, {
              status: 'cancelled',
              completedAt: new Date(),
              errorMessage: !fresh
                ? 'Estimate no longer exists at stale check'
                : `Estimate already ${fresh.status} — stale workflow skipped`,
            }, contractorId);
            log.info(`Stale execution ${executionId} skipped — estimate state ${fresh?.status ?? 'missing'}`);
            return;
          }
          const enriched = await storage.getEstimateWithContact(String(triggerData.__staleCheck.estimateId), contractorId);
          if (enriched) Object.assign(triggerData, enriched);
        } catch (err) {
          log.error(`Stale gate check failed for execution ${executionId}`, err);
        }
        delete triggerData.__staleCheck;
      }

      const context = await buildExecutionContext({
        workflowId: workflow.id,
        executionId: execution.id,
        contractorId: execution.contractorId,
        workflowCreatorId: workflow.createdBy,
        triggerData,
        triggerConfig,
      });

      await storage.updateWorkflowExecution(executionId, { status: 'running', resumeAt: null }, contractorId);

      log.info(`Resuming suspended execution ${executionId} from step order ${resumeFromOrder}`);

      const existingLog: StepLog[] = execution.executionLog ? JSON.parse(execution.executionLog) : [];
      const stepLogs: StepLog[] = [...existingLog];

      const outcome = await runStepGroups(remainingSteps, stepLogs, context, executionId, contractorId);

      await storage.updateWorkflowExecution(executionId, { executionLog: JSON.stringify(stepLogs) }, contractorId);

      switch (outcome.kind) {
        case 'cancelled':
          log.info(`Resumed execution ${executionId} was cancelled during resume; status already set by cancel endpoint`);
          return;

        case 'suspended':
          await storage.updateWorkflowExecution(executionId, {
            currentStep: outcome.stepOrder,
            resumeAt: outcome.resumeAt,
            status: 'suspended',
          }, contractorId);
          log.info(`Execution ${executionId} re-suspended until ${outcome.resumeAt.toISOString()}`);
          return;

        case 'failed':
          await this.updateExecutionStatusIfNotCancelled(executionId, contractorId, 'failed', outcome.errorMessages);
          return;

        case 'completed':
          await this.updateExecutionStatusIfNotCancelled(executionId, contractorId, 'completed');
          log.info(`Resumed execution ${executionId} completed`);
          return;
      }
    } catch (error) {
      log.error(`Error resuming suspended execution ${executionId}`, error);
      try {
        await this.updateExecutionStatusIfNotCancelled(executionId, contractorId, 'failed',
          error instanceof Error ? error.message : 'Resume failed');
      } catch (secondaryErr) {
        log.error('Failed to mark execution as failed', secondaryErr);
      }
    }
  }

  /**
   * Start a background poller that resumes suspended executions when their resumeAt time arrives.
   * Uses exponential backoff when idle (no due executions) to avoid unnecessary DB queries.
   * Snaps back to fast mode immediately when a new execution is queued via nudgePoller().
   * Should be called once at server startup.
   */
  startSuspendedPoller(): void {
    this._poller.start();
  }

  /**
   * Run a single suspended-execution poll pass and await all resumes. Used by
   * the worker entrypoint (server/worker.ts) so suspended workflows can be
   * resumed from a Replit Scheduled Deployment instead of an always-on in-app
   * timer. Returns the number of due executions found.
   */
  async runSuspendedPollOnce(): Promise<number> {
    return this._poller.pollOnce();
  }

  /**
   * Nudge the poller to run immediately (resets backoff to minimum).
   * Call this after queuing a new workflow execution so delayed steps are picked up promptly.
   */
  nudgePoller(): void {
    this._poller.nudge();
  }

  /**
   * Stop the suspended-execution poller. Call during graceful shutdown so no
   * new poll cycles are scheduled after the process receives SIGTERM/SIGINT.
   */
  stopSuspendedPoller(): void {
    this._poller.stop();
  }

  /**
   * Recover zombie workflow executions left behind by a previous server crash or restart.
   * Should be called once at server startup.
   *
   * @param staleThresholdMinutes - Executions older than this (default 24 h) are considered stale.
   */
  async recoverZombieExecutions(staleThresholdMinutes = 1440): Promise<void> {
    return recoverZombieExecutions(staleThresholdMinutes);
  }

  /**
   * Schedule suspended executions for estimate_stale workflows when an
   * estimate is created. Each scheduled execution carries a `__staleCheck`
   * marker in its triggerData so resumeSuspendedWorkflow can re-validate the
   * estimate's status before firing the workflow body.
   */
  private async scheduleStaleEstimateExecutions(
    enrichedData: Record<string, unknown>,
    contractorId: string,
  ): Promise<void> {
    const candidateWorkflows = await storage.getActiveApprovedWorkflows(contractorId);
    const stales = candidateWorkflows
      .map(w => ({ w, cfg: w.triggerConfig ? JSON.parse(w.triggerConfig) : {} }))
      .filter(({ cfg }) => cfg?.entity === 'estimate' && cfg?.event === 'stale');
    if (stales.length === 0) return;

    const estimateId = String(enrichedData.id ?? '');
    if (!estimateId) return;

    for (const { w, cfg } of stales) {
      const days = Math.max(1, Number(cfg.staleDays) || 7);
      const resumeAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
      const triggerDataPayload = {
        ...enrichedData,
        __staleCheck: { estimateId, scheduledForDays: days },
      };
      try {
        await storage.createWorkflowExecution({
          workflowId: w.id,
          status: 'suspended',
          triggerData: JSON.stringify(triggerDataPayload),
          resumeAt,
          currentStep: -1,
        }, contractorId);
        log.info(`Scheduled estimate_stale execution for workflow "${w.name}" (estimate ${estimateId}) — resume at ${resumeAt.toISOString()}`);
      } catch (err) {
        log.error(`Failed to schedule stale execution for workflow ${w.id}`, err);
      }
    }
    this.nudgePoller();
  }

  /**
   * Cancel any pending estimate_stale executions whose triggerData references
   * the given estimate. Called when the estimate is approved or rejected.
   */
  private async cancelPendingStaleExecutions(estimateId: string, contractorId: string): Promise<void> {
    if (!estimateId) return;
    const all = await storage.getSuspendedExecutions().catch(() => [] as Awaited<ReturnType<typeof storage.getSuspendedExecutions>>);
    for (const execution of all) {
      if (execution.contractorId !== contractorId) continue;
      try {
        const td = execution.triggerData ? JSON.parse(execution.triggerData) : {};
        if (td?.__staleCheck?.estimateId === estimateId) {
          await storage.updateWorkflowExecution(execution.id, {
            status: 'cancelled',
            completedAt: new Date(),
            errorMessage: 'Estimate was approved or rejected before stale window elapsed',
          }, contractorId);
          log.info(`Cancelled pending stale execution ${execution.id} (estimate ${estimateId} was acted upon)`);
        }
      } catch { /* skip malformed rows */ }
    }
  }

  /**
   * Update execution status in database with tenant isolation.
   */
  private async updateExecutionStatus(
    executionId: string,
    contractorId: string,
    status: 'pending' | 'running' | 'completed' | 'failed' | 'suspended',
    errorMessage?: string
  ): Promise<void> {
    const updates: Record<string, unknown> = {
      status,
      completedAt: status === 'completed' || status === 'failed' ? new Date() : undefined
    };
    if (errorMessage) {
      updates.errorMessage = errorMessage;
    }
    await storage.updateWorkflowExecution(executionId, updates, contractorId);
  }

  /**
   * Update execution status only if the execution has not already been cancelled.
   * This guards against overwriting a 'cancelled' terminal state with 'completed' or 'failed'
   * when a cancellation races with an in-flight execution.
   */
  private async updateExecutionStatusIfNotCancelled(
    executionId: string,
    contractorId: string,
    status: 'completed' | 'failed',
    errorMessage?: string
  ): Promise<void> {
    const current = await storage.getWorkflowExecution(executionId, contractorId);
    if (!current || current.status === 'cancelled') {
      log.info(`Skipping status update to '${status}' for execution ${executionId} — already cancelled`);
      return;
    }
    await this.updateExecutionStatus(executionId, contractorId, status, errorMessage);
  }
}

export const workflowEngine = WorkflowEngine.getInstance();
