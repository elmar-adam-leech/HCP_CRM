import type { Express, Response } from "express";
import { asyncHandler } from "../utils/async-handler";
import { parseBody, parseIntParam } from "../utils/validate-body";
import { storage } from "../storage";
import { insertMessageSchema, users, contractors } from "@shared/schema";
import { z } from "zod";
import { db } from "../db";
import { eq, and } from "drizzle-orm";
import { gmailService } from "../gmail-service";
import { isEmptyEmailBody, isHtmlEmail, sanitizeEmailHtml } from "../utils/email-html";
import { type AuthedRequest, requireIntegrationManager } from "../auth-service";
import { broadcastToContractor } from "../websocket";
import { providerService } from "../providers/provider-service";
import { dialpadEnhancedService } from "../dialpad";
import { isIntegrationEnabledCached } from "../services/cache";

import { logger } from '../utils/logger';
import { getPublicBaseUrl } from "../utils/public-base-url";

const log = logger('MessagingRoutes');

export function registerMessagingRoutes(app: Express): void {
  app.get("/api/messages", asyncHandler(async (req, res) => {
    const contactId = (req.query.contactId || req.query.leadId || req.query.customerId) as string | undefined;
    const estimateId = req.query.estimateId as string | undefined;
    const messages = await storage.getMessages(req.user.contractorId, contactId, estimateId);
    res.json(messages);
  }));

  app.post("/api/messages/send-text", asyncHandler(async (req: AuthedRequest, res: Response) => {
    const messageData = parseBody(insertMessageSchema.omit({ contractorId: true, status: true }), req, res);
    if (!messageData) return;

    if (messageData.type !== 'text') {
      res.status(400).json({ message: "This endpoint is only for text messages" });
      return;
    }

    if (!messageData.toNumber) {
      res.status(400).json({ message: "Phone number is required" });
      return;
    }

    const resolvedContactId = messageData.contactId || (req.body.leadId as string | undefined) || (req.body.customerId as string | undefined);

    // Resolve {{booking_link}} server-side before sending
    let messageContent = messageData.content;
    if (messageContent.includes('{{booking_link}}')) {
      try {
        const contractor = await storage.getContractor(req.user.contractorId);
        if (contractor?.bookingSlug) {
          const origin = getPublicBaseUrl();
          if (origin && resolvedContactId) {
            let contact = await storage.getContact(resolvedContactId, req.user.contractorId);
            if (contact) {
              // Lazily generate bookingCode for existing contacts that don't have one
              if (!contact.bookingCode) {
                const { generateBookingCode } = await import('../utils/booking-token');
                const newCode = generateBookingCode();
                contact = await storage.updateContact(contact.id, { bookingCode: newCode }, req.user.contractorId) ?? contact;
              }
              if (contact.bookingCode) {
                const bookingUrl = `${origin}/book/${contractor.bookingSlug}?c=${contact.bookingCode}`;
                messageContent = messageContent.replace(/\{\{booking_link\}\}/g, bookingUrl);
              } else {
                // bookingCode generation failed — omit the link rather than
                // falling back to a raw UUID (not a proof of identity).
                log.warn('[messaging] bookingCode still absent after lazy backfill — omitting booking_link');
              }
            }
          }
        }
      } catch (err) {
        log.warn('Failed to resolve booking_link for manual SMS', { err });
      }
    }

    // Provider-agnostic SMS send — resolves the contractor's configured SMS
    // provider (Dialpad, Twilio, ...) via the provider abstraction.
    const smsPref = await storage.getTenantProvider(req.user.contractorId, 'sms');
    const smsProviderName = smsPref?.smsProvider || 'dialpad';
    const smsResponse = await providerService.sendSms({
      to: messageData.toNumber,
      message: messageContent,
      fromNumber: messageData.fromNumber || undefined,
      contractorId: req.user.contractorId,
      userId: req.user.userId,
    });

    if (smsResponse.success) {
      const savedMessage = await storage.createMessage({
        ...messageData,
        content: messageContent,
        status: 'sent',
        userId: req.user.userId,
        externalMessageId: smsResponse.messageId || null,
      }, req.user.contractorId);

      await Promise.all([
        resolvedContactId
          ? storage.markContactContacted(resolvedContactId, req.user.contractorId, req.user.userId)
          : Promise.resolve(),
        resolvedContactId
          ? storage.markLeadContacted(resolvedContactId, req.user.contractorId, req.user.userId)
          : Promise.resolve(),
        storage.createActivity({
          type: 'sms',
          title: 'SMS sent',
          content: messageContent,
          contactId: resolvedContactId || null,
          userId: req.user.userId,
          externalId: smsResponse.messageId || null,
          externalSource: smsProviderName,
        }, req.user.contractorId),
      ]);

      broadcastToContractor(req.user.contractorId, {
        type: 'new_message',
        message: savedMessage,
        contactId: resolvedContactId || null,
      });

      res.json({
        success: true,
        message: savedMessage,
        messageId: smsResponse.messageId
      });
    } else {
      res.status(500).json({
        success: false,
        error: smsResponse.error,
        message: "Failed to send text message"
      });
    }
  }));

  // Provider-agnostic "From Number" picker source. Merges the available
  // phone numbers from every ENABLED communication provider for the
  // contractor (Dialpad, Twilio, ...) so the Text/Call composer can pick a
  // sending number regardless of which provider the tenant uses. The actual
  // send still resolves the provider tenant-level in providerService — this
  // endpoint only populates the dropdown.
  app.get("/api/messages/available-from-numbers", asyncHandler(async (req: AuthedRequest, res: Response) => {
    const action: 'sms' | 'call' = req.query.action === 'call' ? 'call' : 'sms';
    const contractorId = req.user.contractorId;

    const [dialpadEnabled, twilioEnabled] = await Promise.all([
      isIntegrationEnabledCached(contractorId, 'dialpad'),
      isIntegrationEnabledCached(contractorId, 'twilio'),
    ]);

    const merged: Array<{ id: string; phoneNumber: string; displayName?: string }> = [];

    if (dialpadEnabled) {
      try {
        const dialpadNumbers = await dialpadEnhancedService.getUserAvailablePhoneNumbers(
          req.user.userId,
          contractorId,
          action,
        );
        for (const n of dialpadNumbers) {
          merged.push({ id: n.id, phoneNumber: n.phoneNumber, displayName: n.displayName ?? undefined });
        }
      } catch (err) {
        log.warn('Failed to load Dialpad available numbers for picker', { err });
      }
    }

    if (twilioEnabled) {
      try {
        const twilioNumbers = await storage.getTwilioPhoneNumbers(contractorId);
        const capable = twilioNumbers.filter(
          (n) => n.isActive && (action === 'sms' ? n.canSendSms : n.canMakeCalls),
        );
        if (capable.length > 0) {
          for (const n of capable) {
            merged.push({ id: n.id, phoneNumber: n.phoneNumber, displayName: n.displayName ?? undefined });
          }
        } else {
          // No capability-flagged numbers — fall back to the org default so
          // the picker isn't empty (Twilio capability flags are often unset).
          const contractor = await storage.getContractor(contractorId);
          const orgDefault = contractor?.defaultTwilioNumber;
          if (orgDefault) {
            const existing = twilioNumbers.find((n) => n.phoneNumber === orgDefault);
            merged.push({
              id: existing?.id ?? 'twilio-org-default',
              phoneNumber: orgDefault,
              displayName: existing?.displayName ?? undefined,
            });
          }
        }
      } catch (err) {
        log.warn('Failed to load Twilio available numbers for picker', { err });
      }
    }

    // Dedupe by phone number (a number could theoretically appear from both
    // providers); first occurrence wins.
    const seen = new Set<string>();
    const deduped = merged.filter((n) => {
      if (seen.has(n.phoneNumber)) return false;
      seen.add(n.phoneNumber);
      return true;
    });

    res.json(deduped);
  }));

  app.get("/api/messages/from-addresses", asyncHandler(async (req: AuthedRequest, res: Response) => {
    const addresses: Array<{ email: string; label: string; type: 'personal' | 'shared' }> = [];

    const [userResult, sharedAccount] = await Promise.all([
      db.select().from(users).where(and(
        eq(users.id, req.user.userId),
        eq(users.contractorId, req.user.contractorId)
      )),
      storage.getSharedEmailAccount(req.user.contractorId),
    ]);
    const user = userResult[0];

    if (user?.gmailConnected && user.gmailEmail) {
      addresses.push({ email: user.gmailEmail, label: "My Gmail", type: "personal" });
    }
    if (sharedAccount) {
      addresses.push({ email: sharedAccount.email, label: sharedAccount.displayName || "Company Email", type: "shared" });
    }

    res.json(addresses);
  }));

  app.post("/api/messages/send-email", asyncHandler(async (req: AuthedRequest, res: Response) => {
    const noNewlines = (val: string) => !/[\r\n]/.test(val);
    const emailBodySchema = z.object({
      to: z.string().email({ message: "A valid recipient email address is required" })
        .refine(noNewlines, { message: "Recipient address must not contain newline characters" }),
      subject: z.string().min(1, { message: "Subject is required" })
        .refine(noNewlines, { message: "Subject must not contain newline characters" }),
      content: z.string().min(1, { message: "Email body is required" }),
      contactId: z.string().optional(),
      leadId: z.string().optional(),
      customerId: z.string().optional(),
      estimateId: z.string().optional(),
      fromAddress: z.string().email().optional()
        .refine((v) => v == null || noNewlines(v), { message: "From address must not contain newline characters" }),
    });

    const parsed = parseBody(emailBodySchema, req, res);
    if (!parsed) return;
    const { to, subject, content: rawContent, contactId, leadId, customerId, estimateId, fromAddress } = parsed;

    // Security boundary: rich-text bodies arrive as HTML from the composer.
    // Never trust client-sanitized HTML — re-sanitize to a strict allowlist
    // here before it is sent to a provider or persisted as an activity. Plain
    // text passes through unchanged.
    const content = isHtmlEmail(rawContent) ? sanitizeEmailHtml(rawContent) : rawContent;
    // Reject effectively-empty bodies — including rich-text that only contains
    // empty tags / <br> / &nbsp; (e.g. "<p><br></p>") — even if a non-browser
    // caller bypasses the client-side checks.
    if (isEmptyEmailBody(content)) {
      res.status(400).json({ message: "Email body is required" });
      return;
    }

    const resolvedContactId = contactId || leadId || customerId;

    const [userResult, contractorResult, sharedAccount] = await Promise.all([
      db.select().from(users).where(and(
        eq(users.id, req.user.userId),
        eq(users.contractorId, req.user.contractorId)
      )),
      db.select().from(contractors).where(eq(contractors.id, req.user.contractorId)),
      storage.getSharedEmailAccount(req.user.contractorId),
    ]);
    const user = userResult[0];
    const contractor = contractorResult[0];

    let refreshToken: string;
    let fromEmail: string | undefined;
    let fromName: string;

    const useShared = sharedAccount && fromAddress && fromAddress === sharedAccount.email;

    if (useShared) {
      refreshToken = sharedAccount.gmailRefreshToken;
      fromEmail = sharedAccount.email;
      fromName = sharedAccount.displayName || contractor?.name || "Company";
    } else if (user?.gmailConnected && user.gmailRefreshToken) {
      refreshToken = user.gmailRefreshToken;
      fromEmail = user.gmailEmail || undefined;
      fromName = contractor?.name ? `${user.name} @ ${contractor.name}` : user.name;
    } else if (sharedAccount) {
      refreshToken = sharedAccount.gmailRefreshToken;
      fromEmail = sharedAccount.email;
      fromName = sharedAccount.displayName || contractor?.name || "Company";
    } else {
      res.status(400).json({ message: "No email sending credentials available. Please connect your Gmail account or ask an admin to set up a shared company email." });
      return;
    }

    const emailResponse = await gmailService.sendEmail({
      to,
      subject,
      content,
      fromEmail,
      fromName,
      refreshToken,
    });

    if (emailResponse.success) {
      const emailMetadata = {
        subject,
        to: [to],
        from: fromEmail || user?.gmailEmail || '',
        messageId: emailResponse.messageId,
        direction: 'outbound',
      };

      const activity = await storage.createActivity({
        type: 'email',
        title: `Email sent: ${subject}`,
        content,
        metadata: emailMetadata,
        contactId: resolvedContactId || null,
        estimateId: estimateId || null,
        userId: req.user.userId,
        externalId: emailResponse.messageId || null,
        externalSource: 'gmail',
      }, req.user.contractorId);

      if (resolvedContactId) {
        await storage.markContactContacted(resolvedContactId, req.user.contractorId, req.user.userId);
        await storage.markLeadContacted(resolvedContactId, req.user.contractorId, req.user.userId);
      }

      let broadcastLeadId: string | null = leadId || null;
      let broadcastCustomerId: string | null = customerId || null;
      let broadcastContactType: 'estimate' | 'customer' | 'lead' = 'lead';

      if (estimateId) {
        broadcastContactType = 'estimate';
      } else if (customerId) {
        broadcastCustomerId = customerId;
        broadcastContactType = 'customer';
      } else if (leadId) {
        broadcastLeadId = leadId;
        broadcastContactType = 'lead';
      } else if (contactId && resolvedContactId) {
        const resolvedContact = await storage.getContact(resolvedContactId, req.user.contractorId);
        if (resolvedContact?.type === 'customer') {
          broadcastCustomerId = resolvedContactId;
          broadcastContactType = 'customer';
        } else {
          broadcastLeadId = resolvedContactId;
          broadcastContactType = 'lead';
        }
      }

      broadcastToContractor(req.user.contractorId, {
        type: 'new_message',
        message: {
          id: activity.id,
          type: 'email' as const,
          status: 'sent' as const,
          direction: emailMetadata.direction as 'outbound',
          content: activity.content || content,
          toNumber: emailMetadata.to[0],
          fromNumber: emailMetadata.from,
          contactId: activity.contactId || null,
          leadId: broadcastLeadId,
          customerId: broadcastCustomerId,
          estimateId: activity.estimateId || null,
          userId: activity.userId || null,
          externalMessageId: emailMetadata.messageId || null,
          contractorId: activity.contractorId,
          createdAt: activity.createdAt,
          userName: user.name,
        },
        contactId: resolvedContactId || estimateId || null,
        contactType: broadcastContactType
      });

      res.json({
        success: true,
        messageId: emailResponse.messageId,
        message: "Email sent successfully"
      });
    } else {
      res.status(500).json({
        success: false,
        error: emailResponse.error,
        message: "Failed to send email"
      });
    }
  }));

  app.post("/api/calls/initiate", asyncHandler(async (req: AuthedRequest, res: Response) => {
    const callBodySchema = z.object({
      toNumber: z.string().min(1, { message: "Destination phone number is required" }),
      fromNumber: z.string().optional(),
      autoRecord: z.boolean().optional(),
      contactId: z.string().optional(),
      customerId: z.string().optional(),
      leadId: z.string().optional(),
    });

    const parsed = parseBody(callBodySchema, req, res);
    if (!parsed) return;
    const { toNumber, fromNumber, autoRecord, contactId, customerId, leadId } = parsed;
    const resolvedContactId = contactId || leadId || customerId;

    const callResponse = await providerService.initiateCall({
      to: toNumber,
      fromNumber: fromNumber || undefined,
      autoRecord: autoRecord || false,
      contractorId: req.user.contractorId,
      userId: req.user.userId
    });

    log.info('Call response:', callResponse);

    if (callResponse.success && callResponse.callId) {
      if (resolvedContactId) {
        await storage.markContactContacted(resolvedContactId, req.user.contractorId, req.user.userId);
        await storage.markLeadContacted(resolvedContactId, req.user.contractorId, req.user.userId);
      }

      // For Twilio, stamp the call identity (external_source/external_id) on the
      // top-level columns so the Twilio status + recording webhooks find and
      // enrich THIS contact-linked activity (looked up by external_source =
      // 'twilio' AND external_id = <CallSid>) instead of creating an orphaned
      // duplicate row with no contact attached. The parent-leg Call SID
      // returned here is the same SID Twilio reports on the bridged call's
      // status and recording callbacks, so the lookups line up. Only do this
      // for Twilio so non-Twilio (e.g. Dialpad) calls are unaffected.
      const isTwilioCall = callResponse.provider === 'twilio' && !!callResponse.callId;

      await storage.createActivity({
        type: 'call',
        title: 'Phone call initiated',
        content: `Call initiated to ${toNumber}${fromNumber ? ` from ${fromNumber}` : ''}`,
        contactId: resolvedContactId || null,
        userId: req.user.userId,
        ...(isTwilioCall
          ? { externalSource: 'twilio', externalId: callResponse.callId }
          : {}),
        metadata: {
          // Stamp direction so the Speed-to-Lead report (which filters on
          // metadata.direction = 'outbound') counts manually-initiated calls.
          direction: 'outbound',
          externalCallId: callResponse.callId,
          callUrl: callResponse.callUrl || null,
          autoRecord: autoRecord || false,
        },
      } as any, req.user.contractorId);

      res.json({
        success: true,
        callId: callResponse.callId,
        callUrl: callResponse.callUrl
      });
    } else {
      log.error('Call initiation failed:', callResponse.error);
      const code = callResponse.errorCode ?? 'unknown';
      const retryAfterSeconds = callResponse.retryAfterSeconds ?? 5;
      // Use 502 for all upstream Dialpad failures so the global 429 RateLimit
      // handler in queryClient.ts does not swallow our parsed error body. The
      // specific machine-readable cause is conveyed via the `code` field.
      res.status(502).json({
        success: false,
        error: callResponse.error,
        code,
        retryAfterSeconds,
      });
    }
  }));

  app.get("/api/messages/all", asyncHandler(async (req, res) => {
    const { type, status, search, limit, offset } = req.query;
    const parsedLimit = limit !== undefined ? parseIntParam(limit as string | undefined, 50) : undefined;
    if (parsedLimit === null) {
      res.status(400).json({ message: "Invalid 'limit' parameter: must be a number" });
      return;
    }
    const parsedOffset = offset !== undefined ? parseIntParam(offset as string | undefined, 0) : undefined;
    if (parsedOffset === null) {
      res.status(400).json({ message: "Invalid 'offset' parameter: must be a number" });
      return;
    }
    const options = {
      type: type as 'text' | 'email' | undefined,
      status: status as 'sent' | 'delivered' | 'failed' | undefined,
      search: search as string | undefined,
      limit: parsedLimit,
      offset: parsedOffset,
    };

    const messages = await storage.getAllMessages(req.user.contractorId, options);
    res.json(messages);
  }));

  app.post("/api/messages/unread-counts", asyncHandler(async (req: AuthedRequest, res: Response) => {
    const schema = z.object({ contactIds: z.array(z.string()).max(200) });
    const parsed = parseBody(schema, req, res);
    if (!parsed) return;
    const counts = await storage.getUnreadCountsByContactIds(req.user.contractorId, parsed.contactIds);
    res.json(counts);
  }));

  app.get("/api/messages/unread-count", asyncHandler(async (req, res) => {
    const unreadCount = await storage.getUnreadMessageCount(req.user.contractorId);
    res.json({ unreadCount });
  }));

  app.get("/api/messages/unread-summary", asyncHandler(async (req: AuthedRequest, res: Response) => {
    const summary = await storage.getUnreadMessageSummary(req.user.contractorId);
    res.json(summary);
  }));

  app.post("/api/conversations/:contactId/read", asyncHandler(async (req: AuthedRequest, res: Response) => {
    const { contactId } = req.params;
    const rawType = req.body?.type;
    const messageType = (rawType === 'text' || rawType === 'email') ? rawType : undefined;
    const markedCount = await storage.markConversationRead(req.user.contractorId, contactId, messageType);

    broadcastToContractor(req.user.contractorId, {
      type: 'messages_read',
      contactId,
    });

    res.json({ markedCount });
  }));

  app.get("/api/conversations", asyncHandler(async (req, res) => {
    const { search, type, status, dateFrom, dateTo, unreadOnly } = req.query;
    const parsedDateFrom = dateFrom ? new Date(dateFrom as string) : undefined;
    const parsedDateTo = dateTo ? new Date(dateTo as string) : undefined;
    const options = {
      search: search as string | undefined,
      type: type as 'text' | 'email' | undefined,
      status: status as 'sent' | 'delivered' | 'failed' | undefined,
      dateFrom: parsedDateFrom && !isNaN(parsedDateFrom.getTime()) ? parsedDateFrom : undefined,
      dateTo: parsedDateTo && !isNaN(parsedDateTo.getTime()) ? parsedDateTo : undefined,
      unreadOnly: unreadOnly === 'true',
    };

    const conversations = await storage.getConversations(req.user.contractorId, options);
    res.json(conversations);
  }));

  app.get("/api/conversations/:contactId", asyncHandler(async (req, res) => {
    const { contactId } = req.params;
    const messages = await storage.getConversationMessages(req.user.contractorId, contactId);
    res.json(messages);
  }));

  app.get("/api/conversations/:contactId/:contactType", asyncHandler(async (req, res) => {
    const { contactId, contactType } = req.params;

    if (contactType !== 'lead' && contactType !== 'customer' && contactType !== 'estimate') {
      res.status(400).json({ message: "Contact type must be 'lead', 'customer', or 'estimate'" });
      return;
    }

    const messages = await storage.getConversationMessages(req.user.contractorId, contactId);
    res.json(messages);
  }));

  app.get("/api/conversations/:contactId/:contactType/count", asyncHandler(async (req, res) => {
    const { contactId, contactType } = req.params;

    if (contactType !== 'lead' && contactType !== 'customer' && contactType !== 'estimate') {
      res.status(400).json({ message: "Contact type must be 'lead', 'customer', or 'estimate'" });
      return;
    }

    const count = await storage.getConversationMessageCount(req.user.contractorId, contactId);
    res.json({ count });
  }));

  app.post("/api/calls/log-personal", asyncHandler(async (req: AuthedRequest, res: Response) => {
    const logPersonalCallSchema = z.object({
      phone: z.string().min(1, { message: "phone is required" }),
      contactId: z.string().optional(),
      name: z.string().optional(),
    });
    const parsed = parseBody(logPersonalCallSchema, req, res);
    if (!parsed) return;
    const { phone, contactId, name } = parsed;
    const label = name ? `${name} (${phone})` : phone;
    await storage.createActivity({
      userId: req.user.userId,
      contactId: contactId || null,
      type: "call",
      content: `Outbound call to ${label} via personal phone`,
      // Stamp direction so the Speed-to-Lead report (which filters on
      // metadata.direction = 'outbound') counts personal-phone calls.
      metadata: { direction: 'outbound' },
    }, req.user.contractorId);
    if (contactId) {
      await storage.markContactContacted(contactId, req.user.contractorId, req.user.userId);
      await storage.markLeadContacted(contactId, req.user.contractorId, req.user.userId);
    }
    res.json({ success: true });
  }));

  app.post("/api/messages/log-personal-sms", asyncHandler(async (req: AuthedRequest, res: Response) => {
    const logPersonalSmsSchema = z.object({
      phone: z.string().min(1, { message: "phone is required" }),
      contactId: z.string().optional(),
      estimateId: z.string().optional(),
      name: z.string().optional(),
    });
    const parsed = parseBody(logPersonalSmsSchema, req, res);
    if (!parsed) return;
    const { phone, contactId, estimateId, name } = parsed;
    const label = name ? `${name} (${phone})` : phone;
    await storage.createActivity({
      userId: req.user.userId,
      contactId: contactId || null,
      estimateId: estimateId || null,
      type: "sms",
      content: `Outbound text to ${label} via personal phone`,
    }, req.user.contractorId);
    if (contactId) {
      await storage.markContactContacted(contactId, req.user.contractorId, req.user.userId);
      await storage.markLeadContacted(contactId, req.user.contractorId, req.user.userId);
    }
    res.json({ success: true });
  }));

  app.get("/api/providers", asyncHandler(async (req, res) => {
    const tenantProviders = await storage.getTenantProviders(req.user.contractorId);
    const availableProviders = {
      email: providerService.getAvailableProviders('email'),
      sms: providerService.getAvailableProviders('sms'),
      calling: providerService.getAvailableProviders('calling')
    };
    res.json({ available: availableProviders, configured: tenantProviders });
  }));

  app.post("/api/providers", requireIntegrationManager, asyncHandler(async (req, res) => {
    const { providerType, providerName } = req.body;
    if (!providerType || !providerName) {
      res.status(400).json({ message: "Provider type and name are required" });
      return;
    }
    if (!['email', 'sms', 'calling'].includes(providerType)) {
      res.status(400).json({ message: "Invalid provider type" });
      return;
    }
    const result = await providerService.setTenantProvider(req.user.contractorId, providerType as 'email' | 'sms' | 'calling', providerName);
    if (result.success) {
      res.json({ success: true, message: `${providerType} provider set to ${providerName}` });
    } else {
      res.status(400).json({ success: false, error: result.error });
    }
  }));
}
