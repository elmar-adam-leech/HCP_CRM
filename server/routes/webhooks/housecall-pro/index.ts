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

/**
 * Hard cap on the body size we will even attempt to JSON.parse in the
 * background. Anything larger gets dropped after the 200 — protects the
 * background worker from being flooded with megabyte payloads.
 */
const MAX_BODY_BYTES = 1 * 1024 * 1024; // 1 MB

export function registerHousecallProWebhookRoutes(app: Express): void {
  app.get("/api/webhooks/:contractorId/housecall-pro", (_req: Request, res: Response) => {
    res.status(200).json({ status: "ok" });
  });

  // Task #678: fail-soft receiver.
  //
  // The HCP service auto-disables a webhook subscription after a small number
  // of non-2xx responses. That means a transient DB hiccup, a bad deploy, or
  // even a malformed payload can take down the integration completely. To
  // prevent that, we ack 200 *before* doing any expensive or fallible work
  // (parsing JSON, contractor lookup, signature verification, persistence).
  //
  // Security: returning 200 before authentication is OK here because
  //   (a) `webhookRateLimiter` runs first, so an attacker cannot drive
  //       unbounded background work,
  //   (b) we do *not* persist or dispatch any event payload until
  //       `verifyHcpWebhookAuth` succeeds — only the lightweight
  //       contractor lookup runs unauthenticated, and even that is
  //       wrapped in try/catch and bounded by the rate limiter.
  //
  // Known limitation: crash-after-ack window. If the process dies after
  // sending 200 but before the background worker persists the event, that
  // single delivery is lost (HCP will not retry a 2xx). This is mitigated
  // for estimates and jobs by the periodic-checker auto-backfill (see
  // server/sync/hcp-backfill.ts), which replays anything modified in the
  // last 7 days through the same dispatch pipeline. Customer / lead
  // entities are NOT covered by the backfill (HCP customers list has no
  // `modified_since`), so a crash-during-window event for those entities
  // can be lost until the next full sync. Accepting this tradeoff because
  // the alternative — HCP auto-disabling the subscription — is far worse.
  app.post("/api/webhooks/:contractorId/housecall-pro",
    webhookRateLimiter,
    asyncHandler(async (req: Request, res: Response) => {
      const { contractorId } = req.params;

      // Size-check BEFORE copying so an oversized body is not duplicated in
      // memory just to be dropped. Express's raw body parser already imposes
      // a global cap, this is a second line of defense specific to this
      // route. Use the original buffer's length rather than allocating a
      // copy first.
      const incoming = Buffer.isBuffer(req.body) ? (req.body as Buffer) : null;
      const tooLarge = incoming !== null && incoming.length > MAX_BODY_BYTES;

      // Snapshot everything we will need in the background. We must do this
      // BEFORE sending the response because Express may reuse the underlying
      // request buffers / headers once the response is finalized. Skip the
      // body copy entirely if it's already over the cap.
      const rawBodyBuffer: Buffer | null = (incoming !== null && !tooLarge)
        ? Buffer.from(incoming)
        : null;
      const headersSnapshot = { ...req.headers };
      const querySnapshot = { ...req.query };

      // Acknowledge IMMEDIATELY — no parse, no DB, no auth.
      res.status(200).json({ received: true });

      if (tooLarge) {
        // We've already 200'd to HCP; just log the drop in-process. No
        // setImmediate needed because there is nothing to do.
        log.warn('HCP webhook: body exceeds MAX_BODY_BYTES, dropping (request was already 200d)', {
          contractorId,
          bytes: incoming!.length,
        });
        return;
      }

      // Now do everything else off the response path.
      setImmediate(() => {
        void processInBackground({
          contractorId,
          rawBodyBuffer,
          headersSnapshot,
          querySnapshot,
        });
      });
    }));
}

interface BackgroundJob {
  contractorId: string;
  rawBodyBuffer: Buffer | null;
  headersSnapshot: Record<string, string | string[] | undefined>;
  querySnapshot: Record<string, unknown>;
}

async function processInBackground(job: BackgroundJob): Promise<void> {
  const { contractorId, rawBodyBuffer, headersSnapshot, querySnapshot } = job;
  try {
    if (!rawBodyBuffer || rawBodyBuffer.length === 0) {
      log.warn('HCP webhook background: empty body, dropping', { contractorId });
      return;
    }
    if (rawBodyBuffer.length > MAX_BODY_BYTES) {
      log.warn('HCP webhook background: body exceeds MAX_BODY_BYTES, dropping', {
        contractorId,
        bytes: rawBodyBuffer.length,
      });
      return;
    }

    let parsedBody: any;
    try {
      parsedBody = JSON.parse(rawBodyBuffer.toString('utf8'));
    } catch (parseErr) {
      log.warn('HCP webhook background: payload is not valid JSON, dropping', {
        contractorId,
        error: parseErr instanceof Error ? parseErr.message : String(parseErr),
      });
      return;
    }

    // Contractor lookup. Failing here (e.g. Neon connection blip) is fine —
    // we already 200'd, so HCP will not disable the subscription.
    let contractor: { id: string } | undefined;
    try {
      contractor = await getContractorCached(contractorId) as { id: string } | undefined;
    } catch (lookupErr) {
      log.error('HCP webhook background: contractor lookup failed (request was already 200d)', {
        contractorId,
        error: lookupErr instanceof Error ? lookupErr.message : String(lookupErr),
      });
      return;
    }

    if (!contractor) {
      // Bogus contractor id (could be an attacker probing). Log a rejection
      // for audit but cap the noise — `webhook_events.errorMessage` is
      // bounded text, and the rate limiter prevents flood.
      log.warn('HCP webhook background: invalid contractor id', { contractorId });
      await db.insert(webhookEvents).values({
        contractorId: null,
        service: 'housecall-pro',
        eventType: 'rejection',
        payload: JSON.stringify({ contractorId }),
        processed: false,
        errorMessage: 'invalid_contractor',
      }).catch(err => log.error('Failed to log rejection event', err));
      return;
    }

    const payloadJson = rawBodyBuffer.toString('utf8');

    if (isHcpVerificationPing(parsedBody)) {
      log.info('HCP webhook background: verification ping (no event fields) — accepting without auth', {
        contractorId,
      });
      await db.insert(webhookEvents).values({
        contractorId,
        service: 'housecall-pro',
        eventType: 'hcp.verification_ping',
        payload: payloadJson,
        processed: true,
        processedAt: new Date(),
      }).catch(err => log.error('Failed to log hcp.verification_ping event', err));
      return;
    }

    log.info('[HCPWebhook] Raw payload received', {
      contractorId,
      headers: {
        'x-housecall-signature': headersSnapshot['x-housecall-signature'],
        'x-housecall-pro-signature': headersSnapshot['x-housecall-pro-signature'],
        'content-type': headersSnapshot['content-type'],
      },
      bodyBytes: rawBodyBuffer.length,
    });

    // Build a lightweight req-like shape carrying only what
    // verifyHcpWebhookAuth reads (headers, query, raw body buffer).
    const authReq = {
      headers: headersSnapshot,
      query: querySnapshot,
      body: rawBodyBuffer,
    } as unknown as Request;

    const auth = await verifyHcpWebhookAuth(authReq, contractorId);
    if (!auth.ok) {
      // Auth ultimately failed. The rejection is already persisted by
      // verifyHcpWebhookAuth via its `logRejection` side effect.
      return;
    }

    const { event_type, data, occurredAt } = normalizeHcpPayload(parsedBody);

    if (!event_type) {
      log.info(`Received test/ping payload (no event) for contractor: ${contractorId}`);
      return;
    }

    log.info(`Received event: ${event_type} for contractor: ${contractorId}`);

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
  } catch (outerErr) {
    // Last-resort guard so an unhandled exception never crashes the process.
    log.error('Unexpected background webhook processing error', {
      contractorId,
      error: outerErr instanceof Error ? outerErr.message : String(outerErr),
    });
  }
}

// Exported for tests so they can drive the background worker directly,
// bypassing setImmediate timing.
export const __test = { processInBackground };
