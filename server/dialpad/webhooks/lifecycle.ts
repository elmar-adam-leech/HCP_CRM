/**
 * Dialpad webhooks — lifecycle (CRUD) for webhook records.
 *
 * Retry policy:
 *   - createWebhook / deleteWebhook are write operations and never use withRetry.
 *   - listWebhooks is a read used only by admin/diagnostic flows; no retry needed.
 */

import { getCredentials } from '../client';
import { extractErrorMessage } from '../utils';
import { db } from '../../db';
import { dialpadWebhookState } from '@shared/schema';
import { eq, sql } from 'drizzle-orm';
import { logger } from '../../utils/logger';
import type { DialpadApiResponse } from '../types';

const log = logger('DialpadWebhooks');

/**
 * Create a webhook in Dialpad with the provided URL.
 * no retry on write — retrying risks duplicate webhook registrations.
 *
 * On 409 (conflict), looks up and returns the existing webhook for the same URL.
 */
export async function createWebhook(
  contractorId: string,
  hookUrl?: string,
  secret?: string,
  callbackHeaders?: Record<string, string>
): Promise<{
  success: boolean;
  webhookId?: string;
  hookUrl?: string;
  error?: string;
}> {
  try {
    const { apiKey, baseUrl } = await getCredentials(contractorId);

    if (!hookUrl) {
      return { success: false, error: 'Webhook URL is required' };
    }

    const payload: { hook_url: string; secret?: string; headers?: Record<string, string> } = {
      hook_url: hookUrl,
    };
    if (secret) payload.secret = secret;
    if (callbackHeaders && Object.keys(callbackHeaders).length > 0) {
      payload.headers = callbackHeaders;
    }

    // no retry on write
    const response = await fetch(`${baseUrl}/webhooks`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      if (response.status === 409) {
        log.info('[createWebhook] 409 conflict, looking up existing webhook (URL redacted)');
        const listResult = await listWebhooks(contractorId);
        if (listResult.success && listResult.webhooks) {
          const existing = listResult.webhooks.find(w => w.hook_url === hookUrl);
          if (existing) {
            log.info('[createWebhook] Reusing existing webhook', { webhookId: existing.id });
            return { success: true, webhookId: existing.id, hookUrl: existing.hook_url };
          }
        }
        return { success: false, error: 'Webhook already exists but could not be retrieved' };
      }
      return {
        success: false,
        error: `Failed to create webhook: ${response.status}`,
      };
    }

    const result = await response.json();
    return {
      success: true,
      webhookId: result.id?.toString(),
      hookUrl: result.hook_url,
    };
  } catch (error) {
    return { success: false, error: extractErrorMessage(error) };
  }
}

/**
 * Delete a webhook from Dialpad.
 * Cleans up all SMS subscriptions tied to the webhook first to prevent stale 409s.
 * no retry on write — retrying risks unexpected side effects.
 */
export async function deleteWebhook(
  contractorId: string,
  webhookId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const { apiKey, baseUrl } = await getCredentials(contractorId);

    for (const subType of ['sms', 'call'] as const) {
      try {
        const listRes = await fetch(`${baseUrl}/subscriptions/${subType}`, {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        });
        if (listRes.ok) {
          const listData = await listRes.json();
          const items: Array<{ id: number | string; webhook_id?: number | string; endpoint_id?: number | string; webhook?: { id?: number | string } }> =
            listData.items || (Array.isArray(listData) ? listData : []);
          const matching = items.filter(s => {
            // Both SMS and call subscriptions use webhook_id.
            // Also check endpoint_id and nested webhook.id as legacy fallbacks.
            const wid = s.webhook_id?.toString() ?? s.endpoint_id?.toString() ?? s.webhook?.id?.toString();
            return wid === webhookId;
          });
          for (const sub of matching) {
            const subId = sub.id?.toString();
            log.info(`[deleteWebhook] Deleting ${subType} subscription before webhook deletion`, { webhookId, subscriptionId: subId });
            const subDeleteRes = await fetch(`${baseUrl}/subscriptions/${subType}/${subId}`, {
              method: 'DELETE',
              headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            });
            if (!subDeleteRes.ok && subDeleteRes.status !== 404) {
              log.warn(`[deleteWebhook] Failed to delete ${subType} subscription (continuing anyway)`, { webhookId, subscriptionId: subId, status: subDeleteRes.status });
            } else {
              log.info(`[deleteWebhook] ${subType} subscription deleted successfully`, { webhookId, subscriptionId: subId });
            }
          }
        }
      } catch (subError) {
        log.warn(`[deleteWebhook] Failed to clean up ${subType} subscriptions before deletion`, subError);
      }
    }

    // no retry on write
    const response = await fetch(`${baseUrl}/webhooks/${webhookId}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok && response.status !== 404) {
      const errorText = await response.text();
      return { success: false, error: `Failed to delete webhook: ${response.status} ${errorText}` };
    }

    // Clear matching IDs in dialpad_webhook_state. We don't drop the entire row
    // because a single deleteWebhook may target only the SMS or only the call webhook.
    try {
      await db.update(dialpadWebhookState)
        .set({
          smsWebhookId: sql`CASE WHEN ${dialpadWebhookState.smsWebhookId} = ${webhookId} THEN NULL ELSE ${dialpadWebhookState.smsWebhookId} END`,
          smsSubscriptionId: sql`CASE WHEN ${dialpadWebhookState.smsWebhookId} = ${webhookId} THEN NULL ELSE ${dialpadWebhookState.smsSubscriptionId} END`,
          callWebhookId: sql`CASE WHEN ${dialpadWebhookState.callWebhookId} = ${webhookId} THEN NULL ELSE ${dialpadWebhookState.callWebhookId} END`,
          callSubscriptionIds: sql`CASE WHEN ${dialpadWebhookState.callWebhookId} = ${webhookId} THEN NULL ELSE ${dialpadWebhookState.callSubscriptionIds} END`,
          updatedAt: new Date(),
        })
        .where(eq(dialpadWebhookState.contractorId, contractorId));
    } catch (err) {
      log.warn('[deleteWebhook] Failed to clear dialpad_webhook_state row', err);
    }

    return { success: true };
  } catch (error) {
    return { success: false, error: extractErrorMessage(error) };
  }
}

/**
 * List all webhooks for the contractor.
 */
export async function listWebhooks(contractorId: string): Promise<{
  success: boolean;
  webhooks?: Array<{ id: string; hook_url: string }>;
  error?: string;
}> {
  try {
    const { apiKey, baseUrl } = await getCredentials(contractorId);

    const response = await fetch(`${baseUrl}/webhooks`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      return { success: false, error: `Failed to list webhooks: ${response.status} ${errorText}` };
    }

    const data: DialpadApiResponse<{ id: number; hook_url: string }> = await response.json();
    return {
      success: true,
      webhooks: (data.items || []).map(w => ({
        id: w.id.toString(),
        hook_url: w.hook_url,
      })),
    };
  } catch (error) {
    return { success: false, error: extractErrorMessage(error) };
  }
}
