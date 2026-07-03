import type { Express, Response } from "express";
import { storage } from "../../storage";
import {
  type AuthedRequest,
  requireAuth,
  requireIntegrationAccess,
} from "../../auth-service";
import { asyncHandler } from "../../utils/async-handler";
import { logger } from "../../utils/logger";
import { syncTwilioNumbers } from "../../twilio/numbers";
import { configureTwilioWebhooks, inspectTwilioInboundRouting } from "../../twilio/webhook-config";
import { fetchTwilioRecording } from "../../twilio/recordings";
import { isIntegrationEnabledCached } from "../../services/cache";
import { twilioRingTreeSchema } from "@shared/schema";

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
    requireIntegrationAccess('twilio'),
    asyncHandler(async (req: AuthedRequest, res: Response) => {
      const sync = await syncTwilioNumbers(req.user.contractorId);
      let configured = 0;
      let messagingServicesConfigured = 0;
      let inboundRouting:
        | Awaited<ReturnType<typeof configureTwilioWebhooks>>["inboundRouting"]
        | undefined;
      let webhookError: string | undefined;
      try {
        const result = await configureTwilioWebhooks(req.user.contractorId);
        configured = result.configured;
        messagingServicesConfigured = result.messagingServicesConfigured;
        inboundRouting = result.inboundRouting;
      } catch (error) {
        webhookError = error instanceof Error ? error.message : "Unknown error";
        log.error("Failed to configure Twilio webhooks during sync:", error);
      }
      res.json({ synced: sync.synced, configured, messagingServicesConfigured, inboundRouting, webhookError });
    }),
  );

  // Read-only diagnostic: inspect live inbound SMS routing for this contractor's
  // numbers and any Messaging Service that owns them, without changing anything.
  app.get(
    "/api/twilio/inbound-routing",
    requireIntegrationAccess('twilio'),
    asyncHandler(async (req: AuthedRequest, res: Response) => {
      try {
        const status = await inspectTwilioInboundRouting(req.user.contractorId);
        res.json(status);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        log.error("Failed to inspect Twilio inbound routing:", error);
        res.status(502).json({
          ok: false,
          numbers: [],
          messagingServices: [],
          warnings: [`Could not check inbound SMS routing: ${message}`],
        });
      }
    }),
  );

  // Contractor-level Twilio settings (admin/manager only)
  app.get(
    "/api/twilio/settings",
    requireIntegrationAccess('twilio'),
    asyncHandler(async (req: AuthedRequest, res: Response) => {
      const contractor = await storage.getContractor(req.user.contractorId);
      res.json({
        defaultTwilioNumber: contractor?.defaultTwilioNumber ?? null,
        twilioRecordCalls: contractor?.twilioRecordCalls ?? false,
        twilioInboundCallMode: contractor?.twilioInboundCallMode ?? "crm",
        twilioRingTree: contractor?.twilioRingTree ?? null,
      });
    }),
  );

  app.patch(
    "/api/twilio/settings",
    requireIntegrationAccess('twilio'),
    asyncHandler(async (req: AuthedRequest, res: Response) => {
      const { defaultTwilioNumber, twilioRecordCalls, twilioInboundCallMode, twilioRingTree } = req.body ?? {};
      const updates: Record<string, unknown> = {};
      if (defaultTwilioNumber !== undefined) {
        updates.defaultTwilioNumber = defaultTwilioNumber || null;
      }
      if (twilioRecordCalls !== undefined) {
        updates.twilioRecordCalls = Boolean(twilioRecordCalls);
      }
      if (twilioInboundCallMode !== undefined) {
        if (twilioInboundCallMode !== "crm" && twilioInboundCallMode !== "external") {
          res.status(400).json({ message: "twilioInboundCallMode must be 'crm' or 'external'" });
          return;
        }
        updates.twilioInboundCallMode = twilioInboundCallMode;
      }
      if (twilioRingTree !== undefined) {
        if (twilioRingTree === null) {
          updates.twilioRingTree = null; // clear → default behavior
        } else {
          const parsed = twilioRingTreeSchema.safeParse(twilioRingTree);
          if (!parsed.success) {
            const issue = parsed.error.issues[0];
            res.status(400).json({
              message: `Invalid ring order: ${issue?.message ?? "invalid format"}`,
            });
            return;
          }
          updates.twilioRingTree = parsed.data;
        }
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
        twilioInboundCallMode: contractor?.twilioInboundCallMode ?? "crm",
        twilioRingTree: contractor?.twilioRingTree ?? null,
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
