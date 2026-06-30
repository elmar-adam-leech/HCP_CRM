/**
 * Twilio module — configure per-number Voice/SMS webhook URLs via the Twilio
 * REST API so inbound calls and texts reach our public webhook endpoints.
 *
 * Twilio routes inbound traffic to the URL configured on each IncomingPhoneNumber
 * (unlike Dialpad's account-level subscriptions), so we set VoiceUrl / SmsUrl on
 * every synced number.
 *
 * EXCEPTION (task #840): if a number belongs to a Twilio Messaging Service
 * (common for A2P 10DLC compliant sending), Twilio IGNORES the number-level SMS
 * webhook and instead uses the Service's own inbound setting. So for every
 * Messaging Service that owns one of this contractor's numbers we flip
 * `UseInboundWebhookOnNumber=true`, telling the Service to defer inbound to the
 * number-level webhook we already configured. This leaves outbound sending /
 * A2P registration untouched and is idempotent on re-run.
 */

import {
  getTwilioCredentials,
  twilioForm,
  twilioMessagingGet,
  twilioMessagingForm,
  type TwilioCredentials,
} from './client';
import { storage } from '../storage';
import { getPublicBaseUrl } from '../utils/public-base-url';
import { logger } from '../utils/logger';

const log = logger('TwilioWebhookConfig');

interface MessagingService {
  sid: string;
  friendly_name?: string;
  use_inbound_webhook_on_number?: boolean;
}

interface MessagingServicePhoneNumber {
  sid: string; // PNxxxx
  phone_number?: string;
}

interface MessagingMeta {
  next_page_url?: string | null;
}

/** Hard cap on paginated Messaging API requests so a misconfigured account can't loop forever. */
const MAX_MESSAGING_PAGES = 20;

/**
 * GET a paginated Twilio Messaging API collection, following `meta.next_page_url`
 * up to MAX_MESSAGING_PAGES. `key` is the array property in each page body
 * (e.g. "services", "phone_numbers"). Throws if the first page fails.
 */
async function listMessagingCollection<T>(
  creds: TwilioCredentials,
  initialPath: string,
  key: string,
): Promise<T[]> {
  const out: T[] = [];
  let path: string | null = initialPath;
  let pages = 0;
  while (path && pages < MAX_MESSAGING_PAGES) {
    const response = await twilioMessagingGet(creds, path);
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Twilio Messaging GET ${path} failed: ${response.status} ${text}`);
    }
    const data = await response.json();
    const items = Array.isArray(data?.[key]) ? (data[key] as T[]) : [];
    out.push(...items);
    const meta: MessagingMeta | undefined = data?.meta;
    // next_page_url is an absolute URL on messaging.twilio.com; strip the host
    // so it composes with the messaging base URL helper.
    const next = meta?.next_page_url || null;
    path = next ? next.replace(/^https?:\/\/messaging\.twilio\.com\/v1/, '') : null;
    pages++;
  }
  return out;
}

/**
 * For each Messaging Service that owns one of this contractor's active numbers,
 * set `UseInboundWebhookOnNumber=true` so inbound texts defer to the number-level
 * SMS webhook (already configured). Resilient: individual failures are logged and
 * skipped; outbound/A2P behavior is never touched. Returns the count adjusted and
 * the matched Service SIDs.
 */
async function configureMessagingServicesInbound(
  creds: TwilioCredentials,
  numberSids: Set<string>,
  numberE164: Set<string>,
): Promise<{ adjusted: number; serviceSids: string[] }> {
  let services: MessagingService[];
  try {
    services = await listMessagingCollection<MessagingService>(
      creds,
      '/Services?PageSize=50',
      'services',
    );
  } catch (err) {
    log.warn(`Could not list Twilio Messaging Services: ${err instanceof Error ? err.message : String(err)}`);
    return { adjusted: 0, serviceSids: [] };
  }

  const serviceSids: string[] = [];
  let adjusted = 0;

  for (const svc of services) {
    if (!svc?.sid) continue;

    // Does this Service own one of our numbers?
    let owns = false;
    try {
      const phones = await listMessagingCollection<MessagingServicePhoneNumber>(
        creds,
        `/Services/${encodeURIComponent(svc.sid)}/PhoneNumbers?PageSize=100`,
        'phone_numbers',
      );
      owns = phones.some(
        (p) =>
          (p.sid && numberSids.has(p.sid)) ||
          (p.phone_number && numberE164.has(p.phone_number)),
      );
    } catch (err) {
      log.warn(
        `Failed to list phone numbers for Messaging Service ${svc.sid}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }

    if (!owns) continue;
    serviceSids.push(svc.sid);

    // Already deferring to the number webhook — nothing to change (idempotent).
    if (svc.use_inbound_webhook_on_number === true) {
      adjusted++;
      continue;
    }

    try {
      const response = await twilioMessagingForm(creds, `/Services/${encodeURIComponent(svc.sid)}`, {
        UseInboundWebhookOnNumber: 'true',
      });
      if (!response.ok) {
        const text = await response.text();
        log.warn(`Failed to set inbound-on-number for Messaging Service ${svc.sid}: ${response.status} ${text}`);
        continue;
      }
      adjusted++;
      log.info(`Set UseInboundWebhookOnNumber=true on Messaging Service ${svc.sid}`);
    } catch (err) {
      log.warn(
        `Error updating Messaging Service ${svc.sid}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { adjusted, serviceSids };
}

/**
 * Configure VoiceUrl + SmsUrl on every active Twilio number for a contractor so
 * inbound calls/SMS hit our tenant-scoped webhook routes. Also ensures any
 * Messaging Service owning one of those numbers defers inbound to the number-level
 * webhook (task #840). Records the configured base URL in twilio_webhook_state.
 * Returns the count of numbers and Messaging Services configured.
 */
export async function configureTwilioWebhooks(
  contractorId: string,
): Promise<{ configured: number; messagingServicesConfigured: number }> {
  const base = getPublicBaseUrl();
  if (!base) throw new Error('Server public URL is not configured; cannot set Twilio webhooks.');

  const creds = await getTwilioCredentials(contractorId);
  const numbers = await storage.getTwilioPhoneNumbers(contractorId);

  const voiceUrl = `${base}/api/webhooks/twilio/voice/incoming/${encodeURIComponent(contractorId)}`;
  const smsUrl = `${base}/api/webhooks/twilio/sms/${encodeURIComponent(contractorId)}`;
  const statusUrl = `${base}/api/webhooks/twilio/voice/status/${encodeURIComponent(contractorId)}`;

  let configured = 0;
  const configuredSids: string[] = [];
  const activeNumberE164 = new Set<string>();
  for (const num of numbers) {
    if (!num.isActive || !num.twilioSid) continue;
    if (num.phoneNumber) activeNumberE164.add(num.phoneNumber);
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

  // Route inbound texts for numbers that live inside a Messaging Service. Failures
  // here must not abort the rest of provisioning.
  let messagingServicesConfigured = 0;
  let messagingServiceSids: string[] = [];
  try {
    const result = await configureMessagingServicesInbound(
      creds,
      new Set(configuredSids),
      activeNumberE164,
    );
    messagingServicesConfigured = result.adjusted;
    messagingServiceSids = result.serviceSids;
  } catch (err) {
    log.warn(`Messaging Service inbound configuration failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  await storage.upsertTwilioWebhookState({
    contractorId,
    lastRegisteredVoiceUrl: voiceUrl,
    lastRegisteredSmsUrl: smsUrl,
    configuredNumberSids: configuredSids,
    configuredMessagingServiceSids: messagingServiceSids,
    lastRegisteredAt: new Date(),
  } as any);

  log.info(
    `Configured Twilio webhooks for ${configured} numbers and ${messagingServicesConfigured} Messaging Services (contractor ${contractorId})`,
  );
  return { configured, messagingServicesConfigured };
}
