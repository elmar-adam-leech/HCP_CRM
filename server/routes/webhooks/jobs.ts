import type { Express, Request, Response } from "express";
import { z } from "zod";
import { storage } from "../../storage";
import { broadcastToContractor } from "../../websocket";
import { webhookRateLimiter } from "../../middleware/rate-limiter";
import { parseWebhookDate } from "../../utils/parse-webhook-date";
import { asyncHandler } from "../../utils/async-handler";
import { validateWebhookAuth, parseWebhookPayload } from "../../utils/webhook-auth";
import { parseBody } from "../../utils/validate-body";
import { logger } from "../../utils/logger";
import { db } from "../../db";
import { jobs } from "@shared/schema";
import { eq, and, gte } from "drizzle-orm";

const log = logger('WebhookJobs');

const JOB_STATUS_MAP: Record<string, string> = {
  'scheduled': 'scheduled',
  'pending': 'scheduled',
  'in_progress': 'in_progress',
  'in progress': 'in_progress',
  'active': 'in_progress',
  'working': 'in_progress',
  'completed': 'completed',
  'complete': 'completed',
  'done': 'completed',
  'finished': 'completed',
  'cancelled': 'cancelled',
  'canceled': 'cancelled',
};

function normalizeJobStatus(value: unknown): string {
  if (!value) return 'scheduled';
  const val = String(value).toLowerCase().trim();
  return JOB_STATUS_MAP[val] || 'scheduled';
}

const webhookJobSchema = z.object({
  title: z.string().min(1, "title is required"),
  scheduledDate: z.unknown().refine(v => v !== undefined && v !== null && String(v).trim() !== '', {
    message: "scheduledDate is required",
  }),
  customerName: z.string().min(1, "customerName is required"),
  description: z.unknown().optional(),
  status: z.unknown().optional(),
  type: z.unknown().optional(),
  estimateId: z.unknown().optional(),
  amount: z.unknown().optional(),
  customerEmail: z.unknown().optional(),
  customerPhone: z.unknown().optional(),
  customerAddress: z.unknown().optional(),
  notes: z.unknown().optional(),
});

const IDEMPOTENCY_WINDOW_MS = 5 * 60_000;

export function registerJobWebhookRoutes(app: Express): void {
  app.post("/api/webhooks/:contractorId/jobs", webhookRateLimiter, asyncHandler(async (req: Request, res: Response) => {
    try {
      const { contractorId } = req.params;

      const auth = await validateWebhookAuth(req, res, contractorId, 'webhook-job');
      if (!auth) return;
      const { contractor } = auth;

      log.debug('Webhook called');
      // Normalise the raw body before validation: some senders (Zapier, Make) wrap the
      // payload in { data: ... } or send an array. Assign back to req.body so parseBody
      // can validate it without requiring a separate helper function.
      req.body = parseWebhookPayload(req);
      log.debug('Extracted data: ' + JSON.stringify(req.body, null, 2));

      const parsed = parseBody(webhookJobSchema, req, res);
      if (!parsed) return;

      const { title, scheduledDate, description, status, type, estimateId, amount, customerName, customerEmail, customerPhone, customerAddress, notes } = parsed;

      const matchedCustomerId = await storage.findMatchingContact(
        contractorId,
        customerEmail ? [String(customerEmail)] : [],
        customerPhone ? [String(customerPhone)] : []
      );
      const existingCustomer = matchedCustomerId
        ? await storage.getContact(matchedCustomerId, contractorId)
        : undefined;

      let customerId: string;
      if (existingCustomer) {
        customerId = existingCustomer.id;
        log.info(`Using existing customer: ${customerId}`);
      } else {
        const newCustomer = await storage.createContact({
          name: String(customerName).trim(),
          type: 'customer' as const,
          emails: customerEmail ? [String(customerEmail).trim()] : [],
          phones: customerPhone ? [String(customerPhone).trim()] : [],
          address: customerAddress ? String(customerAddress).trim() : undefined,
        }, contractorId);
        customerId = newCustomer.id;
        log.info(`Created new customer: ${customerId}`);
      }

      const parsedScheduledDate = parseWebhookDate(scheduledDate);
      if (!parsedScheduledDate) {
        res.status(400).json({
          error: "Invalid scheduled date",
          message: "The scheduledDate must be a valid date",
        });
        return;
      }

      const duplicateWindow = new Date(Date.now() - IDEMPOTENCY_WINDOW_MS);
      const duplicateResults = await db.select({ id: jobs.id, title: jobs.title, scheduledDate: jobs.scheduledDate, status: jobs.status, createdAt: jobs.createdAt, contactId: jobs.contactId })
        .from(jobs)
        .where(and(
          eq(jobs.contractorId, contractorId),
          eq(jobs.contactId, customerId),
          eq(jobs.title, String(title).trim()),
          eq(jobs.scheduledDate, parsedScheduledDate),
          gte(jobs.createdAt, duplicateWindow)
        ))
        .limit(1);
      const duplicate = duplicateResults[0];
      if (duplicate) {
        log.info(`Idempotency guard: returning existing job ${duplicate.id}`);
        res.status(200).json({
          success: true,
          message: "Job already exists (duplicate detected)",
          jobId: duplicate.id,
          customerId,
          job: {
            id: duplicate.id,
            title: duplicate.title,
            scheduledDate: duplicate.scheduledDate,
            status: duplicate.status,
            customerId,
            createdAt: duplicate.createdAt,
          },
        });
        return;
      }

      const jobData: Omit<import("@shared/schema").InsertJob, 'contractorId'> = {
        title: String(title).trim(),
        type: type ? String(type).trim() : 'service',
        scheduledDate: parsedScheduledDate,
        status: normalizeJobStatus(status) as "scheduled" | "in_progress" | "completed" | "cancelled",
        contactId: customerId,
        estimateId: (estimateId && String(estimateId).toLowerCase() !== 'none') ? String(estimateId) : null,
        value: amount ? (typeof amount === 'string' ? parseFloat(amount) : Number(amount)).toString() : '0',
        notes: notes ? String(notes).trim() : (description ? String(description).trim() : null),
      };

      log.debug('Creating job with data: ' + JSON.stringify(jobData));

      const newJob = await storage.createJob(jobData, contractorId);

      log.info(`Job created for contractor ${contractor.name}: ${newJob.title}`);

      broadcastToContractor(contractorId, {
        type: 'new_job',
        job: newJob,
      });

      res.status(201).json({
        success: true,
        message: "Job created successfully",
        jobId: newJob.id,
        customerId,
        job: {
          id: newJob.id,
          title: newJob.title,
          scheduledDate: newJob.scheduledDate,
          status: newJob.status,
          customerId,
          createdAt: newJob.createdAt,
        },
      });

    } catch (error) {
      log.error('Processing error:', error);
      res.status(500).json({
        error: "Internal server error",
        message: "Failed to process job webhook",
      });
    }
  }));
}
