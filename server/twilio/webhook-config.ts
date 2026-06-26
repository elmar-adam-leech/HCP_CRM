/**
 * Twilio module — configure per-number Voice/SMS webhook URLs via the Twilio
 * REST API so inbound calls and texts reach our public webhook endpoints.
 *
 * Twilio routes inbound traffic to the URL configured on each IncomingPhoneNumber
 * (unlike Dialpad's account-level subscriptions), so we set VoiceUrl / SmsUrl on
 * every synced number.
 */

import { getTwilioCredentials, twilioForm } from './client';
import { storage } from '../storage';
import { getPublicBaseUrl } from '../utils/public-base-url';
import { logger } from '../utils/logger';

const log = logger('TwilioWebhookConfig');

/**
 * Configure VoiceUrl + SmsUrl on every active Twilio number for a contractor so
 * inbound calls/SMS hit our tenant-scoped webhook routes. Records the configured
 * base URL in twilio_webhook_state. Returns the count configured.
 */
export async function configureTwilioWebhooks(contractorId: string): Promise<{ configured: number }> {
  const base = getPublicBaseUrl();
  if (!base) throw new Error('Server public URL is not configured; cannot set Twilio webhooks.');

  const creds = await getTwilioCredentials(contractorId);
  const numbers = await storage.getTwilioPhoneNumbers(contractorId);

  const voiceUrl = `${base}/api/webhooks/twilio/voice/incoming/${encodeURIComponent(contractorId)}`;
  const smsUrl = `${base}/api/webhooks/twilio/sms/${encodeURIComponent(contractorId)}`;
  const statusUrl = `${base}/api/webhooks/twilio/voice/status/${encodeURIComponent(contractorId)}`;

  let configured = 0;
  const configuredSids: string[] = [];
  for (const num of numbers) {
    if (!num.isActive || !num.twilioSid) continue;
    const response = await twilioForm(creds, `/IncomingPhoneNumbers/${encodeURIComponent(num.twilioSid)}.json`, {
      VoiceUrl: voiceUrl,
      VoiceMethod: 'POST',
      StatusCallback: statusUrl,
      StatusCallbackMethod: 'POST',
      SmsUrl: smsUrl,
      SmsMethod: 'POST',
    });
    if (!response.ok) {
      const text = await response.text();
      log.warn(`Failed to configure webhooks for ${num.phoneNumber} (${num.twilioSid}): ${response.status} ${text}`);
      continue;
    }
    configured++;
    configuredSids.push(num.twilioSid);
  }

  await storage.upsertTwilioWebhookState({
    contractorId,
    lastRegisteredVoiceUrl: voiceUrl,
    lastRegisteredSmsUrl: smsUrl,
    configuredNumberSids: configuredSids,
    lastRegisteredAt: new Date(),
  } as any);

  log.info(`Configured Twilio webhooks for ${configured} numbers (contractor ${contractorId})`);
  return { configured };
}
