import type { SmsProvider, CallProvider, SmsResult, CallResult } from './interfaces';
import { credentialService } from '../credential-service';
import { getTwilioCredentials, twilioForm, twilioGet } from '../twilio/client';
import { formatToE164, classifyTwilioCallError } from '../twilio/utils';
import { getPublicBaseUrl } from '../utils/public-base-url';
import { storage } from '../storage';
import { logger } from '../utils/logger';
import { withRetry } from '../utils/retry';
import { maskPhone } from '../utils/pii-redactor';

const log = logger('TwilioProvider');

/**
 * Twilio provider for SMS functionality. Sends via the Twilio Messages REST API
 * (form-encoded, Basic auth). Inbound SMS is ingested by the Twilio SMS webhook.
 */
export class TwilioSmsProvider implements SmsProvider {
  readonly providerName = 'twilio';
  readonly providerType = 'sms' as const;

  async sendSms(options: {
    to: string;
    message: string;
    fromNumber?: string;
    contractorId: string;
    userId?: string;
  }): Promise<SmsResult> {
    try {
      if (options.fromNumber) {
        const phoneNumber = await storage.getTwilioPhoneNumberByNumber(options.contractorId, options.fromNumber);
        if (!phoneNumber) {
          return { success: false, error: `Phone number ${options.fromNumber} not found in your organization` };
        }
      }

      const creds = await getTwilioCredentials(options.contractorId);

      const toE164 = formatToE164(options.to);
      if (!toE164 || !/^\+\d{11,15}$/.test(toE164)) {
        log.warn(`[phone-pipeline] Twilio sendSms rejected invalid destination: "${maskPhone(options.to)}" → "${maskPhone(toE164)}"`);
        return {
          success: false,
          error: `Cannot send SMS: destination "${options.to}" could not be converted to a valid E.164 number.`,
        };
      }

      const fromE164 = options.fromNumber ? formatToE164(options.fromNumber) : undefined;
      log.info(`[phone-pipeline] Twilio SMS API call — to: "${maskPhone(toE164)}"`);

      const response = await withRetry(
        async () => {
          const r = await twilioForm(creds, '/Messages.json', {
            To: toE164,
            From: fromE164,
            Body: options.message,
          });
          if (r.status === 429 || (r.status >= 500 && r.status < 600)) {
            throw new Error(`Twilio SMS API returned ${r.status}`);
          }
          return r;
        },
        'TwilioSmsProvider.sendSms',
      );

      if (!response.ok) {
        const errorText = await response.text();
        return { success: false, error: `Failed to send SMS: ${response.status} ${errorText}` };
      }

      const result = await response.json();
      return { success: true, messageId: result.sid };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error occurred' };
    }
  }

  async checkConnection(contractorId: string): Promise<{ connected: boolean; error?: string }> {
    try {
      const creds = await getTwilioCredentials(contractorId);
      const response = await twilioGet(creds, '.json');
      if (!response.ok) {
        return { connected: false, error: `Twilio connection failed: ${response.status}` };
      }
      return { connected: true };
    } catch (error) {
      return { connected: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  async isConfigured(contractorId: string): Promise<boolean> {
    try {
      const credentials = await credentialService.getCredentialsWithFallback(contractorId, 'twilio');
      return !!(credentials.account_sid && credentials.auth_token);
    } catch {
      return false;
    }
  }
}

/**
 * Twilio provider for calling functionality using the BRIDGE model:
 *   1. We POST to Twilio /Calls.json with To = the rep's phone (twilioPhoneToRing)
 *      and From = the contractor's Twilio caller-ID number.
 *   2. When the rep answers, Twilio fetches our bridge TwiML webhook, which
 *      <Dial>s the customer to connect the two legs.
 *   3. If the contractor has recording enabled, the bridge leg is recorded in
 *      both directions and posted to the recording-status webhook.
 *
 * There is no WebRTC — the rep talks on their own phone.
 */
export class TwilioCallProvider implements CallProvider {
  readonly providerName = 'twilio';
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

      // Validate the caller-ID number belongs to this contractor.
      if (options.fromNumber) {
        const phoneCheck = await storage.getTwilioPhoneNumberByNumber(options.contractorId, options.fromNumber);
        if (!phoneCheck) {
          return {
            success: false,
            error: `Phone number ${options.fromNumber} not found in your organization`,
            errorCode: 'permission_denied',
            retryAfterSeconds: 0,
          };
        }
      }

      const customerE164 = formatToE164(options.to);
      if (!customerE164 || !/^\+\d{11,15}$/.test(customerE164)) {
        return { success: false, error: `Invalid destination number "${options.to}".`, errorCode: 'unknown', retryAfterSeconds: 0 };
      }

      // Resolve the rep's phone to ring (bridge model). Per-user setting first.
      let repPhone: string | undefined;
      if (options.userId) {
        const uc = await storage.getUserContractor(options.userId, options.contractorId);
        if (uc?.twilioPhoneToRing) repPhone = formatToE164(uc.twilioPhoneToRing);
      }
      if (!repPhone || !/^\+\d{11,15}$/.test(repPhone)) {
        return {
          success: false,
          error: 'No phone number configured to ring. Set your "Phone to ring" in Settings before placing Twilio calls.',
          errorCode: 'permission_denied',
          retryAfterSeconds: 0,
        };
      }

      // The customer-facing caller ID is the contractor's Twilio number
      // (explicit fromNumber, or the org default).
      let callerId = options.fromNumber ? formatToE164(options.fromNumber) : undefined;
      if (!callerId) {
        const contractor = await storage.getContractor(options.contractorId);
        if (contractor?.defaultTwilioNumber) callerId = formatToE164(contractor.defaultTwilioNumber);
      }
      if (!callerId) {
        return {
          success: false,
          error: 'No Twilio caller-ID number configured. Choose a default Twilio number in Settings.',
          errorCode: 'permission_denied',
          retryAfterSeconds: 0,
        };
      }

      // Recording is contractor-controlled and OFF by default.
      const contractor = await storage.getContractor(options.contractorId);
      const record = !!contractor?.twilioRecordCalls;

      const creds = await getTwilioCredentials(options.contractorId);

      const base = getPublicBaseUrl();
      if (!base) {
        return { success: false, error: 'Server public URL is not configured; cannot place bridged calls.', errorCode: 'unknown', retryAfterSeconds: 0 };
      }

      const bridgeUrl = new URL(`${base}/api/webhooks/twilio/voice/bridge`);
      bridgeUrl.searchParams.set('contractorId', options.contractorId);
      bridgeUrl.searchParams.set('to', customerE164);
      bridgeUrl.searchParams.set('callerId', callerId);
      bridgeUrl.searchParams.set('record', record ? '1' : '0');

      const statusUrl = `${base}/api/webhooks/twilio/voice/status?contractorId=${encodeURIComponent(options.contractorId)}`;

      // no retry on write — retrying risks placing duplicate calls.
      const response = await twilioForm(creds, '/Calls.json', {
        To: repPhone,
        From: callerId,
        Url: bridgeUrl.toString(),
        Method: 'POST',
        StatusCallback: statusUrl,
        StatusCallbackEvent: 'completed',
        StatusCallbackMethod: 'POST',
      });

      if (!response.ok) {
        const errorText = await response.text();
        const classified = classifyTwilioCallError(response.status, errorText);
        log.error(`Twilio call failed — status=${response.status} code=${classified.code} body=${errorText}`);
        return {
          success: false,
          error: classified.userMessage,
          errorCode: classified.code,
          retryAfterSeconds: classified.retryAfterSeconds,
        };
      }

      const result = await response.json();
      return { success: true, callId: result.sid };
    } catch (error) {
      log.error(`Twilio call request threw — ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
      const classified = classifyTwilioCallError(0, '');
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
      const creds = await getTwilioCredentials(contractorId);
      const response = await twilioGet(creds, `/Calls/${encodeURIComponent(callId)}.json`);
      if (!response.ok) {
        const errorText = await response.text();
        return { success: false, error: `Failed to get call details: ${response.status} ${errorText}` };
      }
      return { success: true, callDetails: await response.json() };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error occurred' };
    }
  }

  async checkConnection(contractorId: string): Promise<{ connected: boolean; error?: string }> {
    try {
      const creds = await getTwilioCredentials(contractorId);
      const response = await twilioGet(creds, '.json');
      if (!response.ok) {
        return { connected: false, error: `Twilio connection failed: ${response.status}` };
      }
      return { connected: true };
    } catch (error) {
      return { connected: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  async isConfigured(contractorId: string): Promise<boolean> {
    try {
      const credentials = await credentialService.getCredentialsWithFallback(contractorId, 'twilio');
      return !!(credentials.account_sid && credentials.auth_token);
    } catch {
      return false;
    }
  }
}
