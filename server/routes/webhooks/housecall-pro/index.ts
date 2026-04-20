import type { Express, Request, Response } from "express";
import { db } from "../../../db";
import { webhookEvents } from "@shared/schema";
import { getContractorCached } from "../../../services/cache";
import { webhookRateLimiter } from "../../../middleware/rate-limiter";
import { asyncHandler } from "../../../utils/async-handler";
import { logger } from "../../../utils/logger";
import { verifyHcpWebhookAuth } from "./auth";
import { normalizeHcpPayload, isHcpVerificationPing } from "./normalize";
import { processHcpEvent } from "./dispatch";

const log = logger('HCPWebhook');

export function registerHousecallProWebhookRoutes(app: Express): void {
  app.get("/api/webhooks/:contractorId/housecall-pro", (_req: Request, res: Response) => {
    res.status(200).json({ status: "ok" });
  });

  app.post("/api/webhooks/:contractorId/housecall-pro",
    webhookRateLimiter,
    asyncHandler(async (req: Request, res: Response) => {
      const { contractorId } = req.params;

      const contractor = await getContractorCached(contractorId);
      if (!contractor) {
        log.error('Invalid contractor ID in webhook', { contractorId });
        db.insert(webhookEvents).values({
          contractorId: null,
          service: 'housecall-pro',
          eventType: 'rejection',
          payload: JSON.stringify({ contractorId }),
          processed: false,
          errorMessage: 'invalid_contractor',
        }).catch(err => log.error('Failed to log rejection event', err));
        res.status(404).json({ message: "Contractor not found" });
        return;
      }

      let parsedBody: any;
      try {
        parsedBody = Buffer.isBuffer(req.body)
          ? JSON.parse((req.body as Buffer).toString('utf8'))
          : req.body;
      } catch (parseErr) {
        log.error('Failed to parse webhook payload JSON', { contractorId, error: parseErr });
        res.status(200).json({ received: true });
        return;
      }

      // Pre-auth: HouseCall Pro fires an unauthenticated probe (`{"foo":"bar"}`)
      // when the user clicks Save in the webhook configuration UI. 200 it
      // before the HMAC / URL-token chain runs so the UI can save the URL.
      // Real events (carrying event_type / event / lead / customer / etc.)
      // continue to flow through the existing auth chain unchanged.
      if (isHcpVerificationPing(parsedBody)) {
        log.info('Received HCP webhook verification ping (no event fields) — accepting without auth', {
          contractorId,
          body: JSON.stringify(parsedBody),
        });
        db.insert(webhookEvents).values({
          contractorId,
          service: 'housecall-pro',
          eventType: 'hcp.verification_ping',
          payload: JSON.stringify(parsedBody),
          processed: true,
          processedAt: new Date(),
        }).catch(err => log.error('Failed to log hcp.verification_ping event', err));
        res.status(200).json({ received: true });
        return;
      }

      log.info('[HCPWebhook] Raw payload received', {
        contractorId,
        headers: {
          'x-housecall-signature': req.headers['x-housecall-signature'],
          'x-housecall-pro-signature': req.headers['x-housecall-pro-signature'],
          'content-type': req.headers['content-type'],
        },
        body: JSON.stringify(parsedBody),
      });

      const auth = await verifyHcpWebhookAuth(req, contractorId);
      if (!auth.ok) {
        res.status(auth.rejectStatus ?? 401).json({ message: auth.rejectMessage ?? 'Unauthorized' });
        return;
      }

      const { event_type, data, occurredAt } = normalizeHcpPayload(parsedBody);

      if (!event_type) {
        log.info(`Received test/ping payload (no event) for contractor: ${contractorId}`);
        res.status(200).json({ received: true });
        return;
      }

      log.info(`Received event: ${event_type} for contractor: ${contractorId}`);

      res.status(200).json({ received: true });

      const payloadJson = JSON.stringify(parsedBody);
      setImmediate(() => {
        (async () => {
          let webhookEventId: string | undefined;
          try {
            const webhookEventRecord = await db.insert(webhookEvents).values({
              contractorId,
              service: 'housecall-pro',
              eventType: event_type,
              payload: payloadJson,
              processed: false,
            }).returning();
            webhookEventId = webhookEventRecord[0]?.id;
          } catch (err) {
            log.error(`Failed to persist webhook event record for ${event_type}`, err);
          }

          try {
            await processHcpEvent(contractorId, event_type, data, webhookEventId, occurredAt);
          } catch (err) {
            log.error(`Background processing error for ${event_type} (contractor ${contractorId})`, err);
          }
        })();
      });
    }));
}
