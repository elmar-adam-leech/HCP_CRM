/**
 * Dialpad webhooks — SMS event subscription management.
 *
 * Retry policy:
 *   - createSmsSubscription / deleteSmsSubscription are write operations and
 *     never use withRetry — retrying risks duplicate subscription creation.
 */

import { getCredentials } from '../client';
import { extractErrorMessage } from '../utils';
import { logger } from '../../utils/logger';

const log = logger('DialpadWebhooks');

/**
 * Create an SMS event subscription for a webhook.
 * no retry on write — retrying risks duplicate subscription creation.
 *
 * On 409 (conflict), attempts to find and reuse the existing subscription
 * via list lookup, then falls back to deleting the stale one and retrying once.
 */
export async function createSmsSubscription(
  contractorId: string,
  webhookId: string,
  direction: 'inbound' | 'outbound' | 'all' = 'all',
  webhookHookUrl?: string
): Promise<{
  success: boolean;
  subscriptionId?: string;
  error?: string;
}> {
  try {
    const { apiKey, baseUrl } = await getCredentials(contractorId);

    const payload = {
      webhook_id: webhookId,
      direction,
      enabled: true,
      include_internal: false,
    };

    log.info('[createSmsSubscription] Sending SMS subscription payload', { webhookId, direction });

    // no retry on write
    const response = await fetch(`${baseUrl}/subscriptions/sms`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      if (response.status === 409) {
        const conflictText = await response.text();
        log.info('[createSmsSubscription] 409 conflict, attempting broad lookup', { webhookId });

        let staleId: string | undefined;
        try {
          const conflictJson = JSON.parse(conflictText);
          const rawId = conflictJson?.id ?? conflictJson?.subscription_id ?? conflictJson?.existing_id;
          if (rawId) staleId = rawId.toString();
        } catch {
          // not JSON — fall through to regex
        }
        if (!staleId) {
          const m = conflictText.match(/"?id"?\s*[=:]\s*"?(\d+)"?/i) || conflictText.match(/(\d{10,})/);
          if (m) staleId = m[1];
        }

        // Step 1: list all SMS subscriptions and try to reuse by webhook_id or hook_url
        try {
          const listResponse = await fetch(`${baseUrl}/subscriptions/sms`, {
            method: 'GET',
            headers: {
              'Authorization': `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
            },
          });
          if (listResponse.ok) {
            const listData = await listResponse.json();
            const items: Array<{ id: number | string; hook_url?: string; webhook_id?: number | string }> =
              listData.items || (Array.isArray(listData) ? listData : []);

            const byWebhookId = items.find(s => s.webhook_id?.toString() === webhookId);
            if (byWebhookId) {
              const existingId = byWebhookId.id?.toString();
              log.info('[createSmsSubscription] Reusing existing subscription (matched by webhook_id)', { subscriptionId: existingId });
              return { success: true, subscriptionId: existingId };
            }

            if (webhookHookUrl) {
              const byUrl = items.find(s => s.hook_url === webhookHookUrl);
              if (byUrl) {
                const existingId = byUrl.id?.toString();
                log.info('[createSmsSubscription] Reusing existing subscription (matched by hook_url)', { subscriptionId: existingId });
                return { success: true, subscriptionId: existingId };
              }
            }
          }
        } catch (listError) {
          log.warn('[createSmsSubscription] Failed to list subscriptions after 409', listError);
        }

        // Step 2: delete the stale subscription from the 409 body and retry once
        if (staleId) {
          log.info('[createSmsSubscription] Deleting stale subscription and retrying', { staleId });
          try {
            const deleteRes = await fetch(`${baseUrl}/subscriptions/sms/${staleId}`, {
              method: 'DELETE',
              headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            });
            if (deleteRes.ok || deleteRes.status === 404) {
              // no retry on write — this is a single targeted retry after stale-delete
              const retryRes = await fetch(`${baseUrl}/subscriptions/sms`, {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${apiKey}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify(payload),
              });
              if (retryRes.ok) {
                const retryData = await retryRes.json();
                log.info('[createSmsSubscription] Retry succeeded after deleting stale subscription', { subscriptionId: retryData.id });
                return { success: true, subscriptionId: retryData.id?.toString() };
              }
            }
          } catch (deleteRetryError) {
            log.warn('[createSmsSubscription] Failed during delete-and-retry for stale subscription', deleteRetryError);
          }
        }

        return {
          success: false,
          error: 'SMS subscription already exists but could not be retrieved or recreated',
        };
      }

      return {
        success: false,
        error: `Failed to create SMS subscription: ${response.status}`,
      };
    }

    const result = await response.json();
    log.info('[createSmsSubscription] SMS subscription created', { subscriptionId: result.id?.toString() });
    return {
      success: true,
      subscriptionId: result.id?.toString(),
    };
  } catch (error) {
    return { success: false, error: extractErrorMessage(error) };
  }
}

/**
 * List SMS event subscriptions for the contractor.
 */
export async function listSmsSubscriptions(
  contractorId: string
): Promise<{
  success: boolean;
  subscriptions?: Array<{
    id: string;
    enabled: boolean;
    direction?: string;
    webhook_id?: string;
    hook_url?: string;
    webhook_present?: boolean;
  }>;
  error?: string;
}> {
  try {
    const { apiKey, baseUrl } = await getCredentials(contractorId);
    const response = await fetch(`${baseUrl}/subscriptions/sms`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    });
    if (!response.ok) {
      const errorText = await response.text();
      return { success: false, error: `Failed to list SMS subscriptions: ${response.status} ${errorText}` };
    }
    const data = await response.json();
    const items: Array<{
      id: number | string;
      enabled?: boolean;
      direction?: string;
      webhook_id?: number | string;
      hook_url?: string;
      webhook?: { id?: number | string; hook_url?: string } | null;
    }> = data.items || (Array.isArray(data) ? data : []);
    return {
      success: true,
      subscriptions: items.map(s => ({
        id: s.id?.toString(),
        enabled: s.enabled ?? true,
        direction: s.direction,
        webhook_id: (s.webhook_id ?? s.webhook?.id)?.toString(),
        hook_url: s.hook_url ?? s.webhook?.hook_url,
        webhook_present: s.webhook != null,
      })),
    };
  } catch (error) {
    return { success: false, error: extractErrorMessage(error) };
  }
}

/**
 * Delete an SMS subscription from Dialpad.
 * no retry on write.
 */
export async function deleteSmsSubscription(
  contractorId: string,
  subscriptionId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const { apiKey, baseUrl } = await getCredentials(contractorId);

    // no retry on write
    const response = await fetch(`${baseUrl}/subscriptions/sms/${subscriptionId}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok && response.status !== 404) {
      const errorText = await response.text();
      return {
        success: false,
        error: `Failed to delete SMS subscription: ${response.status} ${errorText}`,
      };
    }

    return { success: true };
  } catch (error) {
    return { success: false, error: extractErrorMessage(error) };
  }
}
