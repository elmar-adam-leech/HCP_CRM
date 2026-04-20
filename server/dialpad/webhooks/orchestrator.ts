/**
 * Dialpad webhooks — orchestrator that registers SMS + call webhooks and
 * subscriptions in one shot, with the office → department → account-level
 * targeting fallback chain. This is the only function that writes to
 * `dialpadWebhookState`.
 *
 * Retry policy: writes never use withRetry — see lifecycle/sms-subscriptions/
 * call-subscriptions modules for details.
 */

import { getCredentials } from '../client';
import { credentialService } from '../../credential-service';
import { storage } from '../../storage';
import { db } from '../../db';
import { dialpadWebhookState } from '@shared/schema';
import { getCompanyOffices, getDepartments } from '../users';
import { logger } from '../../utils/logger';

import { createWebhook } from './lifecycle';
import { createSmsSubscription } from './sms-subscriptions';
import { createCallSubscription } from './call-subscriptions';

const log = logger('DialpadWebhooks');

/**
 * Create webhook and SMS subscription in one call.
 * Embeds the tenant's webhook API key as a query param in the callback URL.
 */
export async function createWebhookWithSubscription(
  contractorId: string,
  direction: 'inbound' | 'outbound' | 'all' = 'inbound',
  baseWebhookUrl?: string
): Promise<{
  success: boolean;
  webhookId?: string;
  subscriptionId?: string;
  hookUrl?: string;
  callWebhookId?: string;
  callSubscriptionId?: string;
  callSubscriptionIds?: string[];
  callSubscriptionActualTargetType?: string;
  callSubscriptionError?: string;
  callSubscriptionWarning?: string;
  error?: string;
}> {
  log.info('[createWebhookWithSubscription] Starting webhook creation', { contractorId, direction, baseWebhookUrl });

  let webhookApiKey: string | null = null;
  try {
    webhookApiKey = await credentialService.getCredential(contractorId, 'dialpad', 'webhook_api_key');
  } catch (err) {
    log.warn('[createWebhookWithSubscription] Could not retrieve webhook_api_key from CredentialService', err);
  }

  if (!webhookApiKey) {
    log.warn('[createWebhookWithSubscription] No webhook_api_key found; registering callback URLs without key (requests will be rejected with 401)');
  }

  // -----------------------------------------------------------------------
  // SMS webhook
  // -----------------------------------------------------------------------
  let smsHookUrl = baseWebhookUrl
    ? `${baseWebhookUrl}/api/webhooks/dialpad/sms/${contractorId}`
    : undefined;

  if (webhookApiKey && smsHookUrl) {
    smsHookUrl = `${smsHookUrl}?key=${encodeURIComponent(webhookApiKey)}`;
    log.info('[createWebhookWithSubscription] Embedded webhook_api_key in SMS callback URL');
  }

  const smsWebhookResult = await createWebhook(contractorId, smsHookUrl, undefined, undefined);
  log.info('[createWebhookWithSubscription] SMS webhook creation result:', { success: smsWebhookResult.success, webhookId: smsWebhookResult.webhookId });

  if (!smsWebhookResult.success || !smsWebhookResult.webhookId) {
    return { success: false, error: smsWebhookResult.error || 'Failed to create SMS webhook' };
  }

  const subscriptionResult = await createSmsSubscription(
    contractorId,
    smsWebhookResult.webhookId,
    direction,
    smsWebhookResult.hookUrl
  );

  if (!subscriptionResult.success) {
    return {
      success: false,
      webhookId: smsWebhookResult.webhookId,
      error: subscriptionResult.error || 'Failed to create SMS subscription',
    };
  }

  // -----------------------------------------------------------------------
  // Call webhook — separate URL so Dialpad routes call events independently
  // -----------------------------------------------------------------------
  let callHookUrl = baseWebhookUrl
    ? `${baseWebhookUrl}/api/webhooks/dialpad/calls/${contractorId}`
    : undefined;

  if (webhookApiKey && callHookUrl) {
    callHookUrl = `${callHookUrl}?key=${encodeURIComponent(webhookApiKey)}`;
    log.info('[createWebhookWithSubscription] Embedded webhook_api_key in calls callback URL');
  }

  let callWebhookId: string | undefined;
  let callSubscriptionId: string | undefined;
  let callSubscriptionIds: string[] | undefined;
  let callSubscriptionActualTargetType: string | undefined;
  let callSubscriptionError: string | undefined;
  let callSubscriptionWarning: string | undefined;

  if (callHookUrl) {
    const callWebhookResult = await createWebhook(contractorId, callHookUrl, undefined, undefined);
    log.info('[createWebhookWithSubscription] Call webhook creation result:', { success: callWebhookResult.success, webhookId: callWebhookResult.webhookId });

    if (callWebhookResult.success && callWebhookResult.webhookId) {
      callWebhookId = callWebhookResult.webhookId;

      const offices = await getCompanyOffices(contractorId);
      log.info('[createWebhookWithSubscription] Fetched offices for call subscription', {
        count: offices.length,
        officeIds: offices.map(o => o.id),
      });

      const callSubErrors: string[] = [];

      // Resolve the canonical Dialpad user ID for potential user-level fallback subscription.
      // We first try GET /users/me to get the API-key owner (most reliable canonical user).
      // If that fails, fall back to the first synced local Dialpad user for this contractor.
      let dialpadUserIdForFallback: string | undefined;
      try {
        const { apiKey: meApiKey, baseUrl: meBaseUrl } = await getCredentials(contractorId);
        const meRes = await fetch(`${meBaseUrl}/users/me`, {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${meApiKey}`, 'Content-Type': 'application/json' },
        });
        if (meRes.ok) {
          const meData = await meRes.json();
          const meId = meData.id?.toString();
          if (meId) {
            dialpadUserIdForFallback = meId;
            log.info('[createWebhookWithSubscription] Resolved canonical Dialpad user ID via /users/me', { dialpadUserId: dialpadUserIdForFallback });
          }
        } else {
          log.info('[createWebhookWithSubscription] /users/me not available, falling back to local Dialpad user lookup', { status: meRes.status });
        }
      } catch (err) {
        log.warn('[createWebhookWithSubscription] Failed to fetch /users/me for fallback user ID resolution', err);
      }

      if (!dialpadUserIdForFallback) {
        try {
          const localDialpadUsers = await storage.getDialpadUsers(contractorId);
          if (localDialpadUsers.length > 0) {
            dialpadUserIdForFallback = localDialpadUsers[0].dialpadUserId;
            log.info('[createWebhookWithSubscription] Using first local dialpad user as fallback user ID', { dialpadUserId: dialpadUserIdForFallback });
          } else {
            log.warn('[createWebhookWithSubscription] No local dialpad users found for user-level fallback — user-level subscription will be skipped');
          }
        } catch (err) {
          log.warn('[createWebhookWithSubscription] Failed to fetch local dialpad users for fallback', err);
        }
      }

      if (offices.length > 0) {
        const subscriptionIds: string[] = [];
        const officeErrors: string[] = [];
        let anyOfficeWebhookLinked = false;
        for (const office of offices) {
          const officeId = office.office_id ?? office.id;
          const callSubResult = await createCallSubscription(
            contractorId,
            callWebhookResult.webhookId,
            callWebhookResult.hookUrl,
            'office',
            officeId
          );
          if (callSubResult.success) {
            if (callSubResult.subscriptionId) subscriptionIds.push(callSubResult.subscriptionId);
            if (callSubResult.webhookLinked) anyOfficeWebhookLinked = true;
            if (!callSubscriptionActualTargetType && callSubResult.actualTargetType) {
              callSubscriptionActualTargetType = callSubResult.actualTargetType;
            }
            log.info('[createWebhookWithSubscription] Call subscription created for office', {
              officeId,
              officeName: office.name,
              subscriptionId: callSubResult.subscriptionId,
              actualTargetType: callSubResult.actualTargetType,
              webhookLinked: callSubResult.webhookLinked,
            });
          } else {
            officeErrors.push(`office ${office.name} (${officeId}): ${callSubResult.error}`);
            log.warn('[createWebhookWithSubscription] Failed to create call subscription for office', {
              officeId,
              officeName: office.name,
              error: callSubResult.error,
            });
          }
        }

        if (subscriptionIds.length > 0) {
          callSubscriptionId = subscriptionIds[0];
          callSubscriptionIds = subscriptionIds;

          // If office subscriptions were created but none linked the webhook, try user-level fallback
          if (!anyOfficeWebhookLinked && !dialpadUserIdForFallback) {
            callSubscriptionWarning = 'Office subscriptions created but none have a linked webhook URL, and no Dialpad user ID is available for user-level fallback. Call events may not be delivered. Re-sync Dialpad users to resolve.';
            log.warn('[createWebhookWithSubscription] Office subscriptions unlinked and no user ID available for fallback — operator remediation required');
          }
          if (!anyOfficeWebhookLinked && dialpadUserIdForFallback) {
            log.warn('[createWebhookWithSubscription] Office subscription(s) have no webhook linked — trying user-level fallback', { dialpadUserId: dialpadUserIdForFallback });
            const userSubResult = await createCallSubscription(
              contractorId,
              callWebhookResult.webhookId,
              callWebhookResult.hookUrl,
              'user',
              dialpadUserIdForFallback
            );
            if (userSubResult.success && userSubResult.subscriptionId) {
              callSubscriptionIds = [...subscriptionIds, userSubResult.subscriptionId];
              callSubscriptionActualTargetType = 'user';
              log.info('[createWebhookWithSubscription] User-level fallback subscription created', {
                subscriptionId: userSubResult.subscriptionId,
                webhookLinked: userSubResult.webhookLinked,
              });
              if (!userSubResult.webhookLinked) {
                callSubscriptionWarning = 'Office and user-level subscriptions created but neither has a linked webhook URL. Call events may not be delivered.';
                log.warn('[createWebhookWithSubscription] User-level fallback also has no webhook linked');
              }
            } else {
              log.warn('[createWebhookWithSubscription] User-level fallback subscription failed', { error: userSubResult.error });
            }
          }
        } else {
          // All office-level subscriptions failed — try department targeting next
          log.warn('[createWebhookWithSubscription] Office targeting failed for all offices, trying department targeting', { officeErrors });
          const departments = await getDepartments(contractorId);
          log.info('[createWebhookWithSubscription] Fetched departments for fallback', {
            count: departments.length,
            departmentIds: departments.map(d => d.id),
          });

          const deptSubscriptionIds: string[] = [];
          const deptErrors: string[] = [];
          for (const dept of departments) {
            const deptId = dept.id;
            const callSubResult = await createCallSubscription(
              contractorId,
              callWebhookResult.webhookId,
              callWebhookResult.hookUrl,
              'department',
              deptId
            );
            if (callSubResult.success) {
              if (callSubResult.subscriptionId) deptSubscriptionIds.push(callSubResult.subscriptionId);
              if (!callSubscriptionActualTargetType && callSubResult.actualTargetType) {
                callSubscriptionActualTargetType = callSubResult.actualTargetType;
              }
              log.info('[createWebhookWithSubscription] Call subscription created for department', {
                deptId,
                deptName: dept.name,
                subscriptionId: callSubResult.subscriptionId,
                actualTargetType: callSubResult.actualTargetType,
              });
            } else {
              deptErrors.push(`department ${dept.name} (${deptId}): ${callSubResult.error}`);
              log.warn('[createWebhookWithSubscription] Failed to create call subscription for department', {
                deptId,
                deptName: dept.name,
                error: callSubResult.error,
              });
            }
          }

          if (deptSubscriptionIds.length > 0) {
            callSubscriptionId = deptSubscriptionIds[0];
            callSubscriptionIds = deptSubscriptionIds;
          } else {
            // Both office and department targeting failed — try no-target as final fallback
            log.warn('[createWebhookWithSubscription] Department targeting also failed, trying no-target fallback', { deptErrors });
            const fallbackResult = await createCallSubscription(
              contractorId,
              callWebhookResult.webhookId,
              callWebhookResult.hookUrl
            );
            if (fallbackResult.success) {
              callSubscriptionId = fallbackResult.subscriptionId;
              callSubscriptionIds = fallbackResult.subscriptionId ? [fallbackResult.subscriptionId] : [];
              callSubscriptionActualTargetType = fallbackResult.actualTargetType ?? 'account';
              const targetingErrors = [...officeErrors, ...deptErrors].join('; ');
              callSubscriptionWarning = `Targeted subscription failed; using account-level subscription. Dialpad errors: ${targetingErrors}`;
              log.warn('[createWebhookWithSubscription] No-target fallback call subscription created (account-level coverage)', { callSubscriptionId, targetingErrors });
            } else {
              callSubErrors.push(...officeErrors, ...deptErrors, `no-target fallback: ${fallbackResult.error}`);
            }
          }
        }
      } else {
        log.warn('[createWebhookWithSubscription] No offices found; creating call subscription without target as fallback');
        const callSubResult = await createCallSubscription(
          contractorId,
          callWebhookResult.webhookId,
          callWebhookResult.hookUrl
        );
        if (callSubResult.success) {
          callSubscriptionId = callSubResult.subscriptionId;
          callSubscriptionIds = callSubResult.subscriptionId ? [callSubResult.subscriptionId] : [];
          callSubscriptionActualTargetType = callSubResult.actualTargetType ?? 'account';
          log.info('[createWebhookWithSubscription] Fallback call subscription created', { callSubscriptionId, actualTargetType: callSubscriptionActualTargetType });
        } else {
          callSubErrors.push(`fallback (no offices): ${callSubResult.error}`);
          log.warn('[createWebhookWithSubscription] Failed to create fallback call subscription', callSubResult.error);
        }
      }

      if (callSubErrors.length > 0 && (!callSubscriptionIds || callSubscriptionIds.length === 0)) {
        callSubscriptionError = `No call subscriptions created: ${callSubErrors.join('; ')}`;
        log.error('[createWebhookWithSubscription] All call subscriptions failed', { callSubscriptionError });
      }
    } else {
      callSubscriptionError = callWebhookResult.error || 'Failed to create call webhook';
      log.warn('[createWebhookWithSubscription] Failed to create call webhook', callSubscriptionError);
    }
  }

  // Persist the IDs we just registered so the diagnostic endpoint can detect drift
  // even when Dialpad's own list call fails (e.g. credential rotation, transient 5xx).
  try {
    await db.insert(dialpadWebhookState).values({
      contractorId,
      smsWebhookId: smsWebhookResult.webhookId ?? null,
      smsSubscriptionId: subscriptionResult.subscriptionId ?? null,
      callWebhookId: callWebhookId ?? null,
      callSubscriptionIds: callSubscriptionIds ?? null,
      lastRegisteredCallUrl: callHookUrl ?? null,
      lastRegisteredSmsUrl: smsWebhookResult.hookUrl ?? null,
      lastRegisteredAt: new Date(),
    }).onConflictDoUpdate({
      target: dialpadWebhookState.contractorId,
      set: {
        smsWebhookId: smsWebhookResult.webhookId ?? null,
        smsSubscriptionId: subscriptionResult.subscriptionId ?? null,
        callWebhookId: callWebhookId ?? null,
        callSubscriptionIds: callSubscriptionIds ?? null,
        lastRegisteredCallUrl: callHookUrl ?? null,
        lastRegisteredSmsUrl: smsWebhookResult.hookUrl ?? null,
        lastRegisteredAt: new Date(),
        updatedAt: new Date(),
      },
    });
  } catch (err) {
    log.warn('[createWebhookWithSubscription] Failed to persist dialpad_webhook_state row', err);
  }

  return {
    success: true,
    webhookId: smsWebhookResult.webhookId,
    subscriptionId: subscriptionResult.subscriptionId,
    hookUrl: smsWebhookResult.hookUrl,
    callWebhookId,
    callSubscriptionId,
    callSubscriptionIds,
    callSubscriptionActualTargetType,
    callSubscriptionError,
    callSubscriptionWarning,
  };
}
