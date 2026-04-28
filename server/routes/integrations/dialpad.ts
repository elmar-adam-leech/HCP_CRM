import type { Express } from "express";
import { storage } from "../../storage";
import { isIntegrationEnabledCached } from "../../services/cache";
import { users, webhookEvents, dialpadWebhookState } from "@shared/schema";
import { db } from "../../db";
import { eq, and, desc, like, ne } from "drizzle-orm";
import { dialpadEnhancedService } from "../../dialpad";
import { fetchRecording } from "../../dialpad/recordings";
import { activities } from "@shared/schema";
import { credentialService } from "../../credential-service";
import { requireManagerOrAdmin } from "../../auth-service";
import { sql } from "drizzle-orm";
import { Readable } from "stream";
import type { ReadableStream as NodeWebReadableStream } from "stream/web";
import { setSyncStatus } from "../../sync-status-store";
import { asyncHandler } from "../../utils/async-handler";
import { logger } from "../../utils/logger";

const log = logger('Dialpad');

const webhookCreateInProgress = new Set<string>();

export function registerDialpadRoutes(app: Express): void {
  app.get("/api/dialpad/health/raw-state", requireManagerOrAdmin, asyncHandler(async (req, res) => {
    const contractorId = req.user.contractorId;

    let webhooks: Array<{ id: string; hook_url: string; hook_type?: string; enabled?: boolean }> = [];
    let webhooksError: string | null = null;
    let subscriptions: Array<{
      id: string;
      enabled: boolean;
      target_type?: string;
      target_id?: string;
      call_states?: string[];
      webhook?: { hook_url?: string; id?: string } | null;
    }> = [];
    let subscriptionsError: string | null = null;

    try {
      const { apiKey, baseUrl } = await dialpadEnhancedService.getCredentials(contractorId);

      const [webhookRes, subRes] = await Promise.all([
        fetch(`${baseUrl}/webhooks`, {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        }),
        fetch(`${baseUrl}/subscriptions/call`, {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        }),
      ]);

      if (!webhookRes.ok) {
        webhooksError = `Failed to fetch webhooks from Dialpad: ${webhookRes.status}`;
      } else {
        const webhookData = await webhookRes.json();
        const rawWebhooks: Array<{ id: number | string; hook_url?: string; hook_type?: string; enabled?: boolean }> =
          webhookData.items || (Array.isArray(webhookData) ? webhookData : []);
        webhooks = rawWebhooks.map(w => ({
          id: w.id?.toString(),
          hook_url: w.hook_url ?? '',
          hook_type: w.hook_type,
          enabled: w.enabled,
        }));
      }

      if (!subRes.ok) {
        subscriptionsError = `Failed to fetch call subscriptions from Dialpad: ${subRes.status}`;
      } else {
        const subData = await subRes.json();
        const rawSubs: Array<{
          id: number | string;
          enabled?: boolean;
          target_type?: string;
          target_id?: number | string;
          call_states?: string[];
          webhook?: { hook_url?: string; id?: number | string } | null;
        }> = subData.items || (Array.isArray(subData) ? subData : []);
        subscriptions = rawSubs.map(s => ({
          id: s.id?.toString(),
          enabled: s.enabled ?? true,
          target_type: s.target_type,
          target_id: s.target_id?.toString(),
          call_states: s.call_states,
          webhook: s.webhook != null ? {
            hook_url: s.webhook.hook_url,
            id: s.webhook.id?.toString(),
          } : null,
        }));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      webhooksError = webhooksError ?? msg;
      subscriptionsError = subscriptionsError ?? msg;
    }

    res.json({ webhooks, webhooksError, subscriptions, subscriptionsError });
  }));

  app.get("/api/dialpad/webhooks/health", requireManagerOrAdmin, asyncHandler(async (req, res) => {
    const contractorId = req.user.contractorId;

    const rows = await db
      .select({ createdAt: webhookEvents.createdAt })
      .from(webhookEvents)
      .where(
        and(
          eq(webhookEvents.contractorId, contractorId),
          eq(webhookEvents.service, 'dialpad'),
          like(webhookEvents.eventType, 'call.%'),
          ne(webhookEvents.eventType, 'call.auth_failed')
        )
      )
      .orderBy(desc(webhookEvents.createdAt))
      .limit(1);

    const lastCallEventAt = rows[0]?.createdAt ?? null;
    const callEventsReceived = lastCallEventAt !== null;

    let staleDays: number | null = null;
    if (lastCallEventAt) {
      const diffMs = Date.now() - new Date(lastCallEventAt).getTime();
      staleDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    }

    res.json({ callEventsReceived, lastCallEventAt: lastCallEventAt?.toISOString() ?? null, staleDays });
  }));

  const diagnoseHandler = asyncHandler(async (req, res) => {
    const contractorId = req.user.contractorId;

    const protocol = req.get('x-forwarded-proto') || req.protocol;
    const host = req.get('x-forwarded-host') || req.get('host');
    const currentHost = `${protocol}://${host}`;

    const rows = await db
      .select({ createdAt: webhookEvents.createdAt })
      .from(webhookEvents)
      .where(
        and(
          eq(webhookEvents.contractorId, contractorId),
          eq(webhookEvents.service, 'dialpad'),
          like(webhookEvents.eventType, 'call.%'),
          ne(webhookEvents.eventType, 'call.auth_failed')
        )
      )
      .orderBy(desc(webhookEvents.createdAt))
      .limit(1);

    const lastCallEventAt = rows[0]?.createdAt ?? null;
    const callEventsReceived = lastCallEventAt !== null;
    let staleDays: number | null = null;
    if (lastCallEventAt) {
      const diffMs = Date.now() - new Date(lastCallEventAt).getTime();
      staleDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    }

    // Expected URLs match the format produced by createWebhookWithSubscription:
    //   ${currentHost}/api/webhooks/dialpad/{calls,sms}/${contractorId}?key=${webhook_api_key}
    let webhookApiKey: string | null = null;
    try {
      webhookApiKey = await credentialService.getCredential(contractorId, 'dialpad', 'webhook_api_key');
    } catch {
      // ignore — diagnostic still works without the key, urls just lack ?key=
    }
    const keySuffix = webhookApiKey ? `?key=${encodeURIComponent(webhookApiKey)}` : '';
    const expectedCallUrl = `${currentHost}/api/webhooks/dialpad/calls/${contractorId}${keySuffix}`;
    const expectedSmsUrl = `${currentHost}/api/webhooks/dialpad/sms/${contractorId}${keySuffix}`;

    const [webhooksResult, callSubscriptionsResult, smsSubscriptionsResult, persistedStateRows] = await Promise.all([
      dialpadEnhancedService.listWebhooks(contractorId),
      dialpadEnhancedService.listCallSubscriptions(contractorId),
      dialpadEnhancedService.listSmsSubscriptions(contractorId),
      db.select().from(dialpadWebhookState).where(eq(dialpadWebhookState.contractorId, contractorId)).limit(1),
    ]);

    const persistedState = persistedStateRows[0] ?? null;

    // Compare URLs by stripping the ?key= query so a rotated key alone doesn't show as drift.
    const stripKey = (u: string) => {
      try {
        const parsed = new URL(u);
        parsed.search = '';
        return parsed.toString();
      } catch {
        return u;
      }
    };
    const expectedCallCanonical = stripKey(expectedCallUrl);
    const expectedSmsCanonical = stripKey(expectedSmsUrl);

    const currentUrl = new URL(currentHost);
    const webhooks = (webhooksResult.success ? webhooksResult.webhooks ?? [] : []).map((w) => {
      const url = w.hook_url ?? '';
      let urlMismatch = false;
      let matchesExpected = false;
      if (url !== '') {
        try {
          const parsed = new URL(url);
          urlMismatch = parsed.host !== currentUrl.host || parsed.protocol !== currentUrl.protocol;
          const canonical = stripKey(url);
          matchesExpected = canonical === expectedCallCanonical || canonical === expectedSmsCanonical;
        } catch {
          urlMismatch = true;
        }
      }
      return { id: w.id, hook_url: url, urlMismatch, matchesExpected };
    });

    const webhookIdSet = new Set(webhooks.map((w) => w.id?.toString()));

    // webhookLinked uses Dialpad's own `webhook != null` signal as the primary
    // truth source. We fall back to `webhook_id ∈ listed webhooks` only when
    // Dialpad didn't return a `webhook` object (older API responses), so
    // orphaned subscriptions (webhook: null) are always flagged as unlinked
    // regardless of any stale webhook_id they may carry.
    const callSubscriptions = (callSubscriptionsResult.success ? callSubscriptionsResult.subscriptions ?? [] : [])
      .map((s) => ({
        ...s,
        webhookLinked: s.webhook_present !== undefined
          ? s.webhook_present
          : (s.webhook_id ? webhookIdSet.has(s.webhook_id.toString()) : false),
        webhookHookUrl: s.webhook_hook_url ?? null,
      }));
    const activeSubscriptionCount = callSubscriptions.filter((s) => s.enabled).length;
    const unlinkedCallSubscriptionCount = callSubscriptions.filter((s) => !s.webhookLinked).length;

    const smsSubscriptions = (smsSubscriptionsResult.success ? smsSubscriptionsResult.subscriptions ?? [] : [])
      .map((s) => ({
        ...s,
        webhookLinked: s.webhook_present !== undefined
          ? s.webhook_present
          : (s.webhook_id ? webhookIdSet.has(s.webhook_id.toString()) : false),
      }));
    const activeSmsSubscriptionCount = smsSubscriptions.filter((s) => s.enabled).length;

    // Drift fallback: when the live Dialpad list call fails, fall back to persisted IDs/URLs
    // so operators can still see whether what we last registered matches the current host.
    const persistedCallDrift = persistedState?.lastRegisteredCallUrl
      ? stripKey(persistedState.lastRegisteredCallUrl) !== expectedCallCanonical
      : null;
    const persistedSmsDrift = persistedState?.lastRegisteredSmsUrl
      ? stripKey(persistedState.lastRegisteredSmsUrl) !== expectedSmsCanonical
      : null;

    const liveListFailed = !webhooksResult.success;
    const driftDetected = liveListFailed
      ? Boolean(persistedCallDrift || persistedSmsDrift)
      : (webhooks.some((w) => !w.matchesExpected) || unlinkedCallSubscriptionCount > 0);

    res.json({
      eventReception: {
        callEventsReceived,
        lastCallEventAt: lastCallEventAt?.toISOString() ?? null,
        staleDays,
      },
      webhooks,
      webhooksError: webhooksResult.success ? null : (webhooksResult.error ?? 'Failed to list webhooks'),
      subscriptions: callSubscriptions,
      callSubscriptions,
      subscriptionsError: callSubscriptionsResult.success ? null : (callSubscriptionsResult.error ?? 'Failed to list subscriptions'),
      activeSubscriptionCount,
      smsSubscriptions,
      smsSubscriptionsError: smsSubscriptionsResult.success ? null : (smsSubscriptionsResult.error ?? 'Failed to list SMS subscriptions'),
      activeSmsSubscriptionCount,
      expectedCallUrl,
      expectedSmsUrl,
      driftDetected,
      driftSource: liveListFailed ? 'persisted' : 'live',
      persistedCallDrift,
      persistedSmsDrift,
      persistedState: persistedState ? {
        smsWebhookId: persistedState.smsWebhookId,
        smsSubscriptionId: persistedState.smsSubscriptionId,
        callWebhookId: persistedState.callWebhookId,
        callSubscriptionIds: persistedState.callSubscriptionIds,
        lastRegisteredCallUrl: persistedState.lastRegisteredCallUrl,
        lastRegisteredSmsUrl: persistedState.lastRegisteredSmsUrl,
        lastRegisteredAt: persistedState.lastRegisteredAt?.toISOString() ?? null,
      } : null,
      currentHost,
    });
  });

  app.get("/api/dialpad/health/diagnose", requireManagerOrAdmin, diagnoseHandler);
  // Alias path required by task spec — same handler, same response shape.
  app.get("/api/dialpad/diagnostics", requireManagerOrAdmin, diagnoseHandler);

  app.post("/api/dialpad/sync-phone-numbers", requireManagerOrAdmin, asyncHandler(async (req, res) => {
    const isIntegrationEnabled = await isIntegrationEnabledCached(req.user.contractorId, 'dialpad');
    if (!isIntegrationEnabled) {
      res.status(403).json({
        message: "Dialpad integration is not enabled. Please enable it first.",
        integrationDisabled: true
      });
      return;
    }

    const result = await dialpadEnhancedService.syncPhoneNumbers(req.user.contractorId);

    res.json({
      success: true,
      message: `Synced ${result.synced} phone numbers`,
      synced: result.synced,
      phoneNumbers: result.phoneNumbers,
      errors: result.errors
    });
  }));

  app.get("/api/dialpad/phone-numbers", asyncHandler(async (req, res) => {
    const phoneNumbers = await storage.getDialpadPhoneNumbers(req.user.contractorId);
    res.json(phoneNumbers);
  }));

  app.get("/api/dialpad/users/available-phone-numbers", asyncHandler(async (req, res) => {
    const action = req.query.action as 'sms' | 'call' || 'sms';
    const availableNumbers = await dialpadEnhancedService.getUserAvailablePhoneNumbers(
      req.user.userId,
      req.user.contractorId,
      action
    );
    res.json(availableNumbers);
  }));

  app.get("/api/users/:userId/phone-permissions", requireManagerOrAdmin, asyncHandler(async (req, res) => {
    const { userId } = req.params;

    const targetUser = await db.select().from(users)
      .where(and(eq(users.id, userId), eq(users.contractorId, req.user.contractorId)))
      .limit(1);

    if (!targetUser[0]) {
      res.status(404).json({ message: "User not found" });
      return;
    }

    const permissions = await storage.getUserPhoneNumberPermissions(userId);

    const permissionsWithDetails = await Promise.all(
      permissions.map(async (perm) => {
        const phoneNumber = await storage.getDialpadPhoneNumber(perm.phoneNumberId, req.user.contractorId);
        return {
          ...perm,
          phoneNumber: phoneNumber?.phoneNumber,
          displayName: phoneNumber?.displayName
        };
      })
    );

    res.json(permissionsWithDetails);
  }));

  app.post("/api/dialpad/phone-numbers/:phoneNumberId/permissions", requireManagerOrAdmin, asyncHandler(async (req, res) => {
    const { phoneNumberId } = req.params;
    const { userId, canSendSms, canMakeCalls } = req.body;

    if (!userId) {
      res.status(400).json({ message: "User ID is required" });
      return;
    }

    const existingPermission = await storage.getUserPhoneNumberPermission(userId, phoneNumberId);

    if (existingPermission) {
      const updatedPermission = await storage.updateUserPhoneNumberPermission(existingPermission.id, {
        canSendSms: canSendSms ?? false,
        canMakeCalls: canMakeCalls ?? false,
        isActive: true
      });
      res.json(updatedPermission);
    } else {
      const newPermission = await storage.createUserPhoneNumberPermission({
        userId,
        phoneNumberId,
        contractorId: req.user.contractorId,
        canSendSms: canSendSms ?? false,
        canMakeCalls: canMakeCalls ?? false,
        assignedBy: req.user.userId
      });
      res.json(newPermission);
    }
  }));

  app.delete("/api/dialpad/phone-numbers/:phoneNumberId/permissions/:userId", requireManagerOrAdmin, asyncHandler(async (req, res) => {
    const { phoneNumberId, userId } = req.params;

    const permission = await storage.getUserPhoneNumberPermission(userId, phoneNumberId);
    if (!permission) {
      res.status(404).json({ message: "Permission not found" });
      return;
    }

    const deleted = await storage.deleteUserPhoneNumberPermission(permission.id);
    if (deleted) {
      res.json({ success: true, message: "Permission removed successfully" });
    } else {
      res.status(500).json({ message: "Failed to remove permission" });
    }
  }));

  app.put("/api/dialpad/phone-numbers/:id", requireManagerOrAdmin, asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { displayName, department } = req.body;

    const updatedPhoneNumber = await storage.updateDialpadPhoneNumber(id, {
      displayName,
      department
    });

    res.json(updatedPhoneNumber);
  }));

  app.get("/api/dialpad/users", asyncHandler(async (req, res) => {
    const isIntegrationEnabled = await isIntegrationEnabledCached(req.user.contractorId, 'dialpad');
    if (!isIntegrationEnabled) {
      res.status(403).json({
        message: "Dialpad integration is not enabled. Please enable it first.",
        integrationDisabled: true
      });
      return;
    }

    const dialpadUsers = await dialpadEnhancedService.fetchDialpadUsers(req.user.contractorId);
    res.json(dialpadUsers);
  }));

  app.post("/api/dialpad/webhooks/create", requireManagerOrAdmin, asyncHandler(async (req, res) => {
    const isIntegrationEnabled = await isIntegrationEnabledCached(req.user.contractorId, 'dialpad');
    if (!isIntegrationEnabled) {
      res.status(403).json({
        message: "Dialpad integration is not enabled. Please enable it first.",
        integrationDisabled: true
      });
      return;
    }

    const contractorId = req.user.contractorId;

    if (webhookCreateInProgress.has(contractorId)) {
      res.status(409).json({
        message: "Re-registration already in progress for this account, please wait.",
      });
      return;
    }

    webhookCreateInProgress.add(contractorId);

    try {
    const protocol = req.get('x-forwarded-proto') || req.protocol;
    const host = req.get('x-forwarded-host') || req.get('host');
    const baseWebhookUrl = `${protocol}://${host}`;

    const existingWebhooks = await dialpadEnhancedService.listWebhooks(contractorId);
    if (existingWebhooks.success && existingWebhooks.webhooks) {
      for (const existing of existingWebhooks.webhooks) {
        await dialpadEnhancedService.deleteWebhook(contractorId, existing.id);
      }
    }

    const result = await dialpadEnhancedService.createWebhookWithSubscription(
      contractorId,
      'all',
      baseWebhookUrl
    );

    if (!result.success) {
      res.status(500).json({
        message: "Failed to create webhook",
        error: result.error
      });
      return;
    }

    const hasCallSubscriptions = result.callSubscriptionIds && result.callSubscriptionIds.length > 0;

    if (!hasCallSubscriptions) {
      const errorDetail = result.callSubscriptionError
        ?? 'SMS webhook registered, but call event subscriptions could not be created. Call events will not be received until this is resolved.';
      log.warn(`[webhooks/create] Call subscriptions failed for tenant ${contractorId}: ${errorDetail}`);
      res.status(207).json({
        success: false,
        callSubscriptionsActive: false,
        webhookId: result.webhookId,
        subscriptionId: result.subscriptionId,
        webhookUrl: result.hookUrl,
        callSubscriptionError: errorDetail,
        message: errorDetail,
      });
      return;
    }

    res.json({
      success: true,
      webhookId: result.webhookId,
      subscriptionId: result.subscriptionId,
      callSubscriptionId: result.callSubscriptionId,
      callSubscriptionIds: result.callSubscriptionIds,
      callSubscriptionActualTargetType: result.callSubscriptionActualTargetType,
      callSubscriptionError: result.callSubscriptionError,
      callSubscriptionWarning: result.callSubscriptionWarning,
      callSubscriptionsActive: true,
      webhookUrl: result.hookUrl,
    });
    } finally {
      webhookCreateInProgress.delete(contractorId);
    }
  }));

  app.get("/api/dialpad/webhooks/list", requireManagerOrAdmin, asyncHandler(async (req, res) => {
    const isIntegrationEnabled = await isIntegrationEnabledCached(req.user.contractorId, 'dialpad');
    if (!isIntegrationEnabled) {
      res.status(403).json({
        message: "Dialpad integration is not enabled. Please enable it first.",
        integrationDisabled: true
      });
      return;
    }

    const result = await dialpadEnhancedService.listWebhooks(req.user.contractorId);

    if (!result.success) {
      res.status(500).json({
        message: "Failed to list webhooks",
        error: result.error
      });
      return;
    }

    res.json({ webhooks: result.webhooks || [] });
  }));

  app.get("/api/dialpad/subscriptions/call", requireManagerOrAdmin, asyncHandler(async (req, res) => {
    const isIntegrationEnabled = await isIntegrationEnabledCached(req.user.contractorId, 'dialpad');
    if (!isIntegrationEnabled) {
      res.status(403).json({
        message: "Dialpad integration is not enabled. Please enable it first.",
        integrationDisabled: true
      });
      return;
    }

    const result = await dialpadEnhancedService.listCallSubscriptions(req.user.contractorId);

    if (!result.success) {
      res.status(500).json({
        message: "Failed to list call subscriptions",
        error: result.error
      });
      return;
    }

    const subscriptions = result.subscriptions ?? [];
    const activeCount = subscriptions.filter(s => s.enabled).length;

    res.json({
      subscriptions,
      active: activeCount > 0,
      activeCount,
      totalCount: subscriptions.length,
    });
  }));

  app.post("/api/dialpad/subscriptions/call/reregister", requireManagerOrAdmin, asyncHandler(async (req, res) => {
    const isIntegrationEnabled = await isIntegrationEnabledCached(req.user.contractorId, 'dialpad');
    if (!isIntegrationEnabled) {
      res.status(403).json({
        message: "Dialpad integration is not enabled. Please enable it first.",
        integrationDisabled: true
      });
      return;
    }

    const { callWebhookId, callHookUrl } = req.body;
    if (!callWebhookId) {
      res.status(400).json({ message: "callWebhookId is required" });
      return;
    }

    const result = await dialpadEnhancedService.reregisterCallSubscriptions(
      req.user.contractorId,
      callWebhookId,
      callHookUrl
    );

    if (!result.success) {
      res.status(500).json({
        message: "Failed to create call subscriptions",
        error: result.error,
      });
      return;
    }

    res.json({
      success: true,
      subscriptionIds: result.subscriptionIds,
      targetType: result.targetType,
      targetDetails: result.targetDetails,
      message: `Call subscriptions registered (${result.targetType} targeting, ${result.subscriptionIds?.length ?? 0} subscription(s))`,
    });
  }));

  app.delete("/api/dialpad/webhooks/:webhookId", requireManagerOrAdmin, asyncHandler(async (req, res) => {
    const { webhookId } = req.params;
    const isIntegrationEnabled = await isIntegrationEnabledCached(req.user.contractorId, 'dialpad');

    if (!isIntegrationEnabled) {
      res.status(403).json({
        message: "Dialpad integration is not enabled. Please enable it first.",
        integrationDisabled: true
      });
      return;
    }

    const result = await dialpadEnhancedService.deleteWebhook(req.user.contractorId, webhookId);

    if (!result.success) {
      res.status(500).json({
        message: "Failed to delete webhook",
        error: result.error
      });
      return;
    }

    res.json({ success: true, message: "Webhook deleted successfully" });
  }));

  // ------------------------------------------------------------------
  // Call recording playback proxy.
  //
  // The recording_url Dialpad sends in webhook payloads expires within
  // minutes, so we cannot rely on it for playback later. Instead we
  // persist the recording IDs (in activity.metadata.recording_details[*].id)
  // and fetch a fresh copy from the Dialpad recordings export API on
  // demand here, streaming the audio back to the authenticated user.
  //
  // Ownership: the recording ID must correspond to a Dialpad call
  // activity belonging to the requester's contractor.
  //
  // Failure modes are translated into either an XHR-friendly JSON response
  // (for the inline <audio> element) or a redirect to the original Dialpad
  // share URL (for direct browser navigation), so users never see a raw
  // `{"message":"Internal server error"}` JSON tab.
  // ------------------------------------------------------------------
  app.get("/api/dialpad/recordings/:recordingId", asyncHandler(async (req, res) => {
    const contractorId = req.user.contractorId;
    const { recordingId } = req.params;

    // Distinguish a direct browser navigation (clicking "Open recording" in a
    // new tab) from an XHR request the <audio> element makes when streaming.
    // Browsers set `Sec-Fetch-Dest: document` for top-level navigations and
    // `audio` for media requests. When in doubt, fall back to the Accept
    // header — text/html implies a top-level navigation.
    const fetchDest = (req.headers['sec-fetch-dest'] as string | undefined)?.toLowerCase() ?? '';
    const acceptsHtml = (req.headers['accept'] as string | undefined ?? '').toLowerCase().includes('text/html');
    const isDirectNavigation = fetchDest === 'document' || (fetchDest === '' && acceptsHtml);

    // Helper: when a recording can't be streamed, send the user to the
    // Dialpad share page (or render a minimal HTML fallback) instead of a
    // raw JSON 500. For XHR/audio requests we still respond with JSON so
    // the player can react.
    // Escape any value before interpolating it into the HTML fallback page so
    // that metadata sources broadening in the future can never inject markup.
    const escapeHtml = (s: string): string =>
      s.replace(/[&<>"']/g, (c) => (
        c === '&' ? '&amp;'
        : c === '<' ? '&lt;'
        : c === '>' ? '&gt;'
        : c === '"' ? '&quot;'
        : '&#39;'
      ));

    const sendUnplayableFallback = (
      shareUrl: string | null,
      reason: string,
      status: number,
      extra?: Record<string, unknown>,
    ): void => {
      if (isDirectNavigation) {
        if (shareUrl) {
          res.redirect(302, shareUrl);
          return;
        }
        res
          .status(status)
          .type('html')
          .send(
            `<!doctype html><meta charset="utf-8"><title>Recording unavailable</title>`
            + `<body style="font-family:system-ui;padding:2rem;line-height:1.5">`
            + `<h1>Recording unavailable</h1>`
            + `<p>${escapeHtml(reason)}</p>`
            + `</body>`,
          );
        return;
      }
      res.status(status).json({ message: reason, ...extra });
    };

    if (!recordingId) {
      res.status(400).json({ message: "recordingId is required" });
      return;
    }

    const isIntegrationEnabled = await isIntegrationEnabledCached(contractorId, 'dialpad');
    if (!isIntegrationEnabled) {
      res.status(403).json({
        message: "Dialpad integration is not enabled.",
        integrationDisabled: true,
      });
      return;
    }

    // Verify the recording belongs to a call activity in this contractor.
    // metadata.recording_details is jsonb of shape [{ id, url, ... }], so we
    // use the JSONB containment operator to match without scanning every row.
    // Both the string-id and numeric-id forms are checked because Dialpad
    // sometimes serializes recording IDs as numbers and historical rows may
    // already be persisted that way.
    // Both needles are bound as parameters (NOT interpolated) so the
    // recordingId cannot be used to inject SQL or extra JSON keys.
    const stringNeedle = JSON.stringify([{ id: recordingId }]);
    const numericRecordingId = /^-?\d+$/.test(recordingId) ? Number(recordingId) : null;
    const ownershipPredicate = numericRecordingId !== null && Number.isSafeInteger(numericRecordingId)
      ? sql`(${activities.metadata} -> 'recording_details' @> ${stringNeedle}::jsonb
              OR ${activities.metadata} -> 'recording_details' @> ${JSON.stringify([{ id: numericRecordingId }])}::jsonb)`
      : sql`${activities.metadata} -> 'recording_details' @> ${stringNeedle}::jsonb`;

    const ownershipRows = await db
      .select({ id: activities.id, metadata: activities.metadata })
      .from(activities)
      .where(
        and(
          eq(activities.contractorId, contractorId),
          eq(activities.externalSource, 'dialpad'),
          ownershipPredicate,
        ),
      )
      .limit(1);

    if (ownershipRows.length === 0) {
      sendUnplayableFallback(null, "Recording not found", 404);
      return;
    }

    // The original recording_url (typically a https://dialpad.com/r/… share
    // page) is preserved in metadata so we can hand the user back to Dialpad
    // when our own playback path fails.
    const ownershipMeta = (ownershipRows[0].metadata ?? {}) as Record<string, unknown>;
    const shareUrl = typeof ownershipMeta.recording_url === 'string' ? ownershipMeta.recording_url : null;

    let result;
    try {
      result = await fetchRecording(contractorId, recordingId);
    } catch (err) {
      log.error(`Recording proxy threw for contractor ${contractorId}, recording ${recordingId}:`, err);
      sendUnplayableFallback(
        shareUrl,
        "We couldn't fetch this recording from Dialpad. Try opening it in Dialpad instead.",
        502,
        { error: (err as Error).message },
      );
      return;
    }

    if (!result.ok) {
      if (result.missingScope) {
        // Missing-scope is an admin/config issue — surface it cleanly even on
        // a top-level navigation so the contractor can fix it.
        if (isDirectNavigation) {
          res.status(502).type('html').send(
            `<!doctype html><meta charset="utf-8"><title>Recording unavailable</title>`
            + `<body style="font-family:system-ui;padding:2rem;line-height:1.5">`
            + `<h1>Recording unavailable</h1>`
            + `<p>The Dialpad API key is missing the <code>recordings_export</code> scope.`
            + ` An admin must regenerate the API key with that scope enabled.</p>`
            + (shareUrl ? `<p><a href="${escapeHtml(shareUrl)}">Open in Dialpad</a></p>` : '')
            + `</body>`,
          );
          return;
        }
        res.status(502).json({
          message: "Dialpad API key is missing the recordings_export scope. Please regenerate the API key with that scope enabled.",
          missingScope: true,
        });
        return;
      }
      sendUnplayableFallback(
        shareUrl,
        result.status === 404
          ? "This recording is no longer available from Dialpad."
          : "We couldn't fetch this recording from Dialpad. Try opening it in Dialpad instead.",
        result.status === 404 ? 404 : 502,
        { error: result.error },
      );
      return;
    }

    res.setHeader('Content-Type', result.contentType);
    if (result.contentLength) {
      res.setHeader('Content-Length', result.contentLength);
    }
    // Cache briefly so the audio element doesn't re-request on every seek.
    res.setHeader('Cache-Control', 'private, max-age=300');

    Readable.fromWeb(result.body as NodeWebReadableStream<Uint8Array>).pipe(res);
  }));

  app.post("/api/dialpad/sync", asyncHandler(async (req, res) => {
    const contractorId = req.user.contractorId;

    const isIntegrationEnabled = await isIntegrationEnabledCached(contractorId, 'dialpad');
    if (!isIntegrationEnabled) {
      res.status(403).json({
        message: "Dialpad integration is not enabled for this tenant. Please enable it first.",
        integrationDisabled: true
      });
      return;
    }

    setSyncStatus(contractorId, {
      isRunning: true,
      progress: 'Starting Dialpad sync...',
      error: null,
      lastSync: null,
      startTime: new Date()
    });

    log.info(`Starting manual sync for tenant ${contractorId}`);

    const summary = {
      users: { fetched: 0, cached: 0 },
      departments: { fetched: 0, cached: 0 },
      phoneNumbers: { fetched: 0, cached: 0 }
    };

    setSyncStatus(contractorId, {
      isRunning: true,
      progress: 'Syncing Dialpad users...',
      error: null,
      lastSync: null,
      startTime: new Date()
    });

    log.info('Syncing users...');
    const usersResult = await dialpadEnhancedService.syncUsers(contractorId);
    summary.users.fetched = usersResult.fetched;
    summary.users.cached = usersResult.synced;
    log.info(`Fetched ${usersResult.fetched} users, synced ${usersResult.synced} to database`);

    if (usersResult.errors.length > 0) {
      log.warn(`${usersResult.errors.length} errors during user sync: ${JSON.stringify(usersResult.errors)}`);
    }

    setSyncStatus(contractorId, {
      isRunning: true,
      progress: 'Syncing Dialpad departments...',
      error: null,
      lastSync: null,
      startTime: new Date()
    });

    log.info('Syncing departments...');
    const departmentsResult = await dialpadEnhancedService.syncDepartments(contractorId);
    summary.departments.fetched = departmentsResult.fetched;
    summary.departments.cached = departmentsResult.synced;
    log.info(`Fetched ${departmentsResult.fetched} departments, synced ${departmentsResult.synced} to database`);

    if (departmentsResult.errors.length > 0) {
      log.warn(`${departmentsResult.errors.length} errors during department sync: ${JSON.stringify(departmentsResult.errors)}`);
    }

    setSyncStatus(contractorId, {
      isRunning: true,
      progress: 'Syncing Dialpad phone numbers...',
      error: null,
      lastSync: null,
      startTime: new Date()
    });

    log.info('Syncing phone numbers...');
    const numbersResult = await dialpadEnhancedService.syncPhoneNumbers(contractorId);
    summary.phoneNumbers.fetched = numbersResult.fetched;
    summary.phoneNumbers.cached = numbersResult.synced;
    log.info(`Fetched ${numbersResult.fetched} phone numbers, synced ${numbersResult.synced} to database`);

    if (numbersResult.errors.length > 0) {
      log.warn(`${numbersResult.errors.length} errors during phone number sync: ${JSON.stringify(numbersResult.errors)}`);
    }

    log.info('Sync completed: ' + JSON.stringify(summary));

    setSyncStatus(contractorId, {
      isRunning: false,
      progress: null,
      error: null,
      lastSync: new Date().toISOString(),
      startTime: null
    });

    res.json({
      message: "Dialpad sync completed successfully",
      summary
    });
  }));

}
