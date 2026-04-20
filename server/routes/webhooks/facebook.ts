import type { Express, Request, Response } from 'express';
import axios from 'axios';
import { CredentialService } from '../../credential-service';
import { asyncHandler } from '../../utils/async-handler';
import { logger } from '../../utils/logger';
import { db } from '../../db';
import { contractorCredentials } from '@shared/schema';
import { eq, and } from 'drizzle-orm';
import { processFacebookLead } from '../../sync/facebook-leads';

const log = logger('FacebookWebhook');

const FB_API_VERSION = 'v25.0';

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

  app.post('/api/webhooks/facebook', asyncHandler<Request>(async (req: Request, res: Response) => {
    res.sendStatus(200);

    try {
      const body = req.body;
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
  }));
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
