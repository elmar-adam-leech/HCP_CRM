import type { Express, Request, Response } from "express";
import express from "express";
import { storage } from "../../storage";
import { activities } from "@shared/schema";
import { db } from "../../db";
import { eq, and } from "drizzle-orm";
import { webhookRateLimiter } from "../../middleware/rate-limiter";
import { normalizePhoneNumber, maskPhone } from "../../utils/phone-normalizer";
import { asyncHandler } from "../../utils/async-handler";
import { logger } from "../../utils/logger";
import { broadcastToContractor } from "../../websocket";
import { getTwilioCredentials } from "../../twilio/client";
import {
  validateTwilioSignature,
  buildBridgeDialTwiml,
  buildInboundTwiml,
  emptyTwiml,
} from "../../twilio/utils";
import { getPublicBaseUrl } from "../../utils/public-base-url";

const log = logger('TwilioWebhook');

const TWIML_HEADERS = { 'Content-Type': 'text/xml' };

/**
 * Verify an inbound Twilio request using its X-Twilio-Signature header.
 * Twilio signs the EXACT public URL it posted to (including query string) plus
 * the sorted POST body params, HMAC-SHA1 with the account auth token. We
 * reconstruct the public URL from the configured base + req.originalUrl.
 */
async function verifyTwilioRequest(req: Request, contractorId: string): Promise<boolean> {
  try {
    const creds = await getTwilioCredentials(contractorId);
    const base = getPublicBaseUrl();
    if (!base) return false;
    const url = `${base}${req.originalUrl}`;
    const params: Record<string, string> = {};
    if (req.body && typeof req.body === 'object') {
      for (const [k, v] of Object.entries(req.body)) {
        if (typeof v === 'string') params[k] = v;
      }
    }
    return validateTwilioSignature(creds.authToken, req.header('X-Twilio-Signature'), url, params);
  } catch (err) {
    log.warn(`Twilio signature verification failed for contractor ${contractorId}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** Resolve the contact for a given external phone number (best-effort match). */
async function matchContact(phone: string, contractorId: string) {
  const normalized = normalizePhoneNumber(phone);
  let contact = normalized ? await storage.getContactByPhone(normalized, contractorId) : undefined;
  if (!contact && phone) contact = await storage.getContactByPhone(phone, contractorId);
  return contact;
}

/** Map a Twilio CallStatus to a human outcome label. */
function deriveCallOutcome(status: string | undefined): 'answered' | 'missed' | 'voicemail' {
  switch ((status || '').toLowerCase()) {
    case 'completed':
      return 'answered';
    case 'no-answer':
    case 'busy':
    case 'failed':
    case 'canceled':
      return 'missed';
    default:
      return 'missed';
  }
}

export function registerTwilioWebhookRoutes(app: Express): void {
  const form = express.urlencoded({ extended: false });

  // ---- Outbound bridge: rep answered; dial the customer to connect legs ----
  app.post(
    "/api/webhooks/twilio/voice/bridge/:tenantId",
    webhookRateLimiter,
    form,
    asyncHandler(async (req: Request, res: Response) => {
      const contractorId = req.params.tenantId;
      if (!(await verifyTwilioRequest(req, contractorId))) {
        res.status(403).type('text/xml').send(emptyTwiml());
        return;
      }

      const customer = String(req.query.to || '');
      const callerId = String(req.query.callerId || '');
      const record = String(req.query.record || '0') === '1';

      if (!customer || !callerId) {
        log.error(`Bridge webhook missing params for contractor ${contractorId}`);
        res.status(200).type('text/xml').send(emptyTwiml());
        return;
      }

      const base = getPublicBaseUrl();
      let recordingCallbackUrl: string | undefined;
      if (base) {
        // Carry the real customer number onto the recording callback. This leg
        // dials the customer, so the bridge handler already knows it; passing
        // it through lets the recording webhook display/match the true customer
        // even when no originating activity exists. The query string is part of
        // the URL Twilio signs, so this keeps signature validation intact.
        const recUrl = new URL(`${base}/api/webhooks/twilio/voice/recording/${encodeURIComponent(contractorId)}`);
        recUrl.searchParams.set('customer', customer);
        recordingCallbackUrl = recUrl.toString();
      }

      const twiml = buildBridgeDialTwiml({
        customerNumber: customer,
        callerId,
        record,
        recordingCallbackUrl,
        consentMessage: record
          ? 'This call may be recorded for quality and training purposes.'
          : undefined,
      });
      res.set(TWIML_HEADERS).status(200).send(twiml);
    }),
  );

  // ---- Inbound voice: ring a rep, fall back to voicemail ----
  app.post(
    "/api/webhooks/twilio/voice/incoming/:tenantId",
    webhookRateLimiter,
    form,
    asyncHandler(async (req: Request, res: Response) => {
      const contractorId = req.params.tenantId;
      if (!(await verifyTwilioRequest(req, contractorId))) {
        res.status(403).type('text/xml').send(emptyTwiml());
        return;
      }

      const contractor = await storage.getContractor(contractorId);
      const record = !!contractor?.twilioRecordCalls;

      // Find a rep phone to ring (first user with a configured "phone to ring").
      let forwardTo: string | undefined;
      try {
        const users = await storage.getContractorUsers(contractorId);
        const withPhone = users.find((u) => !!u.twilioPhoneToRing);
        if (withPhone?.twilioPhoneToRing) forwardTo = normalizePhoneNumber(withPhone.twilioPhoneToRing);
      } catch { /* fall through to voicemail */ }

      const base = getPublicBaseUrl();
      const recordingCallbackUrl = base
        ? `${base}/api/webhooks/twilio/voice/recording/${encodeURIComponent(contractorId)}`
        : undefined;

      const twiml = buildInboundTwiml({
        forwardTo,
        record,
        recordingCallbackUrl,
        consentMessage: record ? 'This call may be recorded for quality and training purposes.' : undefined,
        voicemailMessage: 'Please leave a message after the tone.',
        voicemailCallbackUrl: recordingCallbackUrl,
      });
      res.set(TWIML_HEADERS).status(200).send(twiml);
    }),
  );

  // ---- Call status callback: create/update the call activity ----
  app.post(
    "/api/webhooks/twilio/voice/status/:tenantId",
    webhookRateLimiter,
    form,
    asyncHandler(async (req: Request, res: Response) => {
      const contractorId = req.params.tenantId;
      if (!(await verifyTwilioRequest(req, contractorId))) {
        res.status(403).send('forbidden');
        return;
      }

      const callSid = String(req.body.CallSid || '');
      const direction = String(req.body.Direction || '');
      const callStatus = String(req.body.CallStatus || '');
      const from = String(req.body.From || '');
      const to = String(req.body.To || '');
      const durationStr = String(req.body.CallDuration || '');

      if (!callSid) { res.status(200).send(emptyTwiml()); return; }

      // Twilio "Direction": "inbound" for inbound; "outbound-api"/"outbound-dial" for ours.
      const isInbound = direction.toLowerCase().startsWith('inbound');
      // Bridge model: for OUTBOUND calls the leg's `To` is the REP's phone, not
      // the customer. The true customer number is passed on the callback URL
      // (?customer=...). Never treat the rep's leg `To` as the customer.
      const customerFromUrl = String(req.query.customer || '');
      const customerNumber = isInbound ? from : (customerFromUrl || to);
      const outcome = deriveCallOutcome(callStatus);

      const existing = await db.select().from(activities)
        .where(and(eq(activities.externalSource, 'twilio'), eq(activities.externalId, callSid)))
        .limit(1);

      // Only derive a contact when there is no existing activity row, and only
      // against the TRUE customer number (inbound caller, or the customer passed
      // on the callback URL). When the originating "Phone call initiated"
      // activity already exists it carries the correct customer link, which we
      // must preserve — never re-derive it from the rep's leg.
      const contact = existing[0] ? undefined : await matchContact(customerNumber, contractorId);

      const dirLabel = isInbound ? 'Inbound' : 'Outbound';
      const outcomeLabel = outcome === 'answered' ? '' : ` — ${outcome}`;
      const title = `${dirLabel} call${outcomeLabel}`;
      const durationNote = durationStr ? ` (${durationStr}s)` : '';
      const content = `${dirLabel} Twilio call with ${maskPhone(customerNumber)}${durationNote}`;

      const metadata: Record<string, any> = {
        provider: 'twilio',
        call_sid: callSid,
        direction: isInbound ? 'inbound' : 'outbound',
        outcome,
        from_number: from,
        // For outbound the leg's `to` is the rep; record the real customer.
        to_number: isInbound ? to : customerNumber,
        duration_seconds: durationStr ? Number(durationStr) : undefined,
      };

      if (existing[0]) {
        await db.update(activities)
          .set({
            title,
            content,
            // Preserve the existing customer link; do not overwrite it with a
            // contact derived from the rep's leg.
            contactId: existing[0].contactId,
            metadata: { ...(existing[0].metadata as object || {}), ...metadata },
            updatedAt: new Date(),
          })
          .where(eq(activities.id, existing[0].id));
      } else {
        await storage.createActivity(
          {
            type: 'call',
            title,
            content,
            contactId: contact?.id,
            externalSource: 'twilio',
            externalId: callSid,
            metadata,
          } as any,
          contractorId,
        );
      }

      const broadcastContactId = existing[0]?.contactId ?? contact?.id;
      if (broadcastContactId) {
        broadcastToContractor(contractorId, { type: 'new_activity', contactId: broadcastContactId });
      }
      res.status(200).send(emptyTwiml());
    }),
  );

  // ---- Recording status callback: enrich the call activity ----
  app.post(
    "/api/webhooks/twilio/voice/recording/:tenantId",
    webhookRateLimiter,
    form,
    asyncHandler(async (req: Request, res: Response) => {
      const contractorId = req.params.tenantId;
      if (!(await verifyTwilioRequest(req, contractorId))) {
        res.status(403).send('forbidden');
        return;
      }

      const callSid = String(req.body.CallSid || '');
      const recordingSid = String(req.body.RecordingSid || '');
      const recordingUrl = String(req.body.RecordingUrl || '');
      const durationStr = String(req.body.RecordingDuration || '');

      if (!callSid || !recordingSid) { res.status(200).send(emptyTwiml()); return; }

      const base = getPublicBaseUrl();
      const playbackUrl = base
        ? `${base}/api/twilio/recordings/${encodeURIComponent(recordingSid)}`
        : `/api/twilio/recordings/${encodeURIComponent(recordingSid)}`;

      const recordingDetail = {
        id: recordingSid,
        url: playbackUrl,
        source_url: recordingUrl || undefined,
        duration_seconds: durationStr ? Number(durationStr) : undefined,
      };

      const existing = await db.select().from(activities)
        .where(and(eq(activities.externalSource, 'twilio'), eq(activities.externalId, callSid)))
        .limit(1);

      if (existing[0]) {
        const prevMeta = (existing[0].metadata as Record<string, any>) || {};
        const prevDetails = Array.isArray(prevMeta.recording_details) ? prevMeta.recording_details : [];
        await db.update(activities)
          .set({
            metadata: {
              ...prevMeta,
              recording_url: playbackUrl,
              recording_sid: recordingSid,
              recording_playable: true,
              recording_details: [...prevDetails.filter((d: any) => d?.id !== recordingSid), recordingDetail],
            },
            updatedAt: new Date(),
          })
          .where(eq(activities.id, existing[0].id));
      } else {
        // Recording arrived before/without a status activity (e.g. voicemail).
        // Best-effort match against the true customer number when one was passed
        // on the callback URL (outbound bridge); inbound voicemail carries no
        // such param, so it stays unmatched here exactly as before.
        const customerFromUrl = String(req.query.customer || '');
        const contact = customerFromUrl
          ? await matchContact(customerFromUrl, contractorId)
          : undefined;
        await storage.createActivity(
          {
            type: 'call',
            title: 'Inbound call — voicemail',
            content: 'Voicemail recording received via Twilio.',
            contactId: contact?.id,
            externalSource: 'twilio',
            externalId: callSid,
            metadata: {
              provider: 'twilio',
              call_sid: callSid,
              recording_url: playbackUrl,
              recording_sid: recordingSid,
              recording_playable: true,
              recording_details: [recordingDetail],
            },
          } as any,
          contractorId,
        );
      }
      res.status(200).send(emptyTwiml());
    }),
  );

  // ---- Inbound SMS ----
  app.post(
    "/api/webhooks/twilio/sms/:tenantId",
    webhookRateLimiter,
    form,
    asyncHandler(async (req: Request, res: Response) => {
      const contractorId = req.params.tenantId;

      const from = String(req.body.From || '');
      const to = String(req.body.To || '');
      const messageSid = String(req.body.MessageSid || req.body.SmsSid || '');
      const numMedia = Number(req.body.NumMedia || '0');

      log.info(
        `[inbound-sms] received provider=twilio contractor=${contractorId} sid=${messageSid || 'none'} from=${maskPhone(from)} to=${maskPhone(to)} numMedia=${numMedia}`,
      );

      if (!(await verifyTwilioRequest(req, contractorId))) {
        log.warn(
          `[inbound-sms] signature verification FAILED provider=twilio contractor=${contractorId} sid=${messageSid || 'none'} from=${maskPhone(from)} — rejecting 403`,
        );
        res.status(403).type('text/xml').send(emptyTwiml());
        return;
      }

      let body = String(req.body.Body || '');

      if (numMedia > 0) {
        const mediaUrls: string[] = [];
        for (let i = 0; i < numMedia; i++) {
          const u = req.body[`MediaUrl${i}`];
          if (typeof u === 'string') mediaUrls.push(u);
        }
        if (mediaUrls.length) body = [body, ...mediaUrls].filter(Boolean).join('\n');
      }

      const contact = await matchContact(from, contractorId);
      log.info(
        `[inbound-sms] contact-match provider=twilio contractor=${contractorId} sid=${messageSid || 'none'} matched=${contact ? `yes (${contact.id})` : 'no'}`,
      );

      const message = await storage.createMessage(
        {
          type: 'text',
          status: 'delivered',
          direction: 'inbound',
          content: body || '(no content)',
          toNumber: to,
          fromNumber: from,
          contactId: contact?.id,
          externalMessageId: messageSid || undefined,
        } as any,
        contractorId,
      );

      log.info(
        `[inbound-sms] saved provider=twilio contractor=${contractorId} sid=${messageSid || 'none'} messageId=${message.id} contactId=${contact?.id ?? 'unmatched'}`,
      );

      broadcastToContractor(contractorId, {
        type: 'new_message',
        message,
        contactId: contact?.id,
      });

      res.set(TWIML_HEADERS).status(200).send(emptyTwiml());
    }),
  );
}
