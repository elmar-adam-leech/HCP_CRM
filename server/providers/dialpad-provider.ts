import type { SmsProvider, CallProvider, SmsResult, CallResult } from './interfaces';
import { credentialService } from '../credential-service';
import { getCredentials } from '../dialpad/client';
import { formatToE164, classifyDialpadCallError } from '../dialpad/utils';
import { storage } from '../storage';
import { logger } from '../utils/logger';
import { withRetry } from '../utils/retry';
import { maskPhone } from '../utils/pii-redactor';

const log = logger('DialpadCallProvider');

/**
 * Dialpad provider for SMS functionality
 */
export class DialpadSmsProvider implements SmsProvider {
  readonly providerName = 'dialpad';
  readonly providerType = 'sms' as const;

  async sendSms(options: {
    to: string;
    message: string;
    fromNumber?: string;
    contractorId: string;
    userId?: string;
  }): Promise<SmsResult> {
    try {
      // Validate that the fromNumber belongs to this contractor's organization
      if (options.fromNumber) {
        const phoneNumber = await storage.getDialpadPhoneNumberByNumber(options.contractorId, options.fromNumber);
        if (!phoneNumber) {
          return {
            success: false,
            error: `Phone number ${options.fromNumber} not found in your organization`,
          };
        }
      }
      
      const { apiKey, baseUrl } = await getCredentials(options.contractorId);

      const toE164 = formatToE164(options.to);
      if (!toE164 || !/^\+\d{11,15}$/.test(toE164)) {
        log.warn(`[phone-pipeline] Dialpad sendSms rejected invalid destination: "${maskPhone(options.to)}" → "${maskPhone(toE164)}"`);
        return {
          success: false,
          error: `Cannot send SMS: destination "${options.to}" could not be converted to a valid E.164 number.`,
        };
      }

      const payload = {
        to_numbers: [toE164],
        text: options.message,
        ...(options.fromNumber && { from_number: formatToE164(options.fromNumber) })
      };
      log.info(`[phone-pipeline] Dialpad SMS API call — to_numbers[0]: "${maskPhone(toE164)}"`);

      const response = await withRetry(
        async () => {
          const r = await fetch(`${baseUrl}/sms/`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
          });
          if (r.status === 429 || (r.status >= 500 && r.status < 600)) {
            throw new Error(`Dialpad SMS API returned ${r.status}`);
          }
          return r;
        },
        'DialpadSmsProvider.sendSms',
      );

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
        error: error instanceof Error ? error.message : 'Unknown error occurred',
      };
    }
  }

  async checkConnection(contractorId: string): Promise<{ connected: boolean; error?: string }> {
    try {
      const { apiKey, baseUrl } = await getCredentials(contractorId);
      
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
          error: `Dialpad connection failed: ${response.status}`,
        };
      }

      return { connected: true };
    } catch (error) {
      return {
        connected: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  async isConfigured(contractorId: string): Promise<boolean> {
    try {
      const credentials = await credentialService.getCredentialsWithFallback(contractorId, 'dialpad');
      return !!credentials.api_key;
    } catch {
      return false;
    }
  }
}

/**
 * Tracks which (contractorId, fromNumber) pairs we've already logged a
 * "no dialpadId" message for, so we don't spam the logs on every call attempt.
 */
const unmappedFromNumberLogged = new Set<string>();

/**
 * Dialpad provider for calling functionality
 */
export class DialpadCallProvider implements CallProvider {
  readonly providerName = 'dialpad';
  readonly providerType = 'calling' as const;

  async initiateCall(options: {
    to: string;
    fromNumber?: string;
    autoRecord?: boolean;
    contractorId: string;
    userId?: string;
  }): Promise<CallResult> {
    try {
      log.info(`initiateCall — contractorId: ${options.contractorId}, userId: ${options.userId ?? 'none'}, hasFromNumber: ${!!options.fromNumber}`);
      
      // Validate that the fromNumber belongs to this contractor's organization
      if (options.fromNumber) {
        const phoneNumberCheck = await storage.getDialpadPhoneNumberByNumber(options.contractorId, options.fromNumber);
        if (!phoneNumberCheck) {
          return {
            success: false,
            error: `Phone number ${options.fromNumber} not found in your organization`,
            errorCode: 'permission_denied',
            retryAfterSeconds: 0,
          };
        }
      }
      
      const { apiKey, baseUrl } = await getCredentials(options.contractorId);
      
      // Get user_id from the phone number being called FROM
      // This matches the phone number to its associated Dialpad user
      let dialpadUserId: string | undefined;
      
      if (options.fromNumber) {
        // Look up the phone number in the database to get its dialpad_id
        const phoneNumber = await storage.getDialpadPhoneNumberByNumber(options.contractorId, options.fromNumber);
        if (phoneNumber?.dialpadId) {
          dialpadUserId = phoneNumber.dialpadId;
          log.info(`Using phone number's assigned dialpad user ID (phoneId: ${phoneNumber.id})`);
        } else {
          // Throttle this log: it fires on every call attempt for org-default
          // numbers that are unmapped, which is benign (we fall back to the
          // user-ID path). Only log once per (contractor, number) per process.
          const key = `${options.contractorId}:${options.fromNumber}`;
          if (!unmappedFromNumberLogged.has(key)) {
            unmappedFromNumberLogged.add(key);
            log.info(
              `Phone number lookup returned no dialpadId — fromNumber unmapped ` +
              `(contractorId=${options.contractorId}, fromNumber=${maskPhone(options.fromNumber)}). ` +
              `Falling back to logged-in user's Dialpad ID. ` +
              `(Logged once per process per number.)`
            );
          }
        }
      }
      
      // If phone number has no assigned user (office/department number), use logged-in user's Dialpad ID
      if (!dialpadUserId && options.userId) {
        try {
          // Get the current user's information
          const user = await storage.getUser(options.userId);
          if (user?.email) {
            // Look up this user's Dialpad ID from the synced Dialpad users
            const dialpadUsers = await storage.getDialpadUsers(options.contractorId);
            const dialpadUser = dialpadUsers.find(du => du.email?.toLowerCase() === user.email.toLowerCase());
            if (dialpadUser?.dialpadUserId) {
              dialpadUserId = dialpadUser.dialpadUserId;
              log.info(`Using logged-in user's Dialpad ID (userId: ${options.userId})`);
            } else {
              log.info(`Could not find Dialpad user for logged-in user (userId: ${options.userId})`);
            }
          }
        } catch (err) {
          // Non-fatal: fall through to the global credential fallback below.
          // Log user + contractor context so this is diagnosable without a debugger.
          log.warn(
            `Failed to look up Dialpad user ID — ` +
            `contractorId=${options.contractorId}, userId=${options.userId}, ` +
            `error=${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
      
      // If still no user_id, fall back to global user_id credential
      if (!dialpadUserId) {
        try {
          const userIdCred = await credentialService.getCredential(options.contractorId, 'dialpad', 'user_id');
          dialpadUserId = userIdCred || undefined;
          if (dialpadUserId) {
            log.info('Using global default user ID from credentials');
          }
        } catch (credErr) {
          // Credential lookup can fail if the key doesn't exist (expected) or due
          // to a DB error (unexpected). Log at error level so the latter is visible.
          log.error('Failed to fetch global user_id credential', credErr);
        }
      }

      // user_id is REQUIRED by Dialpad
      if (!dialpadUserId) {
        return {
          success: false,
          error: 'Dialpad user_id is required. Either select a phone number with an assigned user, or configure a default user ID in Settings > Integrations > Dialpad.',
        };
      }

      log.info(`Making call — dialpadUserId: ${dialpadUserId}, hasFromNumber: ${!!options.fromNumber}`);

      // Use the working Google Apps Script format
      const payload = {
        phone_number: formatToE164(options.to),
        from_number: options.fromNumber ? formatToE164(options.fromNumber) : undefined,
        user_id: dialpadUserId,
        action: 'dial'
      };

      // Use singular /call/ endpoint like in Google Apps Script (note trailing slash).
      // no retry on write — retrying a 429/5xx risks duplicate calls and would
      // also defeat the client-side cooldown that Task #647 added. We classify
      // the response below and surface a friendly message instead.
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
        const classified = classifyDialpadCallError(response.status, errorText);
        log.error(
          `Dialpad call failed — status=${response.status} code=${classified.code} body=${errorText}`
        );
        return {
          success: false,
          error: classified.userMessage,
          errorCode: classified.code,
          retryAfterSeconds: classified.retryAfterSeconds,
        };
      }

      const result = await response.json();
      return {
        success: true,
        callId: result.call_id || result.id,
        callUrl: result.call_url,
        provider: this.providerName,
      };
    } catch (error) {
      // Network/transport-level failure (DNS, timeout, etc). Log the raw
      // detail server-side but surface the friendly generic message to the UI
      // so we never leak stack traces or low-level errors into the toast.
      log.error(
        `Dialpad call request threw — ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`
      );
      const classified = classifyDialpadCallError(0, '');
      return {
        success: false,
        error: classified.userMessage,
        errorCode: classified.code,
        retryAfterSeconds: classified.retryAfterSeconds,
      };
    }
  }

  async getCallDetails(callId: string, contractorId: string): Promise<{ success: boolean; callDetails?: any; error?: string }> {
    try {
      const { apiKey, baseUrl } = await getCredentials(contractorId);
      
      const response = await fetch(`${baseUrl}/calls/${callId}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
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
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error occurred',
      };
    }
  }

  async checkConnection(contractorId: string): Promise<{ connected: boolean; error?: string }> {
    try {
      const { apiKey, baseUrl } = await getCredentials(contractorId);
      
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
          error: `Dialpad connection failed: ${response.status}`,
        };
      }

      return { connected: true };
    } catch (error) {
      return {
        connected: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  async isConfigured(contractorId: string): Promise<boolean> {
    try {
      const credentials = await credentialService.getCredentialsWithFallback(contractorId, 'dialpad');
      return !!credentials.api_key;
    } catch {
      return false;
    }
  }

  async getUserCallerIdNumbers(dialpadUserId: string, contractorId: string): Promise<string[]> {
    try {
      const { apiKey, baseUrl } = await getCredentials(contractorId);
      
      const response = await fetch(`${baseUrl}/users/${dialpadUserId}/caller_id_numbers`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        // Returning [] on failure means callers cannot distinguish "user has no numbers"
        // from "API is down". Logging at error level ensures the difference is visible.
        log.error(`Failed to get caller ID numbers for dialpadUserId=${dialpadUserId}: HTTP ${response.status}`);
        return [];
      }

      const result = await response.json();
      const numbers = result.caller_id_numbers || [];
      log.info(`dialpadUserId=${dialpadUserId} has ${numbers.length} authorized caller ID numbers`);
      return numbers;
    } catch (error) {
      log.error('Error getting caller ID numbers', error);
      return [];
    }
  }

  async ensureUserHasAccessToNumber(dialpadUserId: string, phoneNumber: string, contractorId: string): Promise<{ hasAccess: boolean; error?: string }> {
    try {
      const authorizedNumbers = await this.getUserCallerIdNumbers(dialpadUserId, contractorId);
      const formattedNumber = formatToE164(phoneNumber);
      
      const hasAccess = authorizedNumbers.some(num => formatToE164(num) === formattedNumber);
      
      if (hasAccess) {
        log.info(`dialpadUserId=${dialpadUserId} has access to ${formattedNumber}`);
        return { hasAccess: true };
      }

      log.info(`dialpadUserId=${dialpadUserId} does NOT have access to ${formattedNumber} — authorized count: ${authorizedNumbers.length}`);
      
      return { 
        hasAccess: false,
        error: `You don't have permission to call from ${phoneNumber} in Dialpad. Please ask your admin to grant you access to this number in Dialpad settings.`
      };
    } catch (error) {
      log.error('Error checking user access', error);
      return {
        hasAccess: false,
        error: 'Could not verify phone number access. Please try again.'
      };
    }
  }
}