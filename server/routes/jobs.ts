import type { Express, Response } from "express";
import { asyncHandler } from "../utils/async-handler";
import { parseBody } from "../utils/validate-body";
import { storage } from "../storage";
import { insertJobSchema, jobsPaginationQuerySchema, jobStatusEnum } from "@shared/schema";
import { requireManagerOrAdmin, type AuthedRequest } from "../auth-service";
import { workflowEngine } from "../workflow-engine";
import { broadcastToContractor } from "../websocket";
import { toWorkflowEvent } from "../utils/workflow/entity-adapter";
import { logger } from "../utils/logger";
import { createActivityAndBroadcast } from "../utils/activity";
import { auditLog } from "../utils/audit-log";
import { z } from "zod";

const log = logger('JobRoutes');

export function registerJobRoutes(app: Express): void {
  // DEPRECATED: unbounded bulk-list capped at 500 rows. No frontend callers remain.
  // New code must use GET /api/jobs/paginated. Retained only for potential external consumers.
  app.get("/api/jobs", asyncHandler(async (req, res) => {
    const jobs = await storage.getJobs(req.user.contractorId);
    res.json(jobs);
  }));

  app.get("/api/jobs/paginated", asyncHandler(async (req: AuthedRequest, res: Response) => {
    // ZodError from .parse() propagates → global ZodError middleware → 400 response
    const validatedQuery = jobsPaginationQuerySchema.parse(req.query);
    const paginatedJobs = await storage.getJobsPaginated(req.user.contractorId, validatedQuery);
    res.json(paginatedJobs);
  }));

  app.get("/api/jobs/:id", asyncHandler(async (req, res) => {
    const job = await storage.getJob(req.params.id, req.user.contractorId);
    if (!job) {
      res.status(404).json({ message: "Job not found" });
      return;
    }
    res.json(job);
  }));

  app.post("/api/jobs", asyncHandler(async (req, res) => {
    const jobData = parseBody(insertJobSchema.omit({ contractorId: true }), req, res);
    if (!jobData) return;
    let job: Awaited<ReturnType<typeof storage.createJob>>;
    try {
      // SAFE: `jobData` was validated by `insertJobSchema.omit({ contractorId: true })`
      // above; `as any` only silences a TypeScript structural mismatch between the
      // validated Zod output type and the storage parameter type. Runtime shape is correct.
      job = await storage.createJob(jobData as any, req.user.contractorId);
    } catch (err) {
      if (err instanceof Error && err.message.includes('Customer not found')) {
        res.status(400).json({ message: err.message });
        return;
      }
      throw err;
    }

    try {
      const contact = await storage.getContact(job.contactId, req.user.contractorId);
      if (contact && !contact.tags?.includes('Customer')) {
        const updatedTags = [...(contact.tags || []), 'Customer'];
        await storage.updateContact(contact.id, { tags: updatedTags }, req.user.contractorId);
        broadcastToContractor(req.user.contractorId, { type: 'contact_updated', contactId: contact.id, contactType: contact.type });
      }
    } catch (tagError) {
      log.error('Failed to add Customer tag during job creation', tagError);
    }

    broadcastToContractor(req.user.contractorId, { type: 'job_created', jobId: job.id });
    workflowEngine.triggerWorkflowsForEvent('job_created', toWorkflowEvent(job), req.user.contractorId).catch(error => {
      log.error('Error triggering workflows for job creation', error);
      auditLog({
        contractorId: req.user.contractorId,
        action: 'workflow.trigger_failure',
        entityType: 'job',
        entityId: job.id,
        after: { event: 'job_created', error: error instanceof Error ? error.message : String(error) },
      }).catch(auditErr => log.error('Failed to write audit log for workflow trigger failure', auditErr));
    });

    res.status(201).json(job);
  }));

  app.patch("/api/jobs/:id/status", asyncHandler(async (req, res) => {
    const { status } = req.body;
    const validStatuses = jobStatusEnum.enumValues;
    if (!status || !validStatuses.includes(status)) {
      res.status(400).json({ message: `Invalid status. Must be one of: ${validStatuses.join(", ")}` });
      return;
    }
    const existingJob = await storage.getJob(req.params.id, req.user.contractorId);
    if (!existingJob) {
      res.status(404).json({ message: "Job not found" });
      return;
    }
    if (existingJob.externalSource === 'housecall-pro') {
      res.status(403).json({
        message: "Cannot edit Housecall Pro jobs - they are read-only for tracking lead value. Status updates are managed in Housecall Pro."
      });
      return;
    }
    const job = await storage.updateJob(req.params.id, { status }, req.user.contractorId);
    if (!job) {
      res.status(404).json({ message: "Job not found" });
      return;
    }
    broadcastToContractor(req.user.contractorId, { type: 'job_updated', jobId: job.id });
    workflowEngine.triggerWorkflowsForEvent('job_updated', toWorkflowEvent(job), req.user.contractorId).catch(error => {
      log.error('Error triggering workflows for job status update', error);
      auditLog({
        contractorId: req.user.contractorId,
        action: 'workflow.trigger_failure',
        entityType: 'job',
        entityId: job.id,
        after: { event: 'job_updated', error: error instanceof Error ? error.message : String(error) },
      }).catch(auditErr => log.error('Failed to write audit log for workflow trigger failure', auditErr));
    });
    workflowEngine.triggerWorkflowsForEvent('job_status_changed', toWorkflowEvent(job), req.user.contractorId).catch(error => {
      log.error('Error triggering workflows for job status change', error);
      auditLog({
        contractorId: req.user.contractorId,
        action: 'workflow.trigger_failure',
        entityType: 'job',
        entityId: job.id,
        after: { event: 'job_status_changed', error: error instanceof Error ? error.message : String(error) },
      }).catch(auditErr => log.error('Failed to write audit log for workflow trigger failure', auditErr));
    });
    res.json(job);
  }));

  app.put("/api/jobs/:id", asyncHandler(async (req, res) => {
    const existingJob = await storage.getJob(req.params.id, req.user.contractorId);
    if (!existingJob) {
      res.status(404).json({ message: "Job not found" });
      return;
    }
    if (existingJob.externalSource === 'housecall-pro') {
      res.status(403).json({
        message: "Cannot edit Housecall Pro jobs - they are read-only for tracking lead value. Status updates are managed in Housecall Pro."
      });
      return;
    }
    // SAFE: `parseBody` returns the validated Zod output; `as any` silences a structural
    // mismatch between the partial Zod inferred type and `UpdateJob`. Runtime shape is
    // correct and passed directly to storage.updateJob which handles partial updates.
    const updateData = parseBody(insertJobSchema.omit({ contractorId: true, contactId: true }).partial(), req, res) as any;
    if (!updateData) return;
    const job = await storage.updateJob(req.params.id, updateData, req.user.contractorId);
    if (!job) {
      res.status(404).json({ message: "Job not found" });
      return;
    }

    broadcastToContractor(req.user.contractorId, { type: 'job_updated', jobId: job.id });
    workflowEngine.triggerWorkflowsForEvent('job_updated', toWorkflowEvent(job), req.user.contractorId).catch(error => {
      log.error('Error triggering workflows for job update', error);
      auditLog({
        contractorId: req.user.contractorId,
        action: 'workflow.trigger_failure',
        entityType: 'job',
        entityId: job.id,
        after: { event: 'job_updated', error: error instanceof Error ? error.message : String(error) },
      }).catch(auditErr => log.error('Failed to write audit log for workflow trigger failure', auditErr));
    });

    if (updateData.status) {
      workflowEngine.triggerWorkflowsForEvent('job_status_changed', toWorkflowEvent(job), req.user.contractorId).catch(error => {
        log.error('Error triggering workflows for job status change', error);
        auditLog({
          contractorId: req.user.contractorId,
          action: 'workflow.trigger_failure',
          entityType: 'job',
          entityId: job.id,
          after: { event: 'job_status_changed', error: error instanceof Error ? error.message : String(error) },
        }).catch(auditErr => log.error('Failed to write audit log for workflow trigger failure', auditErr));
      });
    }

    res.json(job);
  }));

  app.patch("/api/jobs/:id/follow-up", asyncHandler(async (req, res) => {
    const existingJob = await storage.getJob(req.params.id, req.user.contractorId);
    if (!existingJob) {
      res.status(404).json({ message: "Job not found" });
      return;
    }
    const followUpSchema = z.object({
      followUpDate: z.preprocess(
        (val) => {
          if (val === null || val === undefined || val === '') return null;
          const date = new Date(val as string);
          return isNaN(date.getTime()) ? undefined : date;
        },
        z.date().nullable()
      )
    });
    const parsed = parseBody(followUpSchema, req, res);
    if (!parsed) return;
    const { followUpDate } = parsed;
    const job = await storage.updateJob(req.params.id, { followUpDate }, req.user.contractorId);
    if (!job) {
      res.status(404).json({ message: "Job not found" });
      return;
    }

    try {
      const activityContent = followUpDate
        ? `Follow-up date set to ${new Date(followUpDate).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`
        : 'Follow-up date cleared';

      await createActivityAndBroadcast(
        req.user.contractorId,
        { type: 'follow_up', title: 'Follow-up Date Updated', content: activityContent, jobId: req.params.id, userId: req.user.userId },
        { type: 'new_activity', jobId: req.params.id }
      );
    } catch (activityError) {
      log.error('Failed to create activity for job follow-up update', activityError);
    }

    broadcastToContractor(req.user.contractorId, { type: 'job_updated', jobId: job.id });
    res.json(job);
  }));

  // NOTE: double-fetch on DELETE — getJob is called here for the 404 check, and
  // deleteJob internally re-fetches the contactId for orphan cleanup. Consider
  // consolidating into a single storage method if this becomes a performance concern.
  app.delete("/api/jobs/:id", requireManagerOrAdmin, asyncHandler(async (req, res) => {
    const job = await storage.getJob(req.params.id, req.user.contractorId);
    if (!job) {
      res.status(404).json({ message: "Job not found" });
      return;
    }

    const deleted = await storage.deleteJob(req.params.id, req.user.contractorId);
    if (!deleted) {
      res.status(404).json({ message: "Job not found or already deleted" });
      return;
    }

    broadcastToContractor(req.user.contractorId, { type: 'job_deleted', jobId: req.params.id });
    res.status(200).json({ message: "Job deleted successfully" });
  }));
}
