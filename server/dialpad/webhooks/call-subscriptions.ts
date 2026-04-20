/**
 * Dialpad webhooks — call event subscription management.
 *
 * Retry policy:
 *   - createCallSubscription is a write operation and never uses withRetry —
 *     retrying risks duplicate subscription creation.
 *   - reregisterCallSubscriptions performs writes and never uses withRetry.
 */

import { getCredentials } from '../client';
import { extractErrorMessage } from '../utils';
import { getCompanyOffices, getDepartments } from '../users';
import { logger } from '../../utils/logger';

const log = logger('DialpadWebhooks');

/**
 * Create a call-event subscription for a webhook.
 * Mirrors createSmsSubscription but targets Dialpad's call subscription endpoint.
 * no retry on write — retrying risks duplicate subscription creation.
 *
 * On 409 (conflict), attempts to find and reuse the existing subscription
 * via list lookup.
 */
export async function createCallSubscription(
  contractorId: string,
  webhookId: string,
  webhookHookUrl?: string,
  targetType?: string,
  targetId?: string | number
): Promise<{
  success: boolean;
  subscriptionId?: string;
  actualTargetType?: string;
  webhookLinked?: boolean;
  error?: string;
}> {
  try {
    const { apiKey, baseUrl } = await getCredentials(contractorId);

    // Explicit state names as documented by Dialpad.
    // 'all' is NOT a valid value — Dialpad silently ignores unrecognised states and never fires.
    // voicemail_uploaded fires once a voicemail recording has been uploaded so we can
    // attach the recording URL to the activity. Without it, voicemails arrive with no audio.
    const callStates = ['ringing', 'connected', 'hangup', 'missed', 'voicemail', 'voicemail_uploaded'];

    // Build payload using endpoint_id (integer) as documented by Dialpad call subscription API.
    // Note: SMS subscriptions use webhook_id; call subscriptions use endpoint_id.
    const buildPayload = (): Record<string, unknown> => {
      const p: Record<string, unknown> = {
        endpoint_id: Number(webhookId),
        call_states: callStates,
        enabled: true,
      };
      if (targetType && targetId) {
        p.target_type = targetType;
        p.target_id = Number(targetId);
      }
      return p;
    };

    const payload = buildPayload();

    log.info('[createCallSubscription] Sending call subscription payload', { webhookId, targetType, targetId, payload });

    const doPost = async (p: Record<string, unknown>) => fetch(`${baseUrl}/subscriptions/call`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(p),
    });

    let response = await doPost(payload);

    if (!response.ok) {
      const errorText = await response.text();

      if (response.status === 422 || response.status === 400) {
        log.warn('[createCallSubscription] Dialpad rejected call subscription payload', {
          status: response.status,
          responseBody: errorText,
          webhookId,
          payload,
        });
      } else {
        log.error('[createCallSubscription] Non-2xx response from Dialpad', {
          status: response.status,
          responseBody: errorText,
          webhookId,
          payload,
        });
      }

      // Return structured failure so callers can decide the next fallback strategy.
      // Callers (createWebhookWithSubscription, reregisterCallSubscriptions) implement
      // the office → department → account-level fallback sequence explicitly.

      if (response.status === 409) {
        log.info('[createCallSubscription] 409 conflict, attempting broad lookup', { webhookId, targetType, targetId });

        try {
          const listResponse = await fetch(`${baseUrl}/subscriptions/call`, {
            method: 'GET',
            headers: {
              'Authorization': `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
            },
          });
          if (listResponse.ok) {
            const listData = await listResponse.json();
            const items: Array<{
              id: number | string;
              hook_url?: string;
              webhook_id?: number | string;
              endpoint_id?: number | string;
              webhook?: { id?: number | string; hook_url?: string } | null;
              target_type?: string;
              target_id?: number | string;
            }> = listData.items || (Array.isArray(listData) ? listData : []);

            const matching = items.filter(s => {
              const wid = (s.webhook_id ?? s.endpoint_id ?? s.webhook?.id)?.toString();
              return wid === webhookId;
            });

            for (const existing of matching) {
              const existingTargetType = existing.target_type ?? null;
              const existingTargetId = existing.target_id?.toString() ?? null;
              const wantTargetType = targetType ?? null;
              const wantTargetId = targetId?.toString() ?? null;

              if (existingTargetType === wantTargetType && existingTargetId === wantTargetId) {
                const existingId = existing.id?.toString();
                const existingWebhookLinked = existing.webhook != null && !!existing.webhook.hook_url;
                log.info('[createCallSubscription] Reusing existing subscription with matching target', { subscriptionId: existingId, targetType: existingTargetType, targetId: existingTargetId, webhookLinked: existingWebhookLinked });
                return { success: true, subscriptionId: existingId, actualTargetType: existingTargetType ?? targetType ?? 'account', webhookLinked: existingWebhookLinked };
              }

              log.info('[createCallSubscription] Existing subscription has wrong target, deleting', {
                subscriptionId: existing.id,
                existingTarget: { type: existingTargetType, id: existingTargetId },
                wantTarget: { type: wantTargetType, id: wantTargetId },
              });
              try {
                await fetch(`${baseUrl}/subscriptions/call/${existing.id}`, {
                  method: 'DELETE',
                  headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                });
              } catch (delErr) {
                log.warn('[createCallSubscription] Failed to delete stale subscription', delErr);
              }
            }

            if (matching.length > 0) {
              const retryRes = await doPost(payload);
              if (retryRes.ok) {
                const retryData = await retryRes.json();
                log.info('[createCallSubscription] Retry succeeded after deleting stale subscriptions', { subscriptionId: retryData.id });
                return { success: true, subscriptionId: retryData.id?.toString(), actualTargetType: targetType ?? 'account', webhookLinked: retryData.webhook != null };
              }
            }

            if (webhookHookUrl) {
              const byUrl = items.find(s => s.hook_url === webhookHookUrl);
              if (byUrl) {
                const existingId = byUrl.id?.toString();
                const byUrlWebhookLinked = byUrl.webhook != null && !!byUrl.webhook.hook_url;
                log.info('[createCallSubscription] Reusing existing subscription (matched by hook_url)', { subscriptionId: existingId, webhookLinked: byUrlWebhookLinked });
                return { success: true, subscriptionId: existingId, actualTargetType: byUrl.target_type ?? targetType ?? 'account', webhookLinked: byUrlWebhookLinked };
              }
            }
          }
        } catch (listError) {
          log.warn('[createCallSubscription] Failed to list subscriptions after 409', listError);
        }

        return {
          success: false,
          error: `Call subscription already exists (409) but could not be retrieved or recreated. Dialpad response: ${errorText}`,
        };
      }

      return {
        success: false,
        error: `Failed to create call subscription: ${response.status} ${errorText}`,
      };
    }

    const result = await response.json();
    log.debug('[createCallSubscription] Full subscription response', { body: result });
    log.info('[createCallSubscription] Call subscription created', {
      subscriptionId: result.id?.toString(),
      targetType,
    });
    log.info('[createCallSubscription] Subscription webhook linkage', {
      subscriptionId: result.id?.toString(),
      webhookLinked: result.webhook != null,
      webhookHookUrl: result.webhook?.hook_url ?? null,
      webhookId: result.webhook?.id?.toString() ?? null,
    });
    if (result.webhook == null) {
      // Dialpad accepted the subscription but did not attach a webhook —
      // events for this subscription will NOT be delivered. The orchestrator
      // already handles this in the office→user fallback path, but a bare
      // call from elsewhere (re-register, manual one-off) would otherwise
      // silently succeed. Make it loud.
      log.warn('[createCallSubscription] Subscription created with NO webhook attached — Dialpad will accept events for this target but will not deliver them. Caller must implement a fallback or re-register against a different target.', {
        subscriptionId: result.id?.toString(),
        webhookId,
        targetType,
        targetId,
      });
    }
    return {
      success: true,
      subscriptionId: result.id?.toString(),
      actualTargetType: targetType ?? 'account',
      webhookLinked: result.webhook != null,
    };
  } catch (error) {
    return { success: false, error: extractErrorMessage(error) };
  }
}

/**
 * Re-register call subscriptions only (no SMS webhook changes).
 * Cycles through office → department → no-target strategies.
 * Returns the subscriptions created and a human-readable targetType indicating
 * which strategy succeeded.
 * no retry on write.
 */
export async function reregisterCallSubscriptions(
  contractorId: string,
  callWebhookId: string,
  callHookUrl?: string
): Promise<{
  success: boolean;
  subscriptionIds?: string[];
  targetType?: string;
  targetDetails?: Array<{ id: string | number; name: string }>;
  error?: string;
}> {
  const allErrors: string[] = [];

  // Strategy 1: office-level targeting (always attempted first)
  const offices = await getCompanyOffices(contractorId);
  log.info('[reregisterCallSubscriptions] Fetched offices', { count: offices.length });

  if (offices.length > 0) {
    const subscriptionIds: string[] = [];
    const officeErrors: string[] = [];
    const succeededOffices: Array<{ id: string | number; name: string }> = [];

    let actualOfficeTargetType: string | undefined;
    for (const office of offices) {
      const officeId = office.office_id ?? office.id;
      const result = await createCallSubscription(contractorId, callWebhookId, callHookUrl, 'office', officeId);
      if (result.success && result.subscriptionId) {
        subscriptionIds.push(result.subscriptionId);
        succeededOffices.push({ id: officeId, name: office.name });
        if (!actualOfficeTargetType) actualOfficeTargetType = result.actualTargetType;
        log.info('[reregisterCallSubscriptions] Office subscription created', { officeId, subscriptionId: result.subscriptionId, actualTargetType: result.actualTargetType });
      } else {
        officeErrors.push(`office ${office.name} (${officeId}): ${result.error}`);
      }
    }

    if (subscriptionIds.length > 0) {
      return { success: true, subscriptionIds, targetType: actualOfficeTargetType ?? 'office', targetDetails: succeededOffices };
    }

    allErrors.push(...officeErrors);
    log.warn('[reregisterCallSubscriptions] Office targeting failed for all offices, trying departments', { officeErrors });
  } else {
    log.info('[reregisterCallSubscriptions] No offices found, skipping office strategy');
  }

  // Strategy 2: department-level targeting (always attempted if office fails/absent)
  const departments = await getDepartments(contractorId);
  log.info('[reregisterCallSubscriptions] Fetched departments', { count: departments.length });

  if (departments.length > 0) {
    const deptIds: string[] = [];
    const deptErrors: string[] = [];
    const succeededDepts: Array<{ id: string | number; name: string }> = [];

    let actualDeptTargetType: string | undefined;
    for (const dept of departments) {
      const result = await createCallSubscription(contractorId, callWebhookId, callHookUrl, 'department', dept.id);
      if (result.success && result.subscriptionId) {
        deptIds.push(result.subscriptionId);
        succeededDepts.push({ id: dept.id, name: dept.name });
        if (!actualDeptTargetType) actualDeptTargetType = result.actualTargetType;
        log.info('[reregisterCallSubscriptions] Department subscription created', { deptId: dept.id, subscriptionId: result.subscriptionId, actualTargetType: result.actualTargetType });
      } else {
        deptErrors.push(`department ${dept.name} (${dept.id}): ${result.error}`);
      }
    }

    if (deptIds.length > 0) {
      return { success: true, subscriptionIds: deptIds, targetType: actualDeptTargetType ?? 'department', targetDetails: succeededDepts };
    }

    allErrors.push(...deptErrors);
    log.warn('[reregisterCallSubscriptions] Department targeting failed, trying no-target fallback', { deptErrors });
  } else {
    log.info('[reregisterCallSubscriptions] No departments found, skipping department strategy');
  }

  // Strategy 3: no-target account-level fallback
  const fallback = await createCallSubscription(contractorId, callWebhookId, callHookUrl);
  if (fallback.success && fallback.subscriptionId) {
    log.warn('[reregisterCallSubscriptions] No-target fallback subscription created (account-level coverage)', { subscriptionId: fallback.subscriptionId });
    return { success: true, subscriptionIds: [fallback.subscriptionId], targetType: 'account' };
  }

  allErrors.push(`no-target fallback: ${fallback.error}`);
  return {
    success: false,
    error: allErrors.join('; '),
  };
}

/**
 * List all call event subscriptions for the contractor.
 * Used to check whether a call subscription is active.
 */
export async function listCallSubscriptions(
  contractorId: string
): Promise<{
  success: boolean;
  subscriptions?: Array<{
    id: string;
    enabled: boolean;
    target_type?: string;
    target_id?: string;
    call_states?: string[];
    endpoint_id?: string;
    webhook_id?: string;
    webhook_present?: boolean;
    webhook_hook_url?: string;
  }>;
  error?: string;
}> {
  try {
    const { apiKey, baseUrl } = await getCredentials(contractorId);

    const response = await fetch(`${baseUrl}/subscriptions/call`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      return { success: false, error: `Failed to list call subscriptions: ${response.status} ${errorText}` };
    }

    const data = await response.json();
    const items: Array<{
      id: number | string;
      enabled?: boolean;
      target_type?: string;
      target_id?: number | string;
      call_states?: string[];
      endpoint_id?: number | string;
      webhook?: { id?: number | string; hook_url?: string } | null;
      webhook_id?: number | string;
    }> = data.items || (Array.isArray(data) ? data : []);

    return {
      success: true,
      subscriptions: items.map(s => ({
        id: s.id?.toString(),
        enabled: s.enabled ?? true,
        target_type: s.target_type,
        target_id: s.target_id?.toString(),
        call_states: s.call_states,
        endpoint_id: (s.endpoint_id ?? s.webhook?.id)?.toString(),
        webhook_id: (s.webhook_id ?? s.webhook?.id)?.toString(),
        // Dialpad's call subscription payload contains a `webhook` object when
        // the subscription is properly linked to a webhook. When orphaned,
        // Dialpad returns `webhook: null` even if a stale webhook_id exists.
        webhook_present: s.webhook != null,
        webhook_hook_url: s.webhook?.hook_url,
      })),
    };
  } catch (error) {
    return { success: false, error: extractErrorMessage(error) };
  }
}
