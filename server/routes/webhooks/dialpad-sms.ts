import type { Express, Request, Response } from "express";
import express from "express";
import { storage } from "../../storage";
import { webhookEvents, dialpadPhoneNumbers, messages } from "@shared/schema";
import { db } from "../../db";
import { eq, and, sql, ne } from "drizzle-orm";
import { dialpadEnhancedService } from "../../dialpad";
import { webhookRateLimiter } from "../../middleware/rate-limiter";
import { normalizePhoneNumber, normalizePhoneForStorage, maskPhone } from "../../utils/phone-normalizer";
import { asyncHandler } from "../../utils/async-handler";
import { logger } from "../../utils/logger";
import { broadcastToContractor } from "../../websocket";
import { CredentialService } from "../../credential-service";
import { validateWebhookAuth } from "../../utils/webhook-auth";
import { enqueueDialpadEvent } from "../../jobs/dialpad-event-worker";

const log = logger('DialpadSmsWebhook');

/**
 * Fallback: read the plaintext webhook_api_key directly from the contractors table.
 * This is only called when CredentialService has no key yet, which means the
 * startup migration is still in progress (e.g. a per-row failure). Returns null
 * if the column no longer exists (post-migration) or the tenant has no key.
 */
async function getPlaintextWebhookApiKey(tenantId: string): Promise<string | null> {
  try {
    const result = await db.execute(
      sql`SELECT webhook_api_key FROM contractors WHERE id = ${tenantId} LIMIT 1`
    );
    const rows = result.rows as Array<{ webhook_api_key: string | null }>;
    return rows[0]?.webhook_api_key ?? null;
  } catch {
    return null;
  }
}

/**
 * Dialpad-specific key resolver for validateWebhookAuth.
 *
 * Dialpad's webhook API key is stored under ('dialpad', 'webhook_api_key') in
 * CredentialService — a different path than the generic webhook key used by
 * all other webhooks ('webhook', 'api_key'). This resolver handles that lookup
 * plus the plaintext-column fallback for tenants still mid-migration.
 */
async function dialpadKeyResolver(contractorId: string): Promise<string | null> {
  let storedApiKey: string | null;
  try {
    storedApiKey = await CredentialService.getCredential(contractorId, 'dialpad', 'webhook_api_key');
  } catch {
    storedApiKey = null;
  }
  return storedApiKey ?? getPlaintextWebhookApiKey(contractorId);
}

export interface DialpadSmsPayload {
  text?: string;
  from_number: string;
  to_number: string | string[];
  message_id?: string;
  sms_id?: string;
  id?: string;
  timestamp?: string | number;
  state?: string;
  delivery_state?: string;
  error_code?: number | null;
  [key: string]: unknown;
}

/**
 * Extract media URLs from a Dialpad SMS/MMS payload. Some MMS attachments
 * arrive in a follow-up webhook for the same `message_id` (the image is
 * uploaded after the initial text event). We use this list both for new
 * messages and for enriching an existing one.
 */
function extractMediaUrls(p: Record<string, unknown>): string[] {
  const out: string[] = [];
  const collect = (v: unknown): void => {
    if (!v) return;
    if (typeof v === 'string') {
      if (/^https?:\/\//i.test(v)) out.push(v);
    } else if (Array.isArray(v)) {
      for (const item of v) collect(item);
    } else if (typeof v === 'object') {
      const obj = v as Record<string, unknown>;
      if (typeof obj.url === 'string') collect(obj.url);
      else if (typeof obj.media_url === 'string') collect(obj.media_url);
    }
  };
  const fields = [
    'media_url', 'media_urls', 'media',
    'attachments', 'mms_attachments',
    'image_url', 'image_urls', 'images',
    'file_url', 'file_urls', 'files',
  ];
  for (const f of fields) collect(p[f]);
  return out;
}

/**
 * Background processing for an SMS delivery-failure event.
 */
export async function processSmsDeliveryFailure(
  payload: DialpadSmsPayload,
  contractorId: string,
  webhookEventId: string,
): Promise<void> {
  const failedExternalId: string | undefined =
    payload.sms_id || payload.message_id || payload.id;
  const deliveryState = payload.state ?? payload.delivery_state;

  log.info(`Processing delivery-failure event (state=${deliveryState}, error_code=${payload.error_code}) for external id=${failedExternalId}`);

  if (failedExternalId) {
    const updated = await db.update(messages)
      .set({ status: 'failed' })
      .where(and(
        eq(messages.contractorId, contractorId),
        eq(messages.externalMessageId, failedExternalId),
        ne(messages.status, 'failed'),
      ))
      .returning();

    if (updated.length > 0) {
      log.info(`Marked message ${updated[0].id} as failed (external id=${failedExternalId})`);
    } else {
      log.info(`No message found for external id=${failedExternalId}; skipping`);
    }
  } else {
    log.info('Delivery-failure event has no external message id; skipping update');
  }

  await db.update(webhookEvents)
    .set({ processed: true, processedAt: new Date() })
    .where(eq(webhookEvents.id, webhookEventId));
}

/**
 * Background processing for an inbound/outbound SMS message event.
 */
export async function processSmsMessageEvent(
  payload: DialpadSmsPayload,
  contractorId: string,
  webhookEventId: string,
): Promise<void> {
  const {
    text: webhookText,
    from_number: fromNumber,
    to_number: toNumberRaw,
    message_id: messageId,
    sms_id: smsId,
    id: dialpadMessageId,
    timestamp,
  } = payload;

  const externalMessageId = smsId || messageId || dialpadMessageId;
  const toNumber = Array.isArray(toNumberRaw) ? toNumberRaw[0] : toNumberRaw;

  const normalizedFromNumber = normalizePhoneNumber(fromNumber);

  const dialpadNumbers = await db.select()
    .from(dialpadPhoneNumbers)
    .where(eq(dialpadPhoneNumbers.contractorId, contractorId));

  const isFromOurNumber = dialpadNumbers.some(dpn => {
    const normalizedDialpadNumber = normalizePhoneNumber(dpn.phoneNumber);
    return normalizedDialpadNumber === normalizedFromNumber || dpn.phoneNumber === fromNumber;
  });

  const direction = isFromOurNumber ? 'outbound' : 'inbound';

  if (externalMessageId) {
    const existingMessage = await db.select()
      .from(messages)
      .where(and(
        eq(messages.externalMessageId, externalMessageId),
        eq(messages.contractorId, contractorId)
      ))
      .limit(1);

    if (existingMessage && existingMessage.length > 0) {
      // Enrich-on-newer-event for MMS attachments arriving in a follow-up.
      const existing = existingMessage[0];
      const followUpMediaUrls = extractMediaUrls(payload as Record<string, unknown>);
      const missingMedia = followUpMediaUrls.filter(url => !existing.content.includes(url));

      if (missingMedia.length > 0) {
        const enrichedContent = `${existing.content}\n${missingMedia.join('\n')}`;
        await db.update(messages)
          .set({ content: enrichedContent })
          .where(eq(messages.id, existing.id));

        await db.update(webhookEvents)
          .set({
            processed: true,
            processedAt: new Date(),
            errorMessage: `enriched existing message ${existing.id} with ${missingMedia.length} media url(s)`,
          })
          .where(eq(webhookEvents.id, webhookEventId));

        const updated = await storage.getMessage(existing.id, contractorId);
        if (updated) {
          broadcastToContractor(contractorId, {
            type: 'message_updated',
            message: updated,
            contactId: updated.contactId,
          });
        }

        log.info(`Enriched existing message ${existing.id} for external_message_id=${externalMessageId} with ${missingMedia.length} media URL(s)`);
        return;
      }

      await db.update(webhookEvents)
        .set({
          processed: true,
          processedAt: new Date(),
          errorMessage: 'Skipped: Duplicate message (external_message_id already exists, no new media)'
        })
        .where(eq(webhookEvents.id, webhookEventId));

      log.info('Skipping duplicate message with external_message_id:', externalMessageId);
      return;
    }
  }

  if (timestamp && webhookText) {
    const messageTimestamp = new Date(timestamp);
    const oneSecondBefore = new Date(messageTimestamp.getTime() - 1000);
    const oneSecondAfter = new Date(messageTimestamp.getTime() + 1000);

    const duplicateByContent = await db.select()
      .from(messages)
      .where(and(
        eq(messages.contractorId, contractorId),
        eq(messages.fromNumber, fromNumber),
        eq(messages.toNumber, toNumber),
        eq(messages.content, webhookText),
        sql`${messages.createdAt} >= ${oneSecondBefore}`,
        sql`${messages.createdAt} <= ${oneSecondAfter}`
      ))
      .limit(1);

    if (duplicateByContent && duplicateByContent.length > 0) {
      await db.update(webhookEvents)
        .set({
          processed: true,
          processedAt: new Date(),
          errorMessage: 'Skipped: Duplicate message (same timestamp, numbers, and content)'
        })
        .where(eq(webhookEvents.id, webhookEventId));

      log.info('Skipping duplicate message based on timestamp+content match');
      return;
    }
  }

  // -----------------------------------------------------------
  // MMS / media extraction
  // -----------------------------------------------------------
  const mediaFieldsFound: string[] = [];
  const mediaUrls: string[] = [];

  const collectUrl = (val: unknown) => {
    if (!val) return;
    if (typeof val === 'string') {
      if (/^https?:\/\//i.test(val)) mediaUrls.push(val);
    } else if (Array.isArray(val)) {
      for (const item of val) collectUrl(item);
    } else if (typeof val === 'object') {
      const obj = val as Record<string, unknown>;
      if (typeof obj.url === 'string') collectUrl(obj.url);
      else if (typeof obj.media_url === 'string') collectUrl(obj.media_url);
    }
  };

  const mediaCandidateFields = [
    'media_url', 'media_urls', 'media',
    'attachments', 'mms_attachments',
    'image_url', 'image_urls', 'images',
    'file_url', 'file_urls', 'files',
  ];
  for (const field of mediaCandidateFields) {
    if (payload[field] !== undefined && payload[field] !== null) {
      mediaFieldsFound.push(field);
      collectUrl(payload[field]);
    }
  }

  if (mediaFieldsFound.length > 0) {
    log.info(`Dialpad MMS media fields detected: ${mediaFieldsFound.join(', ')} (${mediaUrls.length} url(s))`);
  }

  const placeholderText = direction === 'inbound' ? '[Inbound text]' : '[Outbound text]';
  let messageText = webhookText || placeholderText;
  if (mediaUrls.length > 0) {
    const missing = mediaUrls.filter(url => !messageText.includes(url));
    if (missing.length > 0) {
      messageText = messageText === placeholderText
        ? missing.join('\n')
        : `${messageText}\n${missing.join('\n')}`;
    }
  }
  const needsContentFetch = !webhookText && mediaUrls.length === 0 && externalMessageId;

  let contactId: string | null = null;

  const contactPhoneNormalized = direction === 'inbound' ? normalizedFromNumber : normalizePhoneNumber(toNumber);
  const contactPhoneOriginal = direction === 'inbound' ? fromNumber : toNumber;

  log.info(`Looking for contact - Direction: ${direction}, From: ${maskPhone(fromNumber)}, To: ${maskPhone(toNumber)}`);
  log.info(`Contact phone normalized: ${maskPhone(contactPhoneNormalized)}, original: ${maskPhone(contactPhoneOriginal)}`);

  let contact = await storage.getContactByPhone(contactPhoneNormalized, contractorId);
  if (!contact) {
    contact = await storage.getContactByPhone(contactPhoneOriginal, contractorId);
  }

  if (contact) {
    contactId = contact.id;
    log.info(`Found contact: ${contact.id} (${contact.name}) - Type: ${contact.type}`);
  } else {
    log.info('No contact match found');
  }

  const newMessage = await storage.createMessage({
    type: 'text',
    status: 'delivered',
    direction,
    content: messageText,
    toNumber: normalizePhoneForStorage(toNumber),
    fromNumber: normalizePhoneForStorage(fromNumber),
    contactId: contactId,
    externalMessageId,
  }, contractorId);

  broadcastToContractor(contractorId, {
    type: 'new_message',
    message: newMessage,
    contactId: contactId,
    leadId: contact?.type === 'lead' ? contactId : null,
    customerId: contact?.type === 'customer' ? contactId : null,
    contactType: contact?.type === 'customer' ? 'customer' : 'lead'
  });

  await db.update(webhookEvents)
    .set({
      processed: true,
      processedAt: new Date()
    })
    .where(eq(webhookEvents.id, webhookEventId));

  log.info('Successfully processed SMS webhook');

  if (needsContentFetch) {
    const messageDbId = newMessage.id;
    log.info(`Scheduling content fetch for message ${messageDbId} (SMS ID: ${externalMessageId})`);

    setTimeout(async () => {
      try {
        log.info(`Fetching content for SMS ID: ${externalMessageId}`);
        const result = await dialpadEnhancedService.getSmsById(contractorId, externalMessageId!);

        if (result.text) {
          log.info('Fetched message content, updating database');

          await db.update(messages)
            .set({ content: result.text })
            .where(eq(messages.id, messageDbId));

          const updatedMessage = await storage.getMessage(messageDbId, contractorId);

          if (updatedMessage) {
            broadcastToContractor(contractorId, {
              type: 'message_updated',
              message: updatedMessage,
              contactId: contactId,
              leadId: contact?.type === 'lead' ? contactId : null,
              customerId: contact?.type === 'customer' ? contactId : null,
              contactType: contact?.type === 'customer' ? 'customer' : 'lead'
            });

            log.info('Successfully updated message content');
          }
        } else {
          log.error('Failed to fetch SMS content:', result.error);
        }
      } catch (error) {
        log.error('Error fetching SMS content:', error);
      }
    }, 5000);
  }
}

export function registerDialpadSmsWebhookRoutes(app: Express): void {
  app.post("/api/webhooks/dialpad/sms/:tenantId", webhookRateLimiter, express.json(), asyncHandler(async (req: Request, res: Response) => {
    try {
      const { tenantId } = req.params;
      log.info(`Received SMS webhook for tenant ${tenantId}`);

      const auth = await validateWebhookAuth(req, res, tenantId, 'dialpad-sms', {
        keyResolver: dialpadKeyResolver,
        allowQueryKey: true,
      });
      if (!auth) return;

      const contractorId = tenantId;
      const payload = req.body as DialpadSmsPayload;

      // Detect delivery-failure events vs. inbound/outbound message events.
      const deliveryState: string | undefined = payload.state ?? payload.delivery_state;
      const hasErrorCode = payload.error_code !== undefined && payload.error_code !== null && payload.error_code !== 0;
      const isDeliveryFailure =
        deliveryState === 'failed' ||
        deliveryState === 'undelivered' ||
        (hasErrorCode && deliveryState !== 'delivered');

      const eventType = isDeliveryFailure ? 'sms.status_update' : 'sms.received';

      // Insert audit row (processed: false), ack 200 immediately, then enqueue.
      const inserted = await db.insert(webhookEvents).values({
        contractorId,
        service: 'dialpad',
        eventType,
        payload: JSON.stringify(payload),
        processed: false,
      }).returning();

      const webhookEventId = inserted[0].id;

      res.status(200).json({ success: true, message: 'SMS webhook accepted for processing' });

      enqueueDialpadEvent({
        webhookEventId,
        description: `dialpad-sms ${eventType} ${webhookEventId}`,
        handler: () =>
          isDeliveryFailure
            ? processSmsDeliveryFailure(payload, contractorId, webhookEventId)
            : processSmsMessageEvent(payload, contractorId, webhookEventId),
      });
    } catch (error) {
      log.error('Error accepting SMS webhook:', error);
      if (!res.headersSent) {
        res.status(500).json({ success: false, error: 'Failed to accept SMS webhook' });
      }
    }
  }));
}
