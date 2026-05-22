import type { Express, Request, Response } from 'express';
import crypto from 'crypto';
import axios from 'axios';
import { CredentialService } from '../../credential-service';
import { asyncHandler } from '../../utils/async-handler';
import { logger } from '../../utils/logger';
import { db } from '../../db';
import { contractorCredentials } from '@shared/schema';
import { eq, and } from 'drizzle-orm';
import { processFacebookLead } from '../../sync/facebook-leads';
import { facebookWebhookRateLimiter } from '../../middleware/rate-limiter';

const log = logger('FacebookWebhook');

const FB_API_VERSION = 'v25.0';

/**
 * Verify the X-Hub-Signature-256 header sent by Meta on every webhook POST.
 *
 * Meta computes:  HMAC-SHA256(rawBody, FACEBOOK_APP_SECRET)
 * and sends it as:  X-Hub-Signature-256: sha256=<hex>
 *
 * Returns true only when the computed and provided signatures match via
 * constant-time comparison. If FACEBOOK_APP_SECRET is not configured the
 * function returns false so the request is rejected, preventing the endpoint
 * from accepting any traffic when the environment is not properly set up.
 */
function verifyFacebookSignature(rawBody: Buffer, signatureHeader: string | undefined): boolean {
  const appSecret = process.env.FACEBOOK_APP_SECRET;
  if (!appSecret) {
    log.error('FACEBOOK_APP_SECRET is not configured — cannot verify webhook signature');
    return false;
  }

  if (!signatureHeader) {
    log.warn('Missing X-Hub-Signature-256 header on Facebook webhook POST');
    return false;
  }

  const providedHex = signatureHeader.replace(/^sha256=/, '');
  const expectedHex = crypto
    .createHmac('sha256', appSecret)
    .update(rawBody)
    .digest('hex');

  // Use constant-time comparison to prevent timing-based signature oracle attacks.
  const expectedBuf = Buffer.from(expectedHex, 'hex');
  const providedBuf = Buffer.from(providedHex, 'hex');

  if (expectedBuf.length !== providedBuf.length) {
    log.warn('Facebook webhook signature length mismatch — likely malformed header');
    return false;
  }

  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

export function registerFacebookWebhookRoutes(app: Express): void {
  app.get('/api/webhooks/facebook', asyncHandler<Request>(async (req: Request, res: Response) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === process.env.FACEBOOK_VERIFY_TOKEN) {
      log.debug('Facebook webhook verification successful');
      res.status(200).send(challenge);
    } else {
      log.error('Facebook webhook verification failed — invalid verify token');
      res.sendStatus(403);
    }
  }));

  app.post(
    '/api/webhooks/facebook',
    facebookWebhookRateLimiter,
    asyncHandler<Request>(async (req: Request, res: Response) => {
      // req.body is a raw Buffer (set by express.raw in index.ts) for this path.
      const rawBody: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body));

      // ── Signature verification ────────────────────────────────────────────
      // Reject the request immediately if Meta's HMAC-SHA256 signature does not
      // match. This must happen BEFORE we touch any payload fields so that a
      // forged request never reaches lead-processing logic.
      const signatureHeader = req.headers['x-hub-signature-256'] as string | undefined;
      if (!verifyFacebookSignature(rawBody, signatureHeader)) {
        log.warn('Facebook webhook request rejected: invalid or missing X-Hub-Signature-256');
        // Return 403 so the caller knows the request was explicitly rejected.
        // Meta will retry on 5xx but not on 4xx, which is the correct behaviour
        // here — a bad signature is never going to succeed on retry.
        res.sendStatus(403);
        return;
      }

      // Signature is valid — acknowledge immediately so Meta does not retry.
      res.sendStatus(200);

      try {
        const body = JSON.parse(rawBody.toString('utf8'));
        if (body?.object !== 'page') return;

        for (const entry of body.entry ?? []) {
          for (const change of entry.changes ?? []) {
            if (change.field !== 'leadgen') continue;

            const { page_id, leadgen_id } = change.value ?? {};
            if (!page_id || !leadgen_id) continue;

            await processLeadgenEvent(String(page_id), String(leadgen_id));
          }
        }
      } catch (err) {
        log.error('Error processing Facebook webhook payload:', err instanceof Error ? err.message : err);
      }
    }),
  );
}

async function processLeadgenEvent(pageId: string, leadgenId: string): Promise<void> {
  try {
    const allPageIdCreds = await findContractorByPageId(pageId);
    if (!allPageIdCreds) {
      log.error(`No contractor found for Facebook page_id: ${pageId}`);
      return;
    }

    const { contractorId, pageAccessToken } = allPageIdCreds;

    const leadRes = await axios.get(`https://graph.facebook.com/${FB_API_VERSION}/${leadgenId}`, {
      params: {
        fields: 'field_data,ad_id,ad_name,form_id,created_time',
        access_token: pageAccessToken,
      },
      timeout: 10000,
    });

    await processFacebookLead({
      contractorId,
      leadResource: leadRes.data,
      source: 'webhook',
      pageAccessToken,
      skipDuplicateLeadWithinHours: 24,
    });

    void CredentialService.setCredential(contractorId, 'facebook-leads', 'last_webhook_lead_at', new Date().toISOString());
  } catch (err) {
    log.error(`Failed to process leadgen event ${leadgenId}:`, err instanceof Error ? err.message : err);
  }
}

async function findContractorByPageId(targetPageId: string): Promise<{ contractorId: string; pageAccessToken: string } | null> {
  try {
    const pageIdRows = await db
      .select()
      .from(contractorCredentials)
      .where(
        and(
          eq(contractorCredentials.service, 'facebook-leads'),
          eq(contractorCredentials.credentialKey, 'page_id')
        )
      );

    for (const row of pageIdRows) {
      if (!row.isActive) continue;

      const contractorId = row.contractorId;
      const decryptedPageId = await CredentialService.getCredential(contractorId, 'facebook-leads', 'page_id');

      if (String(decryptedPageId) === String(targetPageId)) {
        const pageAccessToken = await CredentialService.getCredential(contractorId, 'facebook-leads', 'page_access_token');
        if (pageAccessToken) {
          return { contractorId, pageAccessToken };
        }
      }
    }

    return null;
  } catch (err) {
    log.error('Error finding contractor by page ID:', err instanceof Error ? err.message : err);
    return null;
  }
}
