/**
 * Dialpad module — phone number fetch, sync, and availability.
 *
 * Retry policy:
 *   - withRetry is applied to read operations (fetch, getCompanyNumbers, getAvailablePhoneNumbers).
 *   - Write operations (sync upserts) do NOT use withRetry — DB writes are not idempotent here.
 */

import { getCredentials, dialpadFetch } from './client';
import { extractErrorMessage } from './utils';
import { storage } from '../storage';
import { withRetry } from '../utils/retry';

import { logger } from '../utils/logger';
import type {
  DialpadNumber,
  DialpadApiResponse,
  LegacyDialpadPhoneNumber,
} from './types';
import type {
  DialpadPhoneNumber,
  InsertDialpadPhoneNumber,
} from '@shared/schema';

const log = logger('DialpadNumbers');

/**
 * Fetch all phone numbers from Dialpad using the list endpoint.
 * withRetry is applied — this is a read-only operation.
 */
export async function fetchDialpadNumbers(contractorId: string): Promise<DialpadNumber[]> {
  const { apiKey, baseUrl } = await getCredentials(contractorId);

  const response = await withRetry(
    () => dialpadFetch(`${baseUrl}/numbers?limit=1000`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    }),
    'Dialpad fetchDialpadNumbers'
  );

  if (!response.ok) {
    throw new Error(`Failed to fetch Dialpad numbers: ${response.status}`);
  }

  const data: DialpadApiResponse<DialpadNumber> = await response.json();
  return data.items || [];
}

/**
 * Get detailed phone number info including SMS capabilities from the detail endpoint.
 * withRetry is applied — this is a read-only operation.
 * Returns null when the number is not found (404); 404 is not retried (not a transient error).
 */
export async function getPhoneNumberDetails(
  contractorId: string,
  phoneNumber: string
): Promise<DialpadNumber | null> {
  const { apiKey, baseUrl } = await getCredentials(contractorId);

  // 404 responses are returned as-is by dialpadFetch (only 429/5xx throw).
  const response = await withRetry(
    () => dialpadFetch(`${baseUrl}/phone-numbers/${phoneNumber}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    }),
    'Dialpad getPhoneNumberDetails'
  );

  if (!response.ok) {
    if (response.status === 404) {
      return null;
    }
    throw new Error(`Failed to fetch phone number details: ${response.status}`);
  }

  return await response.json();
}

/**
 * Sync phone numbers from Dialpad to local database.
 * Each number is upserted; partial failures are collected in `errors`.
 */
export async function syncPhoneNumbers(contractorId: string): Promise<{
  fetched: number;
  synced: number;
  phoneNumbers: DialpadPhoneNumber[];
  errors: string[];
}> {
  const errors: string[] = [];
  let synced = 0;

  const dialpadNumbers = await fetchDialpadNumbers(contractorId);
  const phoneNumbers: DialpadPhoneNumber[] = [];
  const totalFetched = dialpadNumbers.length;

  for (const dialpadNumber of dialpadNumbers) {
    try {
      const details = await getPhoneNumberDetails(contractorId, dialpadNumber.number);

      let userId: string | null = null;
      if (dialpadNumber.target_type === 'user' && dialpadNumber.target_id) {
        userId = String(dialpadNumber.target_id);
        log.info(`[sync] Number ${dialpadNumber.number} mapped to user ID: ${userId} (target_type=${dialpadNumber.target_type})`);
      } else {
        log.info(`[sync] Number ${dialpadNumber.number} has no user assignment (target_type=${dialpadNumber.target_type || 'none'}, target_id=${dialpadNumber.target_id || 'none'})`);
      }

      if (!details) {
        log.warn(`[sync] No detail response for ${dialpadNumber.number} — using list-endpoint fields for capabilities`);
      }

      // Prefer list-endpoint fields as the primary source for SMS/call capabilities
      // because the detail endpoint (/phone-numbers/{number}) returns 404 for
      // shared/department numbers and silently falls back to false.
      const phoneNumberData: InsertDialpadPhoneNumber = {
        contractorId,
        phoneNumber: dialpadNumber.number,
        dialpadId: userId,
        displayName: dialpadNumber.number,
        department: undefined,
        canSendSms: dialpadNumber.can_send_sms ?? details?.can_send_sms ?? false,
        canReceiveSms: dialpadNumber.can_receive_sms ?? details?.can_receive_sms ?? false,
        canMakeCalls: dialpadNumber.can_make_calls ?? details?.can_make_calls ?? true,
        canReceiveCalls: dialpadNumber.can_receive_calls ?? details?.can_receive_calls ?? true,
        isActive: true,
        lastSyncAt: new Date(),
      };
      log.info(
        `[sync] ${dialpadNumber.number} capabilities — canSendSms:${phoneNumberData.canSendSms} ` +
        `canReceiveSms:${phoneNumberData.canReceiveSms} canMakeCalls:${phoneNumberData.canMakeCalls} ` +
        `(source: list=${JSON.stringify({ s: dialpadNumber.can_send_sms, r: dialpadNumber.can_receive_sms })} ` +
        `detail=${JSON.stringify({ s: details?.can_send_sms, r: details?.can_receive_sms })})`
      );

      const existing = await storage.getDialpadPhoneNumberByNumber(contractorId, dialpadNumber.number);
      let phoneNumber: DialpadPhoneNumber;

      if (existing) {
        phoneNumber = await storage.updateDialpadPhoneNumber(existing.id, {
          ...phoneNumberData,
          lastSyncAt: new Date(),
        });
      } else {
        phoneNumber = await storage.createDialpadPhoneNumber(phoneNumberData);
      }

      phoneNumbers.push(phoneNumber);
      synced++;
    } catch (err) {
      errors.push(`Failed to sync number ${dialpadNumber.number}: ${extractErrorMessage(err)}`);
    }
  }

  return { fetched: totalFetched, synced, phoneNumbers, errors };
}

/**
 * Get phone numbers from Dialpad API v2 using withRetry for resilience.
 * Maps to the legacy LegacyDialpadPhoneNumber shape used by some routes.
 */
export async function getCompanyNumbers(tenantId: string): Promise<LegacyDialpadPhoneNumber[]> {
  try {
    const { apiKey, baseUrl } = await getCredentials(tenantId);

    const response = await withRetry(
      () => dialpadFetch(`${baseUrl}/numbers?limit=1000`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
      }),
      'Dialpad getCompanyNumbers'
    );

    if (response.ok) {
      const result = await response.json();
      log.info('Dialpad v2/numbers API Success:', result);

      const numbers = result.items || result.data || result;
      if (Array.isArray(numbers)) {
        if (numbers.length > 0) {
          log.info('Sample phone number from API:', JSON.stringify(numbers[0], null, 2));
        }

        return numbers.map((num: any) => {
          log.info(`Processing number ${num.number}: sms_enabled=${num.sms_enabled}, sms_capable=${num.sms_capable}, can_send_sms=${num.can_send_sms}`);

          const smsEnabled = !!(num.sms_enabled === true || num.sms_capable === true || num.can_send_sms === true);

          let userId = null;
          if (num.target_type === 'user' && num.target_id) {
            userId = num.target_id;
          } else if (num.assigned_to || num.owner || num.user_id) {
            userId = num.assigned_to || num.owner || num.user_id;
          }

          return {
            id: num.id,
            number: num.number,
            display_name: num.display_name || num.name || num.number,
            type: num.type || 'company',
            sms_enabled: smsEnabled,
            state: num.state || 'active',
            department: num.department || num.dept_name || null,
            assigned_to: userId,
          };
        });
      }
    } else {
      log.error(`Dialpad v2/numbers API Error: ${response.status} ${await response.text()}`);
    }

    return [];
  } catch (error) {
    log.error('Error fetching Dialpad v2 numbers:', error);
    return [];
  }
}

/**
 * Get available phone numbers for texting and calling.
 * Uses cached DB data for performance; falls back to live API when cache is empty.
 */
export async function getAvailablePhoneNumbers(
  tenantId: string,
  action: 'sms' | 'call' = 'sms'
): Promise<LegacyDialpadPhoneNumber[]> {
  try {
    const cachedNumbers = await storage.getDialpadPhoneNumbers(tenantId);

    if (cachedNumbers.length > 0) {
      const filteredNumbers = cachedNumbers.filter(num => {
        if (!num.phoneNumber || !num.isActive) return false;
        if (action === 'sms') return num.canSendSms === true || num.canSendSms === null;
        return num.canMakeCalls === true || num.canMakeCalls === null;
      });

      log.info(`Found ${filteredNumbers.length} cached ${action}-capable phone numbers for tenant ${tenantId}`);
      return filteredNumbers.map(num => ({
        id: parseInt(num.dialpadId || '0') || 0,
        number: num.phoneNumber,
        display_name: num.displayName || num.phoneNumber,
        type: 'user',
        sms_enabled: num.canSendSms,
        state: num.isActive ? 'active' : 'inactive',
      }));
    }

    log.info(`No cached phone numbers found for tenant ${tenantId}, falling back to live API`);
    const numbers = await getCompanyNumbers(tenantId);

    const filteredNumbers = numbers.filter(num => {
      if (!num.number || num.state !== 'active') return false;
      if (action === 'sms') return num.sms_enabled === true || num.sms_enabled === undefined;
      return true;
    });

    log.info(`Found ${filteredNumbers.length} ${action}-capable phone numbers for tenant ${tenantId}`);
    return filteredNumbers;
  } catch (error) {
    log.error('Error getting available phone numbers:', error);
    return [];
  }
}
