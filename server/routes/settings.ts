import type { Express } from "express";
import { storage } from "../storage";
import { requireManagerOrAdmin, requireAdmin } from "../auth-service";
import { asyncHandler } from "../utils/async-handler";
import { parseBody } from "../utils/validate-body";
import { z } from "zod";
import { cacheInvalidation } from "../services/cache";
import { broadcastToContractor } from "../websocket";
import { lookup as dnsLookup } from "dns/promises";
import { LEAD_PLATFORMS, platformKey, type LeadPlatform } from "@shared/lib/lead-platform";
import { CredentialService } from "../credential-service";
import {
  syncFacebookAdSpendForContractor,
  syncGoogleAdSpendForContractor,
  FACEBOOK_INTEGRATION_NAME,
  GOOGLE_INTEGRATION_NAME,
} from "../services/ad-spend-sync";

export function registerSettingsRoutes(app: Express): void {
  app.get("/api/contractor", asyncHandler(async (req, res) => {
    const contractor = await storage.getContractor(req.user.contractorId);
    if (!contractor) {
      res.status(404).json({ message: "Contractor not found" });
      return;
    }
    res.json(contractor);
  }));

  app.get("/api/settings/estimate-archive", requireManagerOrAdmin, asyncHandler(async (req, res) => {
    const contractor = await storage.getContractor(req.user.contractorId);
    res.json({ estimateArchiveDays: contractor?.estimateArchiveDays ?? null });
  }));

  app.patch("/api/settings/estimate-archive", requireManagerOrAdmin, asyncHandler(async (req, res) => {
    const schema = z.object({
      estimateArchiveDays: z.number().int().min(1).nullable(),
    });
    const parsed = parseBody(schema, req, res);
    if (!parsed) return;
    await storage.updateContractor(req.user.contractorId, {
      estimateArchiveDays: parsed.estimateArchiveDays,
    });
    res.json({ estimateArchiveDays: parsed.estimateArchiveDays });
  }));

  app.get("/api/business-targets", requireManagerOrAdmin, asyncHandler(async (req, res) => {
    const targets = await storage.getBusinessTargets(req.user.contractorId);
    if (!targets) {
      res.json({
        speedToLeadMinutes: 60,
        followUpRatePercent: "80.00",
        setRatePercent: "40.00",
        closeRatePercent: "25.00"
      });
      return;
    }
    res.json(targets);
  }));

  app.post("/api/business-targets", requireManagerOrAdmin, asyncHandler(async (req, res) => {
    const targetsSchema = z.object({
      speedToLeadMinutes: z.number().int().min(0),
      followUpRatePercent: z.string(),
      setRatePercent: z.string(),
      closeRatePercent: z.string(),
    }).strict();
    const parsed = parseBody(targetsSchema, req, res);
    if (!parsed) return;
    const existingTargets = await storage.getBusinessTargets(req.user.contractorId);
    const result = existingTargets
      ? await storage.updateBusinessTargets(parsed, req.user.contractorId)
      : await storage.createBusinessTargets(parsed, req.user.contractorId);
    res.json(result);
  }));

  // ---- Media spend (manual ad-spend entries) ----
  // Accepted platform keys are the lower-case form of LEAD_PLATFORMS so the
  // ROI report and the Ad Spend page agree on the platform list.
  const platformKeys = LEAD_PLATFORMS.map((p) => platformKey(p as LeadPlatform)) as [string, ...string[]];
  const mediaSpendBodySchema = z.object({
    platform: z.enum(platformKeys),
    // ISO YYYY-MM-DD; we coerce to the first day of that month server-side.
    month: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "month must be YYYY-MM-DD"),
    amount: z.union([z.string(), z.number()])
      .transform((v) => typeof v === "string" ? v : String(v))
      .refine((v) => Number.isFinite(Number(v)) && Number(v) >= 0, { message: "amount must be a non-negative number" }),
    // Optional campaign within the platform. null/empty stores as
    // platform-level spend (shown as "Unattributed" in the ROI report).
    campaign: z.string().max(200).nullable().optional(),
    note: z.string().max(500).nullable().optional(),
  });

  function normalizeCampaign(input: string | null | undefined): string | null {
    if (input === undefined || input === null) return null;
    const trimmed = input.trim();
    return trimmed.length === 0 ? null : trimmed;
  }

  function normalizeMonth(input: string): string {
    // Force first-of-month so the unique (contractor, platform, month) index
    // can't be circumvented by varying day-of-month.
    const [y, m] = input.split("-");
    return `${y}-${m}-01`;
  }

  app.get("/api/media-spend", requireManagerOrAdmin, asyncHandler(async (req, res) => {
    const rows = await storage.listMediaSpend(req.user.contractorId);
    res.json(rows);
  }));

  app.post("/api/media-spend", requireManagerOrAdmin, asyncHandler(async (req, res) => {
    const parsed = parseBody(mediaSpendBodySchema, req, res);
    if (!parsed) return;
    try {
      const created = await storage.createMediaSpend(
        {
          platform: parsed.platform,
          campaign: normalizeCampaign(parsed.campaign),
          month: normalizeMonth(parsed.month),
          amount: String(parsed.amount),
          note: parsed.note ?? null,
        },
        req.user.contractorId,
        req.user.userId,
      );
      res.json(created);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (/unique|duplicate/i.test(message)) {
        res.status(409).json({ message: "An entry already exists for this platform, campaign, and month" });
        return;
      }
      throw err;
    }
  }));

  app.patch("/api/media-spend/:id", requireManagerOrAdmin, asyncHandler(async (req, res) => {
    const patchSchema = mediaSpendBodySchema.partial();
    const parsed = parseBody(patchSchema, req, res);
    if (!parsed) return;
    const existing = await storage.getMediaSpend(req.params.id, req.user.contractorId);
    if (!existing) {
      res.status(404).json({ message: "Spend entry not found" });
      return;
    }
    if (existing.source && existing.source !== "manual") {
      res.status(409).json({ message: "This row is auto-synced from the ad platform and cannot be edited." });
      return;
    }
    try {
      const updated = await storage.updateMediaSpend(
        req.params.id,
        req.user.contractorId,
        {
          ...(parsed.platform !== undefined ? { platform: parsed.platform } : {}),
          ...(parsed.month !== undefined ? { month: normalizeMonth(parsed.month) } : {}),
          ...(parsed.amount !== undefined ? { amount: String(parsed.amount) } : {}),
          ...(parsed.campaign !== undefined ? { campaign: normalizeCampaign(parsed.campaign) } : {}),
          ...(parsed.note !== undefined ? { note: parsed.note ?? null } : {}),
        },
        req.user.userId,
      );
      if (!updated) {
        res.status(404).json({ message: "Spend entry not found" });
        return;
      }
      res.json(updated);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (/unique|duplicate/i.test(message)) {
        res.status(409).json({ message: "An entry already exists for this platform, campaign, and month" });
        return;
      }
      throw err;
    }
  }));

  app.delete("/api/media-spend/:id", requireManagerOrAdmin, asyncHandler(async (req, res) => {
    const existing = await storage.getMediaSpend(req.params.id, req.user.contractorId);
    if (!existing) {
      res.status(404).json({ message: "Spend entry not found" });
      return;
    }
    if (existing.source && existing.source !== "manual") {
      res.status(409).json({ message: "This row is auto-synced from the ad platform and cannot be deleted." });
      return;
    }
    const deleted = await storage.deleteMediaSpend(req.params.id, req.user.contractorId);
    if (!deleted) {
      res.status(404).json({ message: "Spend entry not found" });
      return;
    }
    res.json({ success: true });
  }));

  type AutoSyncSource = "facebook_ads" | "google_ads";
  const SOURCE_TO_INTEGRATION: Record<AutoSyncSource, string> = {
    facebook_ads: FACEBOOK_INTEGRATION_NAME,
    google_ads: GOOGLE_INTEGRATION_NAME,
  };
  const SOURCE_REQUIRED_KEYS: Record<AutoSyncSource, string[]> = {
    facebook_ads: ["access_token", "ad_account_id"],
    google_ads: ["developer_token", "client_id", "client_secret", "refresh_token", "customer_id"],
  };

  async function summarizeConnection(contractorId: string, source: AutoSyncSource) {
    const integrationName = SOURCE_TO_INTEGRATION[source];
    const enabled = await storage.getContractorIntegration(contractorId, integrationName);
    const masked = await CredentialService.getMaskedCredentials(contractorId, integrationName);
    const required = SOURCE_REQUIRED_KEYS[source];
    const hasAllRequired = required.every((k) => masked[k]);
    const lastSyncedAt = await storage.getLastSyncedAt(contractorId, source);
    return {
      source,
      integrationName,
      isEnabled: !!(enabled?.isEnabled && hasAllRequired),
      hasCredentials: hasAllRequired,
      maskedCredentials: masked,
      lastSyncedAt,
    };
  }

  app.get("/api/ad-spend/connections", requireAdmin, asyncHandler(async (req, res) => {
    const [facebook, google] = await Promise.all([
      summarizeConnection(req.user.contractorId, "facebook_ads"),
      summarizeConnection(req.user.contractorId, "google_ads"),
    ]);
    res.json({ facebook, google });
  }));

  const facebookCredentialsSchema = z.object({
    access_token: z.string().min(10).max(2000),
    ad_account_id: z.string().regex(/^act_\d+$/, "ad_account_id must look like act_1234567890"),
  });
  const googleCredentialsSchema = z.object({
    developer_token: z.string().min(5).max(200),
    client_id: z.string().min(5).max(500),
    client_secret: z.string().min(5).max(500),
    refresh_token: z.string().min(5).max(2000),
    customer_id: z.string().regex(/^\d{6,}$/, "customer_id must be the numeric Google Ads customer id"),
    login_customer_id: z.string().regex(/^\d{6,}$/).optional(),
  });

  // Optional credential keys whose blank value should clear the stored
  // credential rather than be silently ignored.
  const SOURCE_OPTIONAL_KEYS: Record<AutoSyncSource, string[]> = {
    facebook_ads: [],
    google_ads: ["login_customer_id"],
  };

  async function persistConnection(
    contractorId: string,
    userId: string,
    source: AutoSyncSource,
    creds: Record<string, string | undefined>,
  ): Promise<void> {
    const integrationName = SOURCE_TO_INTEGRATION[source];
    const optional = SOURCE_OPTIONAL_KEYS[source];
    for (const [key, value] of Object.entries(creds)) {
      if (value === undefined || value === "") {
        if (optional.includes(key)) {
          await CredentialService.disableCredential(contractorId, integrationName, key);
        }
        continue;
      }
      await CredentialService.setCredential(contractorId, integrationName, key, value);
    }
    await storage.enableContractorIntegration(contractorId, integrationName, userId);
  }

  app.post("/api/ad-spend/connections/facebook", requireAdmin, asyncHandler(async (req, res) => {
    const parsed = parseBody(facebookCredentialsSchema, req, res);
    if (!parsed) return;
    await persistConnection(req.user.contractorId, req.user.userId, "facebook_ads", parsed);
    const initial = await syncFacebookAdSpendForContractor(req.user.contractorId);
    const summary = await summarizeConnection(req.user.contractorId, "facebook_ads");
    res.json({ ...summary, initialSync: initial });
  }));

  app.post("/api/ad-spend/connections/google", requireAdmin, asyncHandler(async (req, res) => {
    const parsed = parseBody(googleCredentialsSchema, req, res);
    if (!parsed) return;
    await persistConnection(req.user.contractorId, req.user.userId, "google_ads", parsed);
    const initial = await syncGoogleAdSpendForContractor(req.user.contractorId);
    const summary = await summarizeConnection(req.user.contractorId, "google_ads");
    res.json({ ...summary, initialSync: initial });
  }));

  const sourceParamSchema = z.object({ source: z.enum(["facebook", "google"]) });

  app.delete("/api/ad-spend/connections/:source", requireAdmin, asyncHandler(async (req, res) => {
    const params = sourceParamSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ message: "Unknown source" });
      return;
    }
    const source: AutoSyncSource = params.data.source === "facebook" ? "facebook_ads" : "google_ads";
    const integrationName = SOURCE_TO_INTEGRATION[source];
    await CredentialService.deleteIntegrationCredentials(req.user.contractorId, integrationName);
    await storage.disableContractorIntegration(req.user.contractorId, integrationName);
    res.json({ success: true });
  }));

  app.post("/api/ad-spend/connections/:source/sync", requireAdmin, asyncHandler(async (req, res) => {
    const params = sourceParamSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ message: "Unknown source" });
      return;
    }
    const result = params.data.source === "facebook"
      ? await syncFacebookAdSpendForContractor(req.user.contractorId)
      : await syncGoogleAdSpendForContractor(req.user.contractorId);
    if (result.error) {
      // Surface the upstream error code as 422 — the credentials/network are
      // the contractor's responsibility, not a CRM bug.
      res.status(422).json({ message: result.error, ...result });
      return;
    }
    res.json(result);
  }));

  app.get("/api/terminology", asyncHandler(async (req, res) => {
    const settings = await storage.getTerminologySettings(req.user.contractorId);
    if (!settings) {
      res.json({
        leadLabel: 'Lead', leadsLabel: 'Leads',
        estimateLabel: 'Estimate', estimatesLabel: 'Estimates',
        jobLabel: 'Job', jobsLabel: 'Jobs',
        messageLabel: 'Message', messagesLabel: 'Messages',
        templateLabel: 'Template', templatesLabel: 'Templates'
      });
      return;
    }
    res.json(settings);
  }));

  app.post("/api/terminology", requireManagerOrAdmin, asyncHandler(async (req, res) => {
    const terminologySchema = z.object({
      leadLabel:       z.string().min(1),
      leadsLabel:      z.string().min(1),
      estimateLabel:   z.string().min(1),
      estimatesLabel:  z.string().min(1),
      jobLabel:        z.string().min(1),
      jobsLabel:       z.string().min(1),
      messageLabel:    z.string().min(1),
      messagesLabel:   z.string().min(1),
      templateLabel:   z.string().min(1),
      templatesLabel:  z.string().min(1),
    });
    const parsed = parseBody(terminologySchema, req, res);
    if (!parsed) return;
    const existingSettings = await storage.getTerminologySettings(req.user.contractorId);
    const result = existingSettings
      ? await storage.updateTerminologySettings(parsed, req.user.contractorId)
      : await storage.createTerminologySettings(parsed, req.user.contractorId);
    cacheInvalidation.invalidateTerminologySettings(req.user.contractorId);
    broadcastToContractor(req.user.contractorId, { type: 'terminology_updated' });
    res.json(result);
  }));

  app.get("/api/settings/hcp-lead-settings", requireManagerOrAdmin, asyncHandler(async (req, res) => {
    const contractor = await storage.getContractor(req.user.contractorId);
    if (!contractor) {
      res.status(404).json({ message: "Contractor not found" });
      return;
    }
    res.json({
      hcpSendLeads: contractor.hcpSendLeads ?? true,
      hcpSyncSkipTags: contractor.hcpSyncSkipTags ?? [],
    });
  }));

  app.patch("/api/settings/hcp-lead-settings", requireManagerOrAdmin, asyncHandler(async (req, res) => {
    const schema = z.object({
      hcpSendLeads: z.boolean().optional(),
      hcpSyncSkipTags: z.array(z.string()).optional(),
    });
    const parsed = parseBody(schema, req, res);
    if (!parsed) return;
    const updated = await storage.updateContractor(req.user.contractorId, parsed);
    if (!updated) {
      res.status(404).json({ message: "Contractor not found" });
      return;
    }
    res.json({
      hcpSendLeads: updated.hcpSendLeads ?? true,
      hcpSyncSkipTags: updated.hcpSyncSkipTags ?? [],
    });
  }));

  // ---- AI SMS scheduling agent settings (task #697) ----
  // Admin-only: turning the AI agent on/off and editing its personality/company
  // context is a company-owner decision, not a per-manager one. The UI card is
  // also gated by isStrictAdmin — keep both layers in sync.
  app.get("/api/settings/ai-scheduling", requireAdmin, asyncHandler(async (req, res) => {
    const contractor = await storage.getContractor(req.user.contractorId);
    if (!contractor) {
      res.status(404).json({ message: "Contractor not found" });
      return;
    }
    res.json({
      aiSchedulingEnabled: contractor.aiSchedulingEnabled ?? false,
      aiSchedulingPersonality: contractor.aiSchedulingPersonality ?? "",
      aiSchedulingCompanyContext: contractor.aiSchedulingCompanyContext ?? "",
    });
  }));

  app.patch("/api/settings/ai-scheduling", requireAdmin, asyncHandler(async (req, res) => {
    const schema = z.object({
      aiSchedulingEnabled: z.boolean().optional(),
      // 2k char ceiling on each free-text field — comfortably more than
      // anyone needs and keeps the prompt size bounded for the LLM call.
      aiSchedulingPersonality: z.string().max(2000).nullable().optional(),
      aiSchedulingCompanyContext: z.string().max(2000).nullable().optional(),
    });
    const parsed = parseBody(schema, req, res);
    if (!parsed) return;
    const patch: Record<string, unknown> = {};
    if (parsed.aiSchedulingEnabled !== undefined) {
      patch.aiSchedulingEnabled = parsed.aiSchedulingEnabled;
    }
    if (parsed.aiSchedulingPersonality !== undefined) {
      const trimmed = (parsed.aiSchedulingPersonality ?? "").trim();
      patch.aiSchedulingPersonality = trimmed.length > 0 ? trimmed : null;
    }
    if (parsed.aiSchedulingCompanyContext !== undefined) {
      const trimmed = (parsed.aiSchedulingCompanyContext ?? "").trim();
      patch.aiSchedulingCompanyContext = trimmed.length > 0 ? trimmed : null;
    }
    const updated = await storage.updateContractor(req.user.contractorId, patch);
    if (!updated) {
      res.status(404).json({ message: "Contractor not found" });
      return;
    }
    res.json({
      aiSchedulingEnabled: updated.aiSchedulingEnabled ?? false,
      aiSchedulingPersonality: updated.aiSchedulingPersonality ?? "",
      aiSchedulingCompanyContext: updated.aiSchedulingCompanyContext ?? "",
    });
  }));

  // ---- Task #706: AI scheduling agent — runtime endpoints ----

  // Returns the open AI scheduling conversation (if any) for a contact.
  // Used by the contact detail sheet to show a "AI is handling this lead"
  // banner with a Take Over button.
  app.get(
    "/api/ai-scheduling/conversations/by-contact/:contactId",
    asyncHandler(async (req, res) => {
      const { aiSchedulingConversations } = await import("@shared/schema");
      const { db } = await import("../db");
      const { and, eq, sql: dsql } = await import("drizzle-orm");
      const [row] = await db.select().from(aiSchedulingConversations).where(and(
        eq(aiSchedulingConversations.contractorId, req.user.contractorId),
        eq(aiSchedulingConversations.contactId, req.params.contactId),
        dsql`${aiSchedulingConversations.status} IN ('active','awaiting_confirmation')`,
      )).limit(1);
      res.json(row ?? null);
    }),
  );

  // Manual take-over: ends the AI agent's open conversation for this contact
  // and writes a handoff activity. Idempotent.
  app.post(
    "/api/ai-scheduling/conversations/by-contact/:contactId/take-over",
    asyncHandler(async (req, res) => {
      const { aiSchedulingAgent } = await import("../services/ai-scheduling-agent");
      const ok = await aiSchedulingAgent.takeOverConversation(
        req.user.contractorId,
        req.params.contactId,
        req.user.userId,
      );
      res.json({ tookOver: ok });
    }),
  );

  app.get("/api/booking-slug", asyncHandler(async (req, res) => {
    const contractor = await storage.getContractor(req.user.contractorId);
    if (!contractor) {
      res.status(404).json({ message: "Contractor not found" });
      return;
    }
    const protocol = req.protocol;
    const host = req.get('host');
    const bookingUrl = contractor.bookingSlug
      ? `${protocol}://${host}/book/${contractor.bookingSlug}`
      : null;
    res.json({
      bookingSlug: contractor.bookingSlug || null,
      bookingUrl,
      bookingRedirectUrl: contractor.bookingRedirectUrl || null,
      // SAFE: `timezone` exists on the contractors table but is not yet reflected in
      // the shared Contractor TypeScript type. The column is present at runtime.
      // Remove `as any` once the `timezone` field is added to the Contractor schema type.
      timezone: (contractor as any).timezone || null,
    });
  }));

  app.post("/api/booking-slug", requireManagerOrAdmin, asyncHandler(async (req, res) => {
    const { bookingSlug, bookingRedirectUrl, timezone } = req.body;

    if (bookingSlug) {
      const slugRegex = /^[a-z0-9-]+$/;
      if (!slugRegex.test(bookingSlug)) {
        res.status(400).json({ message: "Booking slug can only contain lowercase letters, numbers, and hyphens" });
        return;
      }
      if (bookingSlug.length < 3 || bookingSlug.length > 50) {
        res.status(400).json({ message: "Booking slug must be between 3 and 50 characters" });
        return;
      }
      const existingContractor = await storage.getContractorBySlug(bookingSlug);
      if (existingContractor && existingContractor.id !== req.user.contractorId) {
        res.status(400).json({ message: "This booking slug is already taken" });
        return;
      }
    }

    if (bookingRedirectUrl) {
      try {
        new URL(bookingRedirectUrl);
      } catch {
        res.status(400).json({ message: "Post-booking redirect URL must be a valid URL (e.g. https://example.com/thank-you)" });
        return;
      }
    }

    const updated = await storage.updateContractor(req.user.contractorId, {
      bookingSlug: bookingSlug || null,
      bookingRedirectUrl: bookingRedirectUrl || null,
      ...(timezone ? { timezone } : {}),
    });

    if (!updated) {
      res.status(404).json({ message: "Contractor not found" });
      return;
    }

    const protocol = req.protocol;
    const host = req.get('host');
    const bookingUrl = bookingSlug
      ? `${protocol}://${host}/book/${bookingSlug}`
      : null;

    res.json({
      bookingSlug: updated.bookingSlug || null,
      bookingUrl,
      bookingRedirectUrl: updated.bookingRedirectUrl || null,
      // SAFE: same as above — `timezone` column exists at runtime but is not in the
      // Contractor TypeScript type yet. Remove once schema type is updated.
      timezone: (updated as any).timezone || null,
      message: bookingSlug ? "Booking settings updated successfully" : "Booking settings saved",
    });
  }));

  // Returns true if the IPv4 address string falls in a private/reserved range.
  function isPrivateIpv4(ip: string): boolean {
    const parts = ip.split(".").map(Number);
    if (parts.length !== 4 || parts.some((n) => isNaN(n))) return false;
    const [a, b] = parts;
    return (
      a === 127 ||                           // loopback
      a === 0 ||                             // reserved
      a === 10 ||                            // RFC1918
      (a === 172 && b >= 16 && b <= 31) ||  // RFC1918
      (a === 192 && b === 168) ||            // RFC1918
      (a === 169 && b === 254) ||            // link-local / AWS metadata
      (a === 100 && b >= 64 && b <= 127)     // CGNAT
    );
  }

  // Resolves hostname via DNS and rejects if any resolved IP is private/reserved.
  // Also rejects localhost, IPv6 loopback, and raw private IPv4 literals.
  async function assertPublicHost(hostname: string): Promise<void> {
    if (/^localhost$/i.test(hostname)) throw new Error("private");
    if (hostname === "[::1]" || hostname === "::1" || hostname === "::") throw new Error("private");

    // If the hostname is already an IPv4 literal, check it directly
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) {
      if (isPrivateIpv4(hostname)) throw new Error("private");
      return;
    }

    // Resolve DNS and check all returned addresses
    let addresses: { address: string; family: number }[];
    try {
      // all: true returns every A/AAAA record so we can check them all
      addresses = await dnsLookup(hostname, { all: true });
    } catch {
      throw new Error("dns_failure");
    }
    for (const { address, family } of addresses) {
      if (family === 4 && isPrivateIpv4(address)) throw new Error("private");
      // Reject IPv6 loopback/link-local
      if (family === 6 && (address === "::1" || /^fe80:/i.test(address) || /^fc|^fd/i.test(address))) {
        throw new Error("private");
      }
    }
  }

  // Logo management routes (admin only)
  app.patch("/api/contractor/logo", requireAdmin, asyncHandler(async (req, res) => {
    const logoSchema = z.object({
      logoUrl: z.union([
        z.string()
          .refine(
            (val) => {
              if (/^data:image\/[a-zA-Z+]+;base64,/.test(val)) return true;
              try {
                const u = new URL(val);
                return u.protocol === "https:";
              } catch {
                return false;
              }
            },
            { message: "Must be a valid https URL or a base64 data URI" }
          )
          .refine(
            (val) => Buffer.byteLength(val, "utf8") <= 700 * 1024,
            { message: "Logo exceeds 700 KB limit" }
          ),
        z.null(),
      ]),
    });
    const parsed = parseBody(logoSchema, req, res);
    if (!parsed) return;
    const updated = await storage.updateContractor(req.user.contractorId, { logoUrl: parsed.logoUrl });
    res.json({ logoUrl: updated?.logoUrl ?? null });
  }));

  app.delete("/api/contractor/logo", requireAdmin, asyncHandler(async (req, res) => {
    await storage.updateContractor(req.user.contractorId, { logoUrl: null });
    res.json({ logoUrl: null });
  }));

  app.patch("/api/contractor/brand-color", requireAdmin, asyncHandler(async (req, res) => {
    const brandColorSchema = z.object({
      brandColor: z.union([
        z.string().regex(/^#[0-9a-fA-F]{6}$/, { message: "Brand color must be a 6-digit hex like #3366ff" }),
        z.null(),
      ]),
    });
    const parsed = parseBody(brandColorSchema, req, res);
    if (!parsed) return;
    const normalized = parsed.brandColor ? parsed.brandColor.toLowerCase() : null;
    const updated = await storage.updateContractor(req.user.contractorId, { brandColor: normalized });
    res.json({ brandColor: updated?.brandColor ?? null });
  }));

  app.post("/api/contractor/logo/scan", requireAdmin, asyncHandler(async (req, res) => {
    const scanSchema = z.object({
      websiteUrl: z.string().url().refine(
        (val) => /^https?:\/\//i.test(val),
        { message: "Only http and https URLs are allowed" }
      ),
    });
    const parsed = parseBody(scanSchema, req, res);
    if (!parsed) return;

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(parsed.websiteUrl);
    } catch {
      res.status(400).json({ message: "Invalid URL" });
      return;
    }

    // SSRF protection: DNS-resolve the hostname and reject private/reserved IPs.
    // Checking just the hostname string is insufficient — an attacker can point
    // a public hostname at an internal address, bypassing string-only checks.
    try {
      await assertPublicHost(parsedUrl.hostname);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "";
      if (msg === "dns_failure") {
        res.status(422).json({ message: "Could not resolve the hostname" });
      } else {
        res.status(400).json({ message: "URL points to a reserved or private address" });
      }
      return;
    }

    let html: string;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      // redirect: "manual" prevents fetch from silently following 3xx responses
      // to private/internal targets, which would bypass the SSRF DNS check above.
      const response = await fetch(parsed.websiteUrl, {
        signal: controller.signal,
        redirect: "manual",
        headers: { "User-Agent": "Mozilla/5.0 (compatible; HCP-CRM-LogoScanner/1.0)" },
      });
      clearTimeout(timeout);
      if (response.status >= 300 && response.status < 400) {
        res.status(422).json({ message: "Website redirects are not allowed for logo scanning" });
        return;
      }
      html = await response.text();
    } catch {
      res.status(422).json({ message: "Failed to fetch website. Check the URL and try again." });
      return;
    }

    const baseUrl = parsedUrl.origin;
    const candidates: string[] = [];

    // Only return https candidate URLs so they can be saved via PATCH without failing validation.
    const resolveHttpsUrl = (href: string): string | null => {
      if (!href) return null;
      try {
        const resolved = href.startsWith("http") ? href : new URL(href, baseUrl).href;
        return /^https:\/\//i.test(resolved) ? resolved : null;
      } catch {
        return null;
      }
    };

    // og:image
    const ogMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    if (ogMatch) {
      const url = resolveHttpsUrl(ogMatch[1]);
      if (url) candidates.push(url);
    }

    // apple-touch-icon
    const appleMatch = html.match(/<link[^>]+rel=["']apple-touch-icon["'][^>]+href=["']([^"']+)["']/i)
      || html.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']apple-touch-icon["']/i);
    if (appleMatch) {
      const url = resolveHttpsUrl(appleMatch[1]);
      if (url && !candidates.includes(url)) candidates.push(url);
    }

    // favicon / icon
    const iconMatches = Array.from(html.matchAll(/<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]+href=["']([^"']+)["']/gi));
    for (const m of iconMatches) {
      const url = resolveHttpsUrl(m[1]);
      if (url && !candidates.includes(url)) candidates.push(url);
    }

    res.json({ candidates: candidates.slice(0, 3) });
  }));

  app.get("/api/settings/privacy", requireAdmin, asyncHandler(async (req, res) => {
    const contractor = await storage.getContractor(req.user.contractorId);
    res.json({
      dataRetentionMonths: contractor?.dataRetentionMonths ?? null,
      privacyNoticeMarkdown: contractor?.privacyNoticeMarkdown ?? null,
    });
  }));

  app.patch("/api/settings/privacy", requireAdmin, asyncHandler(async (req, res) => {
    const schema = z.object({
      dataRetentionMonths: z.number().int().min(1).max(1200).nullable().optional(),
      privacyNoticeMarkdown: z.string().max(50000).nullable().optional(),
    });
    const parsed = parseBody(schema, req, res);
    if (!parsed) return;
    await storage.updateContractor(req.user.contractorId, parsed);
    res.json({ success: true });
  }));

  app.get("/api/public/privacy-notice/:slug", asyncHandler(async (req, res) => {
    const contractor = await storage.getContractorBySlug(req.params.slug);
    if (!contractor) {
      res.status(404).json({ message: "Not found" });
      return;
    }
    res.json({ privacyNoticeMarkdown: contractor.privacyNoticeMarkdown ?? null });
  }));
}
