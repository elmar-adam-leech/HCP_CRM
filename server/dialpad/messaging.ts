/**
 * Dialpad module — SMS sending, call initiation, SMS retrieval.
 *
 * Retry policy:
 *   - Write operations (sendSms, initiateCall via POST) do NOT use withRetry.
 *     Retrying writes risks duplicate messages or double calls. Each call site
 *     is annotated with "no retry on write" to make the intent explicit.
 *   - Read operations (listRecentSms, getSmsById) do not use withRetry either
 *     because they are best-effort and failures are non-fatal.
 */

import { getCredentials } from './client';
import { extractErrorMessage } from './utils';
import { storage } from '../storage';
import { normalizePhoneNumber } from '../utils/phone-normalizer';
import { logger } from '../utils/logger';
import { maskPhone } from '../utils/pii-redactor';
import type { LegacyDialpadMessage, LegacyDialpadResponse } from './types';
import { checkUserPhonePermission } from './permissions';

const log = logger('DialpadMessaging');

/**
 * Send SMS using Dialpad API.
 * no retry on write — retrying risks duplicate messages.
 */
export async function sendSms(options: {
  to: string;
  message: string;
  fromNumber: string;
  contractorId: string;
  userId?: string;
}): Promise<{ success: boolean; messageId?: string; error?: string }> {
  try {
    if (options.userId) {
      const phoneNumber = await storage.getDialpadPhoneNumberByNumber(options.contractorId, options.fromNumber);
      if (phoneNumber) {
        const permissionCheck = await checkUserPhonePermission(options.userId, phoneNumber.id, 'sms');
        if (!permissionCheck.hasPermission) {
          return {
            success: false,
            error: permissionCheck.reason || 'Permission denied',
          };
        }
      }
    }

    const { apiKey, baseUrl } = await getCredentials(options.contractorId);

    const payload = {
      to_numbers: [options.to],
      from_number: options.fromNumber,
      text: options.message,
    };

    // no retry on write
    const response = await fetch(`${baseUrl}/sms/`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return {
        success: false,
        error: `Failed to send SMS: ${response.status} ${errorText}`,
      };
    }

    const result = await response.json();
    return {
      success: true,
      messageId: result.message_id || result.id,
    };
  } catch (error) {
    return {
      success: false,
      error: extractErrorMessage(error),
    };
  }
}

/**
 * Initiate an outbound call via Dialpad.
 * no retry on write — retrying risks duplicate calls.
 */
export async function initiateCall(options: {
  to: string;
  fromNumber: string;
  contractorId: string;
  userId?: string;
  dialpadUserId?: string;
}): Promise<{ success: boolean; callId?: string; error?: string }> {
  try {
    if (options.userId) {
      const phoneNumber = await storage.getDialpadPhoneNumberByNumber(options.contractorId, options.fromNumber);
      if (phoneNumber) {
        const permissionCheck = await checkUserPhonePermission(options.userId, phoneNumber.id, 'call');
        if (!permissionCheck.hasPermission) {
          return {
            success: false,
            error: permissionCheck.reason || 'Permission denied',
          };
        }
      }
    }

    const { apiKey, baseUrl } = await getCredentials(options.contractorId);

    const payload = {
      phone_number: options.to,
      from_number: options.fromNumber,
      action: 'dial',
      ...(options.dialpadUserId && { user_id: options.dialpadUserId }),
    };

    // no retry on write
    const response = await fetch(`${baseUrl}/call/`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return {
        success: false,
        error: `Failed to initiate call: ${response.status} ${errorText}`,
      };
    }

    const result = await response.json();
    return {
      success: true,
      callId: result.call_id || result.id,
    };
  } catch (error) {
    return {
      success: false,
      error: extractErrorMessage(error),
    };
  }
}

/**
 * List recent SMS messages from Dialpad API.
 */
export async function listRecentSms(contractorId: string, limit: number = 10): Promise<any[]> {
  try {
    const { apiKey, baseUrl } = await getCredentials(contractorId);

    const response = await fetch(`${baseUrl}/sms?limit=${limit}&sort=-created_date`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      log.error(`Failed to list SMS: ${response.status}`);
      return [];
    }

    const data = await response.json();
    return data.items || [];
  } catch (error) {
    log.error('Error listing SMS messages:', error);
    return [];
  }
}

/**
 * Get SMS message content by ID from Dialpad API.
 */
export async function getSmsById(
  contractorId: string,
  smsId: string
): Promise<{ text?: string; error?: string }> {
  try {
    const { apiKey, baseUrl } = await getCredentials(contractorId);

    const response = await fetch(`${baseUrl}/sms/${smsId}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      log.error(`Failed to fetch SMS ${smsId}: ${response.status}`);
      return { error: `Failed to fetch SMS: ${response.status}` };
    }

    const data = await response.json();
    return { text: data.text };
  } catch (error) {
    log.error(`Error fetching SMS ${smsId}:`, error);
    return { error: extractErrorMessage(error) };
  }
}

/**
 * Send a text message via Dialpad SMS API (legacy signature).
 * Used by messaging routes when sending outbound texts.
 * no retry on write — retrying risks duplicate messages.
 */
export async function sendText(
  toNumber: string,
  message: string,
  fromNumber?: string,
  tenantId?: string
): Promise<LegacyDialpadResponse> {
  try {
    const { apiKey, baseUrl } = await getCredentials(tenantId || '');

    const formattedToNumber = normalizePhoneNumber(toNumber);
    const formattedFromNumber = fromNumber ? normalizePhoneNumber(fromNumber) : undefined;

    const payload: LegacyDialpadMessage = {
      to_numbers: [formattedToNumber],
      text: message,
    };

    if (formattedFromNumber) {
      payload.from_number = formattedFromNumber;
    }

    log.info('Dialpad SMS Payload:', JSON.stringify({
      to_numbers: [maskPhone(formattedToNumber)],
      from_number: formattedFromNumber ? maskPhone(formattedFromNumber) : undefined,
      text: '[redacted]',
    }, null, 2));
    log.info('Dialpad SMS URL:', `${baseUrl}/sms/`);
    log.info('Formatted numbers:', {
      original_to: maskPhone(toNumber),
      formatted_to: maskPhone(formattedToNumber),
      original_from: maskPhone(fromNumber),
      formatted_from: maskPhone(formattedFromNumber),
    });

    // no retry on write
    const response = await fetch(`${baseUrl}/sms/`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    log.info(`Dialpad API Response Status: ${response.status} ${response.statusText}`);

    if (!response.ok) {
      const errorText = await response.text();
      log.error(`Dialpad API Error: ${response.status} ${errorText}`);
      return {
        success: false,
        error: `Failed to send message: ${response.status} ${errorText}`,
      };
    }

    const responseText = await response.text();
    log.info('Dialpad API Response Body (raw):', responseText);

    let result: any = {};
    if (responseText) {
      try {
        result = JSON.parse(responseText);
      } catch (e) {
        log.error('Failed to parse Dialpad response as JSON:', e);
      }
    }

    return {
      success: true,
      message: 'Text message sent successfully',
      messageId: result.id || result.message_id || result.sms_id || null,
    };
  } catch (error) {
    log.error('Error sending text:', error);
    return {
      success: false,
      error: extractErrorMessage(error),
    };
  }
}

/**
 * Get call details from Dialpad API.
 */
export async function getCallDetails(
  callId: string,
  tenantId?: string
): Promise<LegacyDialpadResponse & { callDetails?: any }> {
  try {
    const { apiKey, baseUrl } = await getCredentials(tenantId || '');

    const response = await fetch(`${baseUrl}/calls/${callId}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      log.error(`Dialpad Get Call Error: ${response.status} ${errorText}`);
      return {
        success: false,
        error: `Failed to get call details: ${response.status} ${errorText}`,
      };
    }

    const result = await response.json();
    return {
      success: true,
      callDetails: result,
    };
  } catch (error) {
    log.error('Error getting call details:', error);
    return {
      success: false,
      error: extractErrorMessage(error),
    };
  }
}

/**
 * Check whether Dialpad credentials are valid.
 */
export async function checkConnection(
  tenantId?: string
): Promise<{ connected: boolean; error?: string }> {
  try {
    const { apiKey, baseUrl } = await getCredentials(tenantId || '');

    const response = await fetch(`${baseUrl}/me`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      return {
        connected: false,
        error: `Dialpad API connection failed: ${response.status}`,
      };
    }

    return { connected: true };
  } catch (error) {
    return {
      connected: false,
      error: extractErrorMessage(error),
    };
  }
}
