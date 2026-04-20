import type { Express } from "express";
import { asyncHandler } from "../utils/async-handler";
import { storage } from "../storage";
import { gmailService } from "../gmail-service";
import { requireManagerOrAdmin } from "../auth-service";
import { syncLeadCaptureInbox } from "../services/lead-capture-sync";
import { syncScheduler } from "../sync-scheduler";
import { z } from "zod";
import { senderRuleSchema } from "@shared/schema";
import { parseBody } from "../utils/validate-body";
import { logger } from "../utils/logger";
import { ingestLead } from "../services/lead-ingestion";

const log = logger('LeadCaptureRoutes');

export function registerLeadCaptureRoutes(app: Express): void {
  app.get("/api/settings/lead-capture-inbox", requireManagerOrAdmin, asyncHandler(async (req, res) => {
    const inbox = await storage.getLeadCaptureInbox(req.user.contractorId);
    if (!inbox) {
      res.json(null);
      return;
    }
    res.json({
      id: inbox.id,
      emailAddress: inbox.emailAddress,
      lastSyncAt: inbox.lastSyncAt,
      spamFilterEnabled: inbox.spamFilterEnabled,
      spamConfidenceThreshold: inbox.spamConfidenceThreshold,
      senderRules: inbox.senderRules || [],
      isActive: inbox.isActive,
      createdAt: inbox.createdAt,
    });
  }));

  app.delete("/api/settings/lead-capture-inbox", requireManagerOrAdmin, asyncHandler(async (req, res) => {
    const deleted = await storage.deleteLeadCaptureInbox(req.user.contractorId);
    if (!deleted) {
      res.status(404).json({ message: "No lead capture inbox configured" });
      return;
    }
    await storage.disableTenantIntegration(req.user.contractorId, 'lead-capture');
    log.info(`[OAuthRoutes] INFO lead-capture integration disabled for contractor ${req.user.contractorId} by user ${req.user.userId}`);
    await syncScheduler.onIntegrationDisabled(req.user.contractorId, 'lead-capture');
    res.json({ success: true, message: "Lead capture inbox disconnected" });
  }));

  app.post("/api/settings/lead-capture-inbox/sync", requireManagerOrAdmin, asyncHandler(async (req, res) => {
    const inbox = await storage.getLeadCaptureInbox(req.user.contractorId);
    if (!inbox) {
      res.status(404).json({ message: "No lead capture inbox configured" });
      return;
    }

    try {
      const result = await syncLeadCaptureInbox(inbox);
      res.json({
        success: true,
        ...result,
        message: `Processed ${result.processed} emails, skipped ${result.skippedSpam} spam, ${result.skippedBlocked} blocked, ${result.errors} errors`,
      });
    } catch (error) {
      log.error('Lead capture sync error:', error);
      res.status(500).json({
        message: error instanceof Error ? error.message : 'Sync failed',
      });
    }
  }));

  app.post("/api/settings/lead-capture-inbox/spam-filter", requireManagerOrAdmin, asyncHandler(async (req, res) => {
    const schema = z.object({ enabled: z.boolean() });
    const parsed = parseBody(schema, req, res);
    if (!parsed) return;

    const inbox = await storage.updateLeadCaptureInboxSpamFilter(
      req.user.contractorId,
      parsed.enabled
    );
    if (!inbox) {
      res.status(404).json({ message: "No lead capture inbox configured" });
      return;
    }
    res.json({ success: true, spamFilterEnabled: inbox.spamFilterEnabled });
  }));

  app.get("/api/settings/lead-capture-inbox/sender-rules", requireManagerOrAdmin, asyncHandler(async (req, res) => {
    const rules = await storage.getSenderRules(req.user.contractorId);
    res.json(rules);
  }));

  app.post("/api/settings/lead-capture-inbox/sender-rules", requireManagerOrAdmin, asyncHandler(async (req, res) => {
    const parsed = parseBody(senderRuleSchema, req, res);
    if (!parsed) return;
    try {
      const rules = await storage.addSenderRule(req.user.contractorId, parsed);
      res.json(rules);
    } catch (error) {
      res.status(404).json({ message: error instanceof Error ? error.message : 'Failed to add rule' });
    }
  }));

  app.delete("/api/settings/lead-capture-inbox/sender-rules/:senderEmail", requireManagerOrAdmin, asyncHandler(async (req, res) => {
    const senderEmail = decodeURIComponent(req.params.senderEmail);
    try {
      const rules = await storage.deleteSenderRule(req.user.contractorId, senderEmail);
      res.json(rules);
    } catch (error) {
      res.status(404).json({ message: error instanceof Error ? error.message : 'Failed to delete rule' });
    }
  }));

  app.post("/api/settings/lead-capture-inbox/spam-threshold", requireManagerOrAdmin, asyncHandler(async (req, res) => {
    const schema = z.object({ threshold: z.number().int().min(1).max(100) });
    const parsed = parseBody(schema, req, res);
    if (!parsed) return;

    const inbox = await storage.updateSpamConfidenceThreshold(
      req.user.contractorId,
      parsed.threshold
    );
    if (!inbox) {
      res.status(404).json({ message: "No lead capture inbox configured" });
      return;
    }
    res.json({ success: true, spamConfidenceThreshold: inbox.spamConfidenceThreshold });
  }));

  app.get("/api/settings/lead-capture-inbox/spam-audit-log", requireManagerOrAdmin, asyncHandler(async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
    const offset = parseInt(req.query.offset as string) || 0;
    const result = await storage.getSpamAuditLog(req.user.contractorId, limit, offset);
    res.json(result);
  }));

  app.post("/api/settings/lead-capture-inbox/spam-audit-log/:id/recover", requireManagerOrAdmin, asyncHandler(async (req, res) => {
    const { id } = req.params;
    const contractorId = req.user.contractorId;

    const entry = await storage.getSpamAuditEntry(id, contractorId);
    if (!entry) {
      res.status(404).json({ message: "Audit log entry not found" });
      return;
    }
    if (entry.recoveredAt) {
      res.status(400).json({ message: "This entry has already been recovered" });
      return;
    }

    const { parseEmailWithAI } = await import('../services/email-ai-parser');
    const { normalizePhoneForStorage } = await import('../utils/phone-normalizer');
    const aiResult = await parseEmailWithAI(entry.subject, entry.body);

    const contactEmail = aiResult.email || entry.senderEmail;
    const contactName = aiResult.name || contactEmail.split('@')[0] || 'Unknown';
    const rawPhone = aiResult.phone || '';
    const normalizedPhone = rawPhone ? normalizePhoneForStorage(rawPhone) : '';
    const serviceDescription = aiResult.serviceDescription || entry.subject;

    const result = await ingestLead(contractorId, {
      name: contactName,
      emails: contactEmail ? [contactEmail] : [],
      phones: normalizedPhone ? [normalizedPhone] : [],
      source: 'email_capture',
      message: serviceDescription || entry.subject,
      skipDuplicateLeadWithinHours: 0,
      skipAutoAssign: false,
      ipAddress: req.ip,
    });

    await storage.markSpamAuditRecovered(id, contractorId, result.lead.id);

    log.info(`Recovered spam audit entry ${id} as lead ${result.lead.id}`);
    res.json({ success: true, leadId: result.lead.id });
  }));

  app.delete("/api/settings/lead-capture-inbox/spam-audit-log", requireManagerOrAdmin, asyncHandler(async (req, res) => {
    const deleted = await storage.deleteAllUnrecoveredSpamAuditLog(req.user.contractorId);
    res.json({ deleted });
  }));

  app.delete("/api/settings/lead-capture-inbox/spam-audit-log/:id", requireManagerOrAdmin, asyncHandler(async (req, res) => {
    const { id } = req.params;
    const deleted = await storage.deleteSpamAuditLogEntry(req.user.contractorId, id);
    if (deleted === 0) {
      res.status(404).json({ message: "Audit log entry not found" });
      return;
    }
    res.json({ deleted });
  }));

  app.get("/api/settings/lead-capture-inbox/oauth/start", requireManagerOrAdmin, asyncHandler(async (req, res) => {
    if (!gmailService.isConfigured()) {
      res.status(500).json({
        message: "Gmail integration not configured. Please set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET.",
      });
      return;
    }

    try {
      gmailService.validateEncryptionKey();
    } catch (error) {
      res.status(500).json({
        message: error instanceof Error ? error.message : "Encryption key not configured",
      });
      return;
    }

    const host = req.get('host');
    if (!host) {
      res.status(400).json({ message: "Unable to determine request host" });
      return;
    }

    if (!gmailService.validateHost(host)) {
      res.status(403).json({ message: "Invalid domain for OAuth" });
      return;
    }

    const authUrl = await gmailService.generateAuthUrl(
      `lead_capture:${req.user.contractorId}:${req.user.userId}`,
      host
    );

    if (!authUrl.startsWith('https://accounts.google.com/')) {
      log.error(`Unexpected OAuth redirect URL generated: ${authUrl}`);
      res.status(500).json({ message: "OAuth provider returned an unexpected redirect URL" });
      return;
    }

    res.json({ authUrl });
  }));
}
