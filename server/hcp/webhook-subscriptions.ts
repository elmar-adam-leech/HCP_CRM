import { logger } from '../utils/logger';
import { HcpBaseClient } from './base-client';

const log = logger('HcpWebhookSubs');

export interface HcpWebhookSubscription {
  id?: string;
  url?: string;
  endpoint?: string;
  active?: boolean;
  enabled?: boolean;
  status?: string;
  events?: string[];
  [k: string]: unknown;
}

export type WebhookSubscriptionProbeResult =
  // The probe ran and we got a useful answer back from HCP.
  | { kind: 'ok'; subscriptions: HcpWebhookSubscription[] }
  // HCP doesn't expose a webhook-listing endpoint for this tenant's auth
  // (typical for plain API-key auth where webhooks are dashboard-managed),
  // OR the request failed for an unrelated reason. Either way the caller
  // should NOT raise a `subscription-missing` incident — there is no signal
  // here to act on.
  | { kind: 'unsupported'; reason: string };

/**
 * Best-effort probe of the HCP webhook subscription configuration for a
 * tenant. Used by the webhook-health checker to distinguish "the webhook is
 * still configured but firing into a dead URL" from "the webhook was deleted
 * or disabled in the HCP dashboard".
 *
 * NOTE: HCP only exposes webhook listings for accounts/integrations that
 * created their webhooks via the API (OAuth or webhook-subscriptions API).
 * For tenants whose webhook is configured manually in the HCP dashboard the
 * listing endpoint returns 404 / 403 — we treat that as `unsupported` so we
 * never false-alarm on tenants where this signal isn't available.
 */
export class HcpWebhookSubscriptionsModule extends HcpBaseClient {
  async getWebhookSubscriptions(tenantId: string): Promise<WebhookSubscriptionProbeResult> {
    // HCP has used a few different paths for this over the years
    // (`/webhook_subscriptions`, `/webhooks`). Try them in order and treat
    // 404 on either as "this tenant doesn't expose the API".
    const candidates = ['/webhook_subscriptions', '/webhooks'];

    for (const endpoint of candidates) {
      const response = await this.makeRequest<unknown>(endpoint, tenantId, 'GET', undefined, /* maxRetries */ 0);
      if (response.success && response.data !== undefined) {
        const subs = normalizeSubscriptions(response.data);
        log.info(`[HCP] Probed ${endpoint} for tenant ${tenantId} — ${subs.length} subscription(s)`);
        return { kind: 'ok', subscriptions: subs };
      }
      const errMsg = response.error ?? '';
      // If HCP returned 404 / endpoint not found, try the next candidate.
      if (/404|not\s*found/i.test(errMsg)) {
        continue;
      }
      // 401/403 — auth issue or endpoint not exposed for this auth scope.
      // Unsupported (do not alarm) but bail out instead of trying further
      // candidates with the same auth.
      if (/401|403|forbidden|unauthor/i.test(errMsg)) {
        return { kind: 'unsupported', reason: `auth: ${errMsg}` };
      }
      // Any other error: treat as transient/unsupported and bail.
      return { kind: 'unsupported', reason: errMsg || 'unknown error' };
    }

    return { kind: 'unsupported', reason: 'no listing endpoint available on this account' };
  }
}

function normalizeSubscriptions(payload: unknown): HcpWebhookSubscription[] {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload as HcpWebhookSubscription[];
  if (typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;
    for (const key of ['webhook_subscriptions', 'webhooks', 'subscriptions', 'data']) {
      const val = obj[key];
      if (Array.isArray(val)) return val as HcpWebhookSubscription[];
    }
  }
  return [];
}

export const hcpWebhookSubscriptionsService = new HcpWebhookSubscriptionsModule();
