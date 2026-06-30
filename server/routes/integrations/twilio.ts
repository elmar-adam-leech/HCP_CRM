import type { Express, Response } from "express";
import { storage } from "../../storage";
import {
  type AuthedRequest,
  requireAuth,
  requireIntegrationManager,
} from "../../auth-service";
import { asyncHandler } from "../../utils/async-handler";
import { logger } from "../../utils/logger";
import { syncTwilioNumbers } from "../../twilio/numbers";
import { configureTwilioWebhooks } from "../../twilio/webhook-config";
import { fetchTwilioRecording } from "../../twilio/recordings";
import { isIntegrationEnabledCached } from "../../services/cache";

const log = logger("TwilioRoutes");

export function registerTwilioRoutes(app: Express): void {
  // List synced Twilio numbers for the active contractor
  app.get(
    "/api/twilio/numbers",
    requireAuth,
    asyncHandler(async (req: AuthedRequest, res: Response) => {
      const numbers = await storage.getTwilioPhoneNumbers(req.user.contractorId);
      res.json({ numbers });
    }),
  );

  // Re-sync numbers from Twilio and (re)configure webhooks for each
  app.post(
    "/api/twilio/sync",
    requireIntegrationManager,
    asyncHandler(async (req: AuthedRequest, res: Response) => {
      const sync = await syncTwilioNumbers(req.user.contractorId);
      let configured = 0;
      let messagingServicesConfigured = 0;
      let webhookError: string | undefined;
      try {
        const result = await configureTwilioWebhooks(req.user.contractorId);
        configured = result.configured;
        messagingServicesConfigured = result.messagingServicesConfigured;
      } catch (error) {
        webhookError = error instanceof Error ? error.message : "Unknown error";
        log.error("Failed to configure Twilio webhooks during sync:", error);
      }
      res.json({ synced: sync.synced, configured, messagingServicesConfigured, webhookError });
    }),
  );

  // Contractor-level Twilio settings (admin/manager only)
  app.get(
    "/api/twilio/settings",
    requireIntegrationManager,
    asyncHandler(async (req: AuthedRequest, res: Response) => {
      const contractor = await storage.getContractor(req.user.contractorId);
      res.json({
        defaultTwilioNumber: contractor?.defaultTwilioNumber ?? null,
        twilioRecordCalls: contractor?.twilioRecordCalls ?? false,
      });
    }),
  );

  app.patch(
    "/api/twilio/settings",
    requireIntegrationManager,
    asyncHandler(async (req: AuthedRequest, res: Response) => {
      const { defaultTwilioNumber, twilioRecordCalls } = req.body ?? {};
      const updates: Record<string, unknown> = {};
      if (defaultTwilioNumber !== undefined) {
        updates.defaultTwilioNumber = defaultTwilioNumber || null;
      }
      if (twilioRecordCalls !== undefined) {
        updates.twilioRecordCalls = Boolean(twilioRecordCalls);
      }
      if (Object.keys(updates).length === 0) {
        res.status(400).json({ message: "No valid settings provided" });
        return;
      }
      const contractor = await storage.updateContractor(
        req.user.contractorId,
        updates as never,
      );
      res.json({
        defaultTwilioNumber: contractor?.defaultTwilioNumber ?? null,
        twilioRecordCalls: contractor?.twilioRecordCalls ?? false,
      });
    }),
  );

  // Per-user Twilio defaults (the number the bridge call rings for this rep)
  app.patch(
    "/api/twilio/my-phone",
    requireAuth,
    asyncHandler(async (req: AuthedRequest, res: Response) => {
      const { twilioDefaultNumber, twilioPhoneToRing } = req.body ?? {};
      const updates: Record<string, unknown> = {};
      if (twilioDefaultNumber !== undefined) {
        updates.twilioDefaultNumber = twilioDefaultNumber || null;
      }
      if (twilioPhoneToRing !== undefined) {
        updates.twilioPhoneToRing = twilioPhoneToRing || null;
      }
      if (Object.keys(updates).length === 0) {
        res.status(400).json({ message: "No valid settings provided" });
        return;
      }
      const updated = await storage.updateUserContractor(
        req.user.userId,
        req.user.contractorId,
        updates as never,
      );
      res.json({
        twilioDefaultNumber: updated?.twilioDefaultNumber ?? null,
        twilioPhoneToRing: updated?.twilioPhoneToRing ?? null,
      });
    }),
  );

  // Authenticated recording proxy — streams the .mp3 from Twilio (consent-gated upstream)
  app.get(
    "/api/twilio/recordings/:recordingSid",
    requireAuth,
    asyncHandler(async (req: AuthedRequest, res: Response) => {
      const { recordingSid } = req.params;
      if (!/^RE[a-zA-Z0-9]+$/.test(recordingSid)) {
        res.status(400).json({ message: "Invalid recording id" });
        return;
      }

      // Mirror the Dialpad recording proxy: only stream when the Twilio
      // integration is enabled for this contractor.
      const isIntegrationEnabled = await isIntegrationEnabledCached(req.user.contractorId, 'twilio');
      if (!isIntegrationEnabled) {
        res.status(403).json({
          message: "Twilio integration is not enabled.",
          integrationDisabled: true,
        });
        return;
      }

      let fetchRes: Awaited<ReturnType<typeof fetchTwilioRecording>>;
      try {
        fetchRes = await fetchTwilioRecording(
          req.user.contractorId,
          recordingSid,
        );
      } catch (error) {
        log.error("Failed to fetch Twilio recording:", error);
        res.status(502).json({ message: "Failed to fetch recording" });
        return;
      }
      if (!fetchRes.ok || !fetchRes.body) {
        res.status(fetchRes.status || 502).json({ message: "Recording unavailable" });
        return;
      }
      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("Cache-Control", "private, max-age=300");
      const reader = fetchRes.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) res.write(Buffer.from(value));
        }
        res.end();
      } catch (error) {
        log.error("Error streaming Twilio recording:", error);
        if (!res.headersSent) res.status(502).end();
        else res.end();
      }
    }),
  );
}
