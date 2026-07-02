/**
 * Twilio module — configure per-number Voice/SMS webhook URLs via the Twilio
 * REST API so inbound calls and texts reach our public webhook endpoints.
 *
 * Twilio routes inbound traffic to the URL configured on each IncomingPhoneNumber
 * (unlike Dialpad's account-level subscriptions), so we set VoiceUrl / SmsUrl on
 * every synced number.
 *
 * EXCEPTION (Messaging Service inbound routing): if a number belongs to a Twilio
 * Messaging Service (common for A2P 10DLC compliant sending), Twilio IGNORES the
 * number-level SMS webhook and instead uses the Service's own inbound setting.
 *
 * Originally we flipped `UseInboundWebhookOnNumber=true` so the Service would
 * defer inbound to the number-level webhook. In practice that deferral did not
 * take effect for some accounts and inbound texts were silently dropped. We now
 * set the Service's `InboundRequestUrl` DIRECTLY to our tenant-scoped SMS webhook
 * (and `UseInboundWebhookOnNumber=false` so the Service uses that URL), which is
 * the authoritative inbound route and does not depend on number-level deferral.
 * This leaves outbound sending / A2P registration untouched and is idempotent on
 * re-run. Twilio signs the exact InboundRequestUrl when it POSTs via the Service,
 * and because that URL equals our number-level SmsUrl, signature verification in
 * the webhook handler keeps working unchanged.
 */

import {
  getTwilioCredentials,
  twilioForm,
  twilioGet,
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
  inbound_request_url?: string | null;
  use_inbound_webhook_on_number?: boolean;
}

interface MessagingServicePhoneNumber {
  sid: string; // PNxxxx
  phone_number?: string;
}

interface MessagingMeta {
  next_page_url?: string | null;
}

/** Per-Messaging-Service inbound routing result/diagnostic. */
export interface MessagingServiceRouting {
  sid: string;
  friendlyName?: string;
  /** True when inbound SMS for this Service reaches our endpoint after config. */
  routedToUs: boolean;
  /** How inbound is routed: directly via InboundRequestUrl, via number deferral, or not at all. */
  mode: 'direct' | 'deferral' | 'none';
  /** True when this run changed the Service config (false when already correct). */
  changed?: boolean;
  error?: string;
}

/** Per-number inbound routing diagnostic. */
export interface NumberRouting {
  phoneNumber: string;
  sid: string;
  /** True when the number-level SmsUrl points at our endpoint. */
  smsUrlConfigured: boolean;
  /** Messaging Service SID that owns this number, if any. */
  messagingServiceSid?: string;
}

/** Aggregate inbound-SMS routing status surfaced to the admin UI. */
export interface InboundSmsRoutingStatus {
  /** True when every active number has a working inbound SMS path. */
  ok: boolean;
  numbers: NumberRouting[];
  messagingServices: MessagingServiceRouting[];
  /** Human-readable warnings when inbound is NOT correctly wired. */
  warnings: string[];
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
 * set `InboundRequestUrl` directly to our SMS webhook (and disable
 * `UseInboundWebhookOnNumber`) so inbound texts reach the CRM regardless of
 * number-level deferral. Resilient: individual failures are logged and skipped;
 * outbound/A2P behavior is never touched. Idempotent — a Service already pointing
 * at our URL is counted but not re-POSTed. Returns per-Service routing detail.
 */
async function configureMessagingServicesInbound(
  creds: TwilioCredentials,
  smsUrl: string,
  numberSids: Set<string>,
  numberE164: Set<string>,
): Promise<{ adjusted: number; services: MessagingServiceRouting[]; listFailed: boolean }> {
  let services: MessagingService[];
  try {
    services = await listMessagingCollection<MessagingService>(
      creds,
      '/Services?PageSize=50',
      'services',
    );
  } catch (err) {
    log.warn(`Could not list Twilio Messaging Services: ${err instanceof Error ? err.message : String(err)}`);
    return { adjusted: 0, services: [], listFailed: true };
  }

  const result: MessagingServiceRouting[] = [];
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

    // Already routed directly to our endpoint — nothing to change (idempotent).
    if (svc.inbound_request_url === smsUrl && svc.use_inbound_webhook_on_number === false) {
      adjusted++;
      result.push({ sid: svc.sid, friendlyName: svc.friendly_name, routedToUs: true, mode: 'direct', changed: false });
      continue;
    }

    try {
      const response = await twilioMessagingForm(creds, `/Services/${encodeURIComponent(svc.sid)}`, {
        InboundRequestUrl: smsUrl,
        InboundMethod: 'POST',
        UseInboundWebhookOnNumber: 'false',
      });
      if (!response.ok) {
        const text = await response.text();
        log.warn(`Failed to set InboundRequestUrl for Messaging Service ${svc.sid}: ${response.status} ${text}`);
        result.push({
          sid: svc.sid,
          friendlyName: svc.friendly_name,
          routedToUs: false,
          mode: 'none',
          error: `${response.status} ${text}`.trim(),
        });
        continue;
      }
      adjusted++;
      log.info(`Set InboundRequestUrl on Messaging Service ${svc.sid} -> our SMS webhook`);
      result.push({ sid: svc.sid, friendlyName: svc.friendly_name, routedToUs: true, mode: 'direct', changed: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`Error updating Messaging Service ${svc.sid}: ${msg}`);
      result.push({ sid: svc.sid, friendlyName: svc.friendly_name, routedToUs: false, mode: 'none', error: msg });
    }
  }

  return { adjusted, services: result, listFailed: false };
}

/**
 * Configure VoiceUrl + SmsUrl on every active Twilio number for a contractor so
 * inbound calls/SMS hit our tenant-scoped webhook routes. Also ensures any
 * Messaging Service owning one of those numbers routes inbound directly to our
 * SMS webhook. Records the configured base URL in twilio_webhook_state. Returns
 * the count of numbers and Messaging Services configured plus a human-readable
 * inbound-SMS routing status for the admin UI.
 */
export async function configureTwilioWebhooks(
  contractorId: string,
): Promise<{
  configured: number;
  messagingServicesConfigured: number;
  inboundRouting: InboundSmsRoutingStatus;
}> {
  const base = getPublicBaseUrl();
  if (!base) throw new Error('Server public URL is not configured; cannot set Twilio webhooks.');

  const creds = await getTwilioCredentials(contractorId);
  const numbers = await storage.getTwilioPhoneNumbers(contractorId);
  const contractor = await storage.getContractor(contractorId);
  // 'external' = the contractor manages inbound call handling in Twilio themselves
  // (e.g. a Studio Flow / IVR). We must NOT overwrite the number's VoiceUrl in
  // that mode — but we ALWAYS set SmsUrl (inbound texts) and StatusCallback
  // (call logging fires regardless of what answers the call).
  const externalCallMode = contractor?.twilioInboundCallMode === 'external';

  const voiceUrl = `${base}/api/webhooks/twilio/voice/incoming/${encodeURIComponent(contractorId)}`;
  const smsUrl = `${base}/api/webhooks/twilio/sms/${encodeURIComponent(contractorId)}`;
  const statusUrl = `${base}/api/webhooks/twilio/voice/status/${encodeURIComponent(contractorId)}`;

  let configured = 0;
  const configuredSids: string[] = [];
  const activeNumberE164 = new Set<string>();
  const numberRouting: NumberRouting[] = [];
  const warnings: string[] = [];
  for (const num of numbers) {
    if (!num.isActive || !num.twilioSid) continue;
    if (num.phoneNumber) activeNumberE164.add(num.phoneNumber);
    const params: Record<string, string> = {
      StatusCallback: statusUrl,
      StatusCallbackMethod: 'POST',
      SmsUrl: smsUrl,
      SmsMethod: 'POST',
    };
    if (!externalCallMode) {
      params.VoiceUrl = voiceUrl;
      params.VoiceMethod = 'POST';
    }
    const response = await twilioForm(creds, `/IncomingPhoneNumbers/${encodeURIComponent(num.twilioSid)}.json`, params);
    if (!response.ok) {
      const text = await response.text();
      log.warn(`Failed to configure webhooks for ${num.phoneNumber} (${num.twilioSid}): ${response.status} ${text}`);
      numberRouting.push({ phoneNumber: num.phoneNumber || '', sid: num.twilioSid, smsUrlConfigured: false });
      warnings.push(`Could not set the SMS webhook on ${num.phoneNumber || num.twilioSid}.`);
      continue;
    }
    configured++;
    configuredSids.push(num.twilioSid);
    numberRouting.push({ phoneNumber: num.phoneNumber || '', sid: num.twilioSid, smsUrlConfigured: true });
  }

  // Route inbound texts for numbers that live inside a Messaging Service. Failures
  // here must not abort the rest of provisioning.
  let messagingServicesConfigured = 0;
  let messagingServiceRouting: MessagingServiceRouting[] = [];
  let messagingListFailed = false;
  try {
    const result = await configureMessagingServicesInbound(
      creds,
      smsUrl,
      new Set(configuredSids),
      activeNumberE164,
    );
    messagingServicesConfigured = result.adjusted;
    messagingServiceRouting = result.services;
    messagingListFailed = result.listFailed;
  } catch (err) {
    log.warn(`Messaging Service inbound configuration failed: ${err instanceof Error ? err.message : String(err)}`);
    messagingListFailed = true;
  }

  // Annotate which numbers belong to a Messaging Service we routed (best-effort:
  // we can only attribute by Service membership we already discovered).
  if (messagingListFailed) {
    warnings.push('Could not verify Twilio Messaging Service routing. If your sending number uses a Messaging Service, inbound texts may not arrive — re-run setup or check Twilio credentials.');
  }
  for (const svc of messagingServiceRouting) {
    if (!svc.routedToUs) {
      warnings.push(`Inbound SMS routing for Messaging Service ${svc.friendlyName || svc.sid} could not be configured${svc.error ? ` (${svc.error})` : ''}.`);
    }
  }

  const ok =
    !messagingListFailed &&
    numberRouting.length > 0 &&
    numberRouting.every((n) => n.smsUrlConfigured) &&
    messagingServiceRouting.every((s) => s.routedToUs);

  const messagingServiceSids = messagingServiceRouting.map((s) => s.sid);

  await storage.upsertTwilioWebhookState({
    contractorId,
    lastRegisteredVoiceUrl: externalCallMode ? null : voiceUrl,
    lastRegisteredSmsUrl: smsUrl,
    configuredNumberSids: configuredSids,
    configuredMessagingServiceSids: messagingServiceSids,
    lastRegisteredAt: new Date(),
  } as any);

  log.info(
    `Configured Twilio webhooks for ${configured} numbers and ${messagingServicesConfigured} Messaging Services (contractor ${contractorId}); inbound routing ok=${ok}`,
  );
  return {
    configured,
    messagingServicesConfigured,
    inboundRouting: { ok, numbers: numberRouting, messagingServices: messagingServiceRouting, warnings },
  };
}

/**
 * READ-ONLY diagnostic: inspect the live Twilio routing state for a contractor's
 * active numbers WITHOUT changing anything. Reports, per number, whether the
 * number-level SmsUrl points at our endpoint and which Messaging Service (if any)
 * owns it, and per Service whether its inbound routing reaches our endpoint
 * (directly via InboundRequestUrl or via number-level deferral). Used by the
 * admin "check inbound SMS routing" path so this failure mode is visible.
 */
export async function inspectTwilioInboundRouting(
  contractorId: string,
): Promise<InboundSmsRoutingStatus> {
  const base = getPublicBaseUrl();
  if (!base) {
    return { ok: false, numbers: [], messagingServices: [], warnings: ['Server public URL is not configured.'] };
  }
  const creds = await getTwilioCredentials(contractorId);
  const smsUrl = `${base}/api/webhooks/twilio/sms/${encodeURIComponent(contractorId)}`;

  const numbers = await storage.getTwilioPhoneNumbers(contractorId);
  const active = numbers.filter((n) => n.isActive && n.twilioSid);

  const warnings: string[] = [];
  const numberRouting: NumberRouting[] = [];
  const activeSids = new Set<string>();
  const activeE164 = new Set<string>();

  for (const num of active) {
    activeSids.add(num.twilioSid!);
    if (num.phoneNumber) activeE164.add(num.phoneNumber);
    let smsUrlConfigured = false;
    try {
      const r = await twilioGet(creds, `/IncomingPhoneNumbers/${encodeURIComponent(num.twilioSid!)}.json`);
      if (r.ok) {
        const data = await r.json();
        smsUrlConfigured = data?.sms_url === smsUrl;
      }
    } catch (err) {
      log.warn(`Failed to read IncomingPhoneNumber ${num.twilioSid}: ${err instanceof Error ? err.message : String(err)}`);
    }
    numberRouting.push({ phoneNumber: num.phoneNumber || '', sid: num.twilioSid!, smsUrlConfigured });
    if (!smsUrlConfigured) {
      warnings.push(`The SMS webhook is not set on ${num.phoneNumber || num.twilioSid}.`);
    }
  }

  // Inspect Messaging Services that own one of our numbers.
  const messagingServiceRouting: MessagingServiceRouting[] = [];
  let messagingListFailed = false;
  let services: MessagingService[] = [];
  try {
    services = await listMessagingCollection<MessagingService>(creds, '/Services?PageSize=50', 'services');
  } catch (err) {
    messagingListFailed = true;
    log.warn(`Could not list Twilio Messaging Services: ${err instanceof Error ? err.message : String(err)}`);
    warnings.push('Could not verify Twilio Messaging Service routing.');
  }

  for (const svc of services) {
    if (!svc?.sid) continue;
    let owns = false;
    let ownedNumberSids = new Set<string>();
    try {
      const phones = await listMessagingCollection<MessagingServicePhoneNumber>(
        creds,
        `/Services/${encodeURIComponent(svc.sid)}/PhoneNumbers?PageSize=100`,
        'phone_numbers',
      );
      for (const p of phones) {
        if ((p.sid && activeSids.has(p.sid)) || (p.phone_number && activeE164.has(p.phone_number))) {
          owns = true;
          if (p.sid) ownedNumberSids.add(p.sid);
        }
      }
    } catch (err) {
      log.warn(`Failed to list phone numbers for Messaging Service ${svc.sid}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (!owns) continue;

    // Tag those numbers with their owning Service for the UI.
    for (const nr of numberRouting) {
      if (ownedNumberSids.has(nr.sid)) nr.messagingServiceSid = svc.sid;
    }

    const direct = svc.inbound_request_url === smsUrl;
    const deferral = svc.use_inbound_webhook_on_number === true;
    const routedToUs = direct || deferral;
    const mode: MessagingServiceRouting['mode'] = direct ? 'direct' : deferral ? 'deferral' : 'none';
    messagingServiceRouting.push({ sid: svc.sid, friendlyName: svc.friendly_name, routedToUs, mode });
    if (!routedToUs) {
      warnings.push(`Inbound SMS for Messaging Service ${svc.friendly_name || svc.sid} is NOT routed to the CRM. Re-run setup.`);
    }
  }

  const ok =
    !messagingListFailed &&
    numberRouting.length > 0 &&
    numberRouting.every((n) => n.smsUrlConfigured) &&
    messagingServiceRouting.every((s) => s.routedToUs);

  return { ok, numbers: numberRouting, messagingServices: messagingServiceRouting, warnings };
}
