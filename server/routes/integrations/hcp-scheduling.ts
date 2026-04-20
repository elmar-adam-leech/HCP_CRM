import type { Express, Response } from "express";
import { storage } from "../../storage";
import { userContractors, type Contractor } from "@shared/schema";
import { db } from "../../db";
import { eq, and } from "drizzle-orm";
import { requireManagerOrAdmin, requireAdmin, type AuthedRequest } from "../../auth-service";
type AuthenticatedRequest = AuthedRequest;
import { CredentialService } from "../../credential-service";
import { asyncHandler } from "../../utils/async-handler";
import { logger } from "../../utils/logger";
import { createActivityAndBroadcast } from "../../utils/activity";
import { housecallSchedulingService } from "../../housecall-scheduling-service";
import { getWebhookHealthStatus, getWebhookStatus } from "../../services/hcp-webhook-health";
import crypto from "crypto";

const log = logger('HcpScheduling');

export function registerHcpSchedulingRoutes(app: Express): void {
  app.post("/api/scheduling/sync-users", requireAdmin, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const result = await housecallSchedulingService.syncHousecallUsers(req.user.contractorId);
    res.json(result);
  }));

  app.get("/api/scheduling/salespeople", asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const teamMembers = await housecallSchedulingService.getTeamMembers(req.user.contractorId);
    res.json(teamMembers);
  }));

  app.get("/api/scheduling/availability", asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { startDate, endDate, days, salespersonId } = req.query;

    let start: Date;
    let end: Date;

    if (startDate && endDate) {
      start = new Date(startDate as string);
      end = new Date(endDate as string);
    } else {
      start = new Date();
      const daysToFetch = days ? parseInt(days as string) : 14;
      end = new Date();
      end.setDate(end.getDate() + daysToFetch);
    }

    const contractor = await storage.getContractor(req.user.contractorId) as Contractor | null;
    const timezone = contractor?.timezone || 'America/New_York';

    const slots = await housecallSchedulingService.getUnifiedAvailability(req.user.contractorId, start, end, timezone);

    // Optionally filter by a specific salesperson
    const filterSalespersonId = salespersonId as string | undefined;

    const filteredSlots = filterSalespersonId
      ? slots.filter(slot => slot.availableSalespersonIds.includes(filterSalespersonId))
      : slots.filter(slot => slot.availableSalespersonIds.length > 0);

    res.json({
      startDate: start.toISOString(),
      endDate: end.toISOString(),
      slotDurationMinutes: 60,
      bufferMinutes: 30,
      slots: filteredSlots.map(slot => ({
        start: slot.start.toISOString(),
        end: slot.end.toISOString(),
        availableCount: slot.availableSalespersonIds.length,
        availableSalespersonIds: slot.availableSalespersonIds,
      }))
    });
  }));

  app.post("/api/scheduling/book", asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { startTime, title, customerName, customerEmail, customerPhone, customerAddress, customerAddressComponents, notes, contactId, salespersonId, housecallProEmployeeId, timeZone } = req.body;

    if (!startTime || !title || !customerName) {
      res.status(400).json({ message: "startTime, title, and customerName are required" });
      return;
    }

    const result = await housecallSchedulingService.bookAppointment(req.user.contractorId, {
      startTime: new Date(startTime),
      title,
      customerName,
      customerEmail,
      customerPhone,
      customerAddress,
      customerAddressComponents,
      notes,
      contactId,
      salespersonId,
      housecallProEmployeeId,
      bookingPayload: req.body as Record<string, unknown>,
    });

    if (result.success) {
      // Log booking to activity feed if we have a contactId
      if (contactId) {
        const appointmentStart = new Date(startTime);
        const tz = typeof timeZone === 'string' && timeZone ? timeZone : 'UTC';
        const tzOptions = { timeZone: tz };
        const formattedDate = appointmentStart.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', ...tzOptions });
        const formattedTime = appointmentStart.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, ...tzOptions })
          + (timeZone ? '' : ' UTC');
        const addressForActivity = customerAddress || customerAddressComponents?.street || '';
        createActivityAndBroadcast(
          req.user.contractorId,
          {
            type: 'meeting',
            contactId,
            content: `Appointment booked for ${formattedDate} at ${formattedTime}${addressForActivity ? ` — ${addressForActivity}` : ''}`,
          },
          { type: 'activity_created', contactId }
        ).catch(err => log.error('Failed to log booking activity (non-fatal):', err));
      }
      res.status(201).json(result);
    } else {
      res.status(400).json({ message: result.error });
    }
  }));

  app.get("/api/scheduling/bookings", asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { startDate, endDate } = req.query;

    const bookings = await housecallSchedulingService.getBookings(
      req.user.contractorId,
      startDate ? new Date(startDate as string) : undefined,
      endDate ? new Date(endDate as string) : undefined
    );

    res.json(bookings);
  }));

  app.delete("/api/scheduling/bookings/:bookingId", asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { bookingId } = req.params;
    const cancelled = await housecallSchedulingService.cancelBooking(req.user.contractorId, bookingId);
    if (!cancelled) {
      res.status(404).json({ message: "Booking not found" });
      return;
    }
    res.json({ message: "Booking cancelled" });
  }));

  app.patch("/api/scheduling/salespeople/order", requireAdmin, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { order } = req.body;
    if (!Array.isArray(order) || order.length === 0) {
      res.status(400).json({ message: "order must be a non-empty array of user IDs" });
      return;
    }

    if (!order.every((id: unknown) => typeof id === 'string' && id.length > 0)) {
      res.status(400).json({ message: "Every item in order must be a non-empty string user ID" });
      return;
    }

    const uniqueIds = new Set(order);
    if (uniqueIds.size !== order.length) {
      res.status(400).json({ message: "Duplicate user IDs are not allowed" });
      return;
    }

    await db.transaction(async (tx) => {
      for (let i = 0; i < order.length; i++) {
        await tx.update(userContractors)
          .set({ displayOrder: i })
          .where(and(
            eq(userContractors.userId, order[i]),
            eq(userContractors.contractorId, req.user.contractorId)
          ));
      }
    });

    res.json({ message: "Salesperson order updated successfully" });
  }));

  app.patch("/api/scheduling/salespeople/:userId", requireAdmin, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { userId } = req.params;
    const { isSalesperson, calendarColor, workingDays, workingHoursStart, workingHoursEnd, hasCustomSchedule } = req.body;

    const updateData: any = {};

    if (isSalesperson !== undefined) updateData.isSalesperson = isSalesperson;
    if (calendarColor !== undefined) updateData.calendarColor = calendarColor;
    if (workingDays !== undefined) updateData.workingDays = workingDays;
    if (workingHoursStart !== undefined) updateData.workingHoursStart = workingHoursStart;
    if (workingHoursEnd !== undefined) updateData.workingHoursEnd = workingHoursEnd;
    if (hasCustomSchedule !== undefined) updateData.hasCustomSchedule = hasCustomSchedule;

    await db.update(userContractors)
      .set(updateData)
      .where(and(
        eq(userContractors.userId, userId),
        eq(userContractors.contractorId, req.user.contractorId)
      ));

    res.json({ message: "Salesperson updated successfully" });
  }));

  app.get("/api/integrations/housecall-pro/webhook-config", asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const contractorId = req.user.contractorId;
    let baseWebhookUrl: string;
    if (process.env.APP_URL) {
      const appUrl = process.env.APP_URL.replace(/\/+$/, '');
      baseWebhookUrl = `${appUrl}/api/webhooks/${contractorId}/housecall-pro`;
    } else {
      const protocol = (req.headers['x-forwarded-proto'] as string) || req.protocol;
      const host = (req.headers['x-forwarded-host'] as string) || req.get('host');
      baseWebhookUrl = `${protocol}://${host}/api/webhooks/${contractorId}/housecall-pro`;
    }

    // Check whether a URL token record exists in storage (without decrypting yet)
    const rawCredential = await storage.getContractorCredential(contractorId, 'housecallpro', 'webhook_url_token');
    const tokenRecordExists = !!(rawCredential && rawCredential.isActive);

    let urlToken: string;
    let tokenStatus: 'valid' | 'missing' | 'read_error';

    if (!tokenRecordExists) {
      // First-time setup only: generate and store a new token
      urlToken = crypto.randomBytes(32).toString('hex');
      await CredentialService.setCredential(contractorId, 'housecallpro', 'webhook_url_token', urlToken);
      tokenStatus = 'valid';
      log.info(`Generated new webhook URL token for contractor ${contractorId}`);
    } else {
      // Token record exists — attempt to decrypt it
      try {
        const decrypted = await CredentialService.getCredential(contractorId, 'housecallpro', 'webhook_url_token');
        if (!decrypted) {
          // getCredential returned null despite record existing — decryption silently failed
          log.error(`webhook_url_token exists for contractor ${contractorId} but could not be decrypted (returned null)`);
          res.status(500).json({ error: 'read_error', message: 'Error reading webhook token — check server logs or contact support.' });
          return;
        }
        urlToken = decrypted;
        tokenStatus = 'valid';
      } catch (err) {
        log.error(`webhook_url_token decryption error for contractor ${contractorId}:`, err);
        res.status(500).json({ error: 'read_error', message: 'Error reading webhook token — check server logs or contact support.' });
        return;
      }
    }

    const webhookUrl = `${baseWebhookUrl}?token=${urlToken}`;

    let secretConfigured = false;
    try {
      const secret = await CredentialService.getCredential(contractorId, 'housecallpro', 'webhook_secret');
      secretConfigured = !!(secret && secret.trim());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('not found') && !msg.includes('No rows') && !msg.includes('no result')) {
        log.warn('Unexpected error fetching webhook secret:', msg);
      }
    }

    res.json({ webhookUrl, tokenStatus, secretConfigured });
  }));

  app.post("/api/integrations/housecall-pro/webhook-token/regenerate", requireManagerOrAdmin, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const contractorId = req.user.contractorId;
    const userId = req.user.userId;

    let baseWebhookUrl: string;
    if (process.env.APP_URL) {
      const appUrl = process.env.APP_URL.replace(/\/+$/, '');
      baseWebhookUrl = `${appUrl}/api/webhooks/${contractorId}/housecall-pro`;
    } else {
      const protocol = (req.headers['x-forwarded-proto'] as string) || req.protocol;
      const host = (req.headers['x-forwarded-host'] as string) || req.get('host');
      baseWebhookUrl = `${protocol}://${host}/api/webhooks/${contractorId}/housecall-pro`;
    }

    const newToken = crypto.randomBytes(32).toString('hex');
    await CredentialService.setCredential(contractorId, 'housecallpro', 'webhook_url_token', newToken);
    log.warn(`Webhook URL token regenerated for contractor ${contractorId} by user ${userId}`);

    const webhookUrl = `${baseWebhookUrl}?token=${newToken}`;
    res.json({
      webhookUrl,
      tokenStatus: 'valid' as const,
      warning: 'You must update this URL in Housecall Pro > My Apps > Webhooks immediately, or events will stop arriving.',
    });
  }));

  app.post("/api/integrations/housecall-pro/webhook-secret", requireManagerOrAdmin, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { secret } = req.body;
    if (!secret || typeof secret !== 'string' || !secret.trim()) {
      res.status(400).json({ error: 'Secret is required' });
      return;
    }
    await CredentialService.setCredential(req.user.contractorId, 'housecallpro', 'webhook_secret', secret.trim());
    res.json({ success: true });
  }));

  app.delete("/api/integrations/housecall-pro/webhook-secret", requireManagerOrAdmin, asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    await CredentialService.disableCredential(req.user.contractorId, 'housecallpro', 'webhook_secret');
    res.json({ success: true });
  }));

  app.get("/api/integrations/housecall-pro/webhook-health", asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const status = await getWebhookHealthStatus(req.user.contractorId);
    res.json(status);
  }));

  app.get("/api/integrations/housecall-pro/webhook-status", asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
    const status = await getWebhookStatus(req.user.contractorId);
    res.json(status);
  }));
}
