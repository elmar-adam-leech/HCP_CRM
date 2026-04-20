import type { Express, Request, Response } from "express";
import { z } from "zod";
import { storage } from "../../storage";
import { broadcastToContractor } from "../../websocket";
import { webhookRateLimiter } from "../../middleware/rate-limiter";
import { normalizePhoneForStorage } from "../../utils/phone-normalizer";
import { parseWebhookDate } from "../../utils/parse-webhook-date";
import { asyncHandler } from "../../utils/async-handler";
import { validateWebhookAuth, parseWebhookPayload } from "../../utils/webhook-auth";
import { parseBody } from "../../utils/validate-body";

import { logger } from '../../utils/logger';

const log = logger('EstimateWebhook');

const webhookEstimateSchema = z.object({
  title: z.string().min(1, "title is required"),
  amount: z.union([z.string(), z.number()])
    .transform(v => (typeof v === 'string' ? parseFloat(v) : v))
    .refine(n => !isNaN(n) && n >= 0, { message: "amount must be a valid non-negative number" }),
  customerName: z.string().min(1, "customerName is required"),
  description: z.string().optional(),
  status: z.string().optional(),
  validUntil: z.unknown().optional(),
  followUpDate: z.unknown().optional(),
  customerEmail: z.string().optional(),
  customerPhone: z.unknown().optional(),
  customerAddress: z.string().optional(),
});

export function registerEstimateWebhookRoutes(app: Express): void {
  app.post("/api/webhooks/:contractorId/estimates", webhookRateLimiter, asyncHandler(async (req: Request, res: Response) => {
    log.info('[webhook-estimate] === WEBHOOK CALLED ===');
    try {
      const { contractorId } = req.params;

      const auth = await validateWebhookAuth(req, res, contractorId, 'webhook-estimate');
      if (!auth) return;
      const { contractor } = auth;

      // Normalise the raw body before validation: some senders (Zapier, Make) wrap the
      // payload in { data: ... } or send an array. Assign back to req.body so parseBody
      // can validate it without requiring a separate helper function.
      req.body = parseWebhookPayload(req);
      log.info('[webhook-estimate] Extracted data:', JSON.stringify(req.body, null, 2));

      const parsed = parseBody(webhookEstimateSchema, req, res);
      if (!parsed) return;

      const { title, amount: amountNum, description, status, validUntil, followUpDate, customerEmail, customerPhone, customerAddress, customerName } = parsed;
      const normalizedPhone = customerPhone != null ? normalizePhoneForStorage(String(customerPhone).trim()) : null;

      const matchedCustomerId = await storage.findMatchingContact(
        contractorId,
        customerEmail ? [customerEmail] : [],
        normalizedPhone ? [normalizedPhone] : []
      );
      const existingCustomer = matchedCustomerId
        ? await storage.getContact(matchedCustomerId, contractorId)
        : undefined;

      let customerId: string;
      if (existingCustomer) {
        customerId = existingCustomer.id;
        log.info('[webhook-estimate] Using existing customer:', customerId);
      } else {
        const newCustomer = await storage.createContact({
          name: String(customerName).trim(),
          type: 'customer' as const,
          emails: customerEmail ? [String(customerEmail).trim()] : [],
          phones: normalizedPhone ? [normalizedPhone] : [],
          address: customerAddress ? String(customerAddress).trim() : undefined,
        }, contractorId);
        customerId = newCustomer.id;
        log.info('[webhook-estimate] Created new customer:', customerId);
      }

      const normalizeStatus = (value: unknown): string => {
        if (!value) return 'scheduled';
        const val = String(value).toLowerCase().trim();
        const statusMap: Record<string, string> = {
          'open': 'scheduled',
          'draft': 'scheduled',
          'pending': 'scheduled',
          'sent': 'sent',
          'scheduled': 'scheduled',
          'in_progress': 'in_progress',
          'approved': 'approved',
          'accepted': 'approved',
          'rejected': 'rejected',
          'declined': 'rejected'
        };
        return statusMap[val] || 'scheduled';
      };

      const normalizedStatus = normalizeStatus(status) as "sent" | "scheduled" | "in_progress" | "approved" | "rejected";

      const estimateData = {
        title: String(title).trim(),
        amount: amountNum.toString(),
        description: description ? String(description).trim() : null,
        status: normalizedStatus,
        validUntil: parseWebhookDate(validUntil),
        followUpDate: parseWebhookDate(followUpDate),
        contactId: customerId,
      };

      log.info('[webhook-estimate] Creating estimate with data:', estimateData);

      const newEstimate = await storage.createEstimate(estimateData, contractorId);

      log.info(`[webhook-estimate] ✓ Estimate created successfully for contractor ${contractor.name}:`, newEstimate.title);

      broadcastToContractor(contractorId, {
        type: 'new_estimate',
        estimate: newEstimate,
      });

      res.status(201).json({
        success: true,
        message: "Estimate created successfully",
        estimateId: newEstimate.id,
        customerId: customerId,
        estimate: {
          id: newEstimate.id,
          title: newEstimate.title,
          amount: newEstimate.amount,
          status: newEstimate.status,
          customerId: customerId,
          createdAt: newEstimate.createdAt
        }
      });

    } catch (error) {
      log.error('[webhook-estimate] Processing error:', error);
      res.status(500).json({
        error: "Internal server error",
        message: "Failed to process estimate webhook"
      });
    }
  }));
}
