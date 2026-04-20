import type { Request } from "express";
import crypto from "crypto";
import { db } from "../../../db";
import { webhookEvents } from "@shared/schema";
import { getCredentialCached } from "../../../services/cache";
import { logger } from "../../../utils/logger";

const log = logger('HCPWebhook');

export interface HcpAuthResult {
  ok: boolean;
  rejectStatus?: number;
  rejectMessage?: string;
  rejectReason?: string;
}

function logRejection(contractorId: string, reason: string): void {
  db.insert(webhookEvents).values({
    contractorId,
    service: 'housecall-pro',
    eventType: 'rejection',
    payload: JSON.stringify({ contractorId }),
    processed: false,
    errorMessage: reason,
  }).catch(err => log.error('Failed to log rejection event', err));
}

/**
 * Verify the inbound HCP webhook request using HMAC first, with URL-token fallback.
 * Returns { ok: true } on success, otherwise an object describing how to reject.
 *
 * Side effect: persists a `rejection` row in `webhook_events` for any failure.
 */
export async function verifyHcpWebhookAuth(
  req: Request,
  contractorId: string
): Promise<HcpAuthResult> {
  const signatureHeader = req.headers['x-housecall-signature'] || req.headers['x-housecall-pro-signature'];
  const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;

  let webhookSecret: string | undefined;
  let urlToken: string | undefined;
  try {
    webhookSecret = await getCredentialCached(contractorId, 'housecallpro', 'webhook_secret') || undefined;
  } catch (_) { /* not yet configured */ }
  try {
    urlToken = await getCredentialCached(contractorId, 'housecallpro', 'webhook_url_token') || undefined;
  } catch (_) { /* not yet generated */ }

  const bodyBuffer = Buffer.isBuffer(req.body) ? req.body as Buffer : null;

  let hmacVerified = false;
  let hmacAttempted = false;
  if (webhookSecret && signature) {
    hmacAttempted = true;
    if (!bodyBuffer) {
      log.warn('Cannot verify HMAC: raw body unavailable — falling back to URL token', { contractorId });
    } else {
      const expectedSignature = crypto
        .createHmac('sha256', webhookSecret)
        .update(bodyBuffer)
        .digest('hex');
      const providedSignature = signature.replace(/^sha256=/, '');
      try {
        const expectedBuf = Buffer.from(expectedSignature, 'utf8');
        const providedBuf = Buffer.from(providedSignature, 'utf8');
        if (expectedBuf.length === providedBuf.length && crypto.timingSafeEqual(expectedBuf, providedBuf)) {
          hmacVerified = true;
          log.info('Webhook HMAC verified successfully', { contractorId });
        } else {
          log.warn('Webhook HMAC mismatch — falling back to URL token check', {
            contractorId,
            receivedSignaturePrefix: providedSignature.slice(0, 8) + '...',
            expectedSignaturePrefix: expectedSignature.slice(0, 8) + '...',
            signatureHeaderUsed: req.headers['x-housecall-signature'] ? 'x-housecall-signature' : 'x-housecall-pro-signature',
          });
        }
      } catch (err) {
        log.warn('Webhook HMAC comparison error — falling back to URL token check', { contractorId, error: String(err) });
      }
    }
  }

  if (hmacVerified) {
    return { ok: true };
  }

  if (urlToken) {
    const providedToken = req.query.token as string | undefined;
    if (!providedToken) {
      log.error('Missing token query parameter and HMAC not verified', { contractorId, hmacAttempted });
      logRejection(contractorId, 'missing_signature');
      return { ok: false, rejectStatus: 401, rejectMessage: 'Missing token', rejectReason: 'missing_signature' };
    }
    try {
      const tokenBuf = Buffer.from(urlToken, 'hex');
      const providedBuf = Buffer.from(providedToken, 'hex');
      if (tokenBuf.length !== providedBuf.length || !crypto.timingSafeEqual(tokenBuf, providedBuf)) {
        log.error('Invalid URL token', { contractorId, hmacAttempted });
        logRejection(contractorId, 'invalid_token');
        return { ok: false, rejectStatus: 401, rejectMessage: 'Invalid token', rejectReason: 'invalid_token' };
      }
      if (hmacAttempted) {
        log.info('Webhook authenticated via URL token (HMAC was attempted but did not match)', { contractorId });
      }
      return { ok: true };
    } catch {
      log.error('Token comparison failed', { contractorId });
      logRejection(contractorId, 'invalid_token');
      return { ok: false, rejectStatus: 401, rejectMessage: 'Invalid token', rejectReason: 'invalid_token' };
    }
  }

  if (!webhookSecret) {
    log.error('No webhook auth configured for contractor — rejecting request', { contractorId });
    logRejection(contractorId, 'no_auth_configured');
    return { ok: false, rejectStatus: 401, rejectMessage: 'Webhook not configured for this contractor', rejectReason: 'no_auth_configured' };
  }

  if (hmacAttempted) {
    log.error('Webhook HMAC signature mismatch — rejecting request', { contractorId });
    logRejection(contractorId, 'bad_signature');
    return { ok: false, rejectStatus: 401, rejectMessage: 'Invalid signature', rejectReason: 'bad_signature' };
  }

  log.error('Missing webhook signature header and no URL token configured', { contractorId });
  logRejection(contractorId, 'missing_signature');
  return { ok: false, rejectStatus: 401, rejectMessage: 'Missing signature', rejectReason: 'missing_signature' };
}
