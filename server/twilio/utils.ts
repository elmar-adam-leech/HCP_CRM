/**
 * Twilio module — shared utilities: phone formatting, webhook signature
 * validation, TwiML builders, and error classification.
 */

import crypto from 'crypto';
import { normalizePhoneNumber } from '../utils/phone-normalizer';

export { normalizePhoneNumber };

/** Normalize a phone number to E.164 (delegates to the shared normalizer). */
export function formatToE164(phoneNumber: string): string {
  return normalizePhoneNumber(phoneNumber);
}

/**
 * Validate an inbound Twilio webhook request signature.
 *
 * Twilio computes: base64(HMAC-SHA1(authToken, fullUrl + sortedConcatParams))
 * where params are the POST body fields sorted by key, concatenated as
 * key+value with no separators. The result is sent in the X-Twilio-Signature
 * header. See https://www.twilio.com/docs/usage/security#validating-requests.
 *
 * `url` MUST be the exact public URL Twilio posted to (including query string).
 */
export function validateTwilioSignature(
  authToken: string,
  signatureHeader: string | undefined,
  url: string,
  params: Record<string, string>,
): boolean {
  if (!signatureHeader || !authToken) return false;

  const sortedKeys = Object.keys(params).sort();
  let data = url;
  for (const key of sortedKeys) {
    data += key + params[key];
  }

  const expected = crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf-8')).digest('base64');

  try {
    const a = Buffer.from(signatureHeader);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** Escape a string for safe inclusion in XML/TwiML. */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Build TwiML for the bridge-model outbound call. Twilio first calls the rep's
 * phone (this leg), then this TwiML dials the customer to bridge them.
 *
 * When `record` is true we record the bridged leg in both directions and post
 * the completed recording to `recordingCallbackUrl`. A short consent notice is
 * spoken before dialing when recording is enabled.
 */
export function buildBridgeDialTwiml(opts: {
  customerNumber: string;
  callerId: string;
  record: boolean;
  recordingCallbackUrl?: string;
  consentMessage?: string;
}): string {
  const consent =
    opts.record && opts.consentMessage
      ? `<Say>${escapeXml(opts.consentMessage)}</Say>`
      : '';
  const recordAttrs = opts.record
    ? ` record="record-from-answer-dual"${opts.recordingCallbackUrl ? ` recordingStatusCallback="${escapeXml(opts.recordingCallbackUrl)}" recordingStatusCallbackEvent="completed"` : ''}`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${consent}<Dial callerId="${escapeXml(opts.callerId)}"${recordAttrs}><Number>${escapeXml(opts.customerNumber)}</Number></Dial></Response>`;
}

/**
 * Build TwiML for an inbound call. Optionally records, then drops to voicemail
 * if unanswered. `forwardTo` (when present) rings a destination number first.
 */
export function buildInboundTwiml(opts: {
  forwardTo?: string;
  record: boolean;
  recordingCallbackUrl?: string;
  consentMessage?: string;
  voicemailMessage?: string;
  voicemailCallbackUrl?: string;
}): string {
  const consent =
    opts.record && opts.consentMessage ? `<Say>${escapeXml(opts.consentMessage)}</Say>` : '';

  if (opts.forwardTo) {
    const recordAttrs = opts.record
      ? ` record="record-from-answer-dual"${opts.recordingCallbackUrl ? ` recordingStatusCallback="${escapeXml(opts.recordingCallbackUrl)}" recordingStatusCallbackEvent="completed"` : ''}`
      : '';
    return `<?xml version="1.0" encoding="UTF-8"?><Response>${consent}<Dial${recordAttrs}><Number>${escapeXml(opts.forwardTo)}</Number></Dial></Response>`;
  }

  // No forward target — go straight to voicemail.
  const vmRecordAttrs = opts.voicemailCallbackUrl
    ? ` recordingStatusCallback="${escapeXml(opts.voicemailCallbackUrl)}" recordingStatusCallbackEvent="completed"`
    : '';
  const greeting = opts.voicemailMessage || 'Please leave a message after the tone.';
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${consent}<Say>${escapeXml(greeting)}</Say><Record maxLength="120" playBeep="true"${vmRecordAttrs} /></Response>`;
}

/** Empty TwiML acknowledgement (used for SMS/status callbacks). */
export function emptyTwiml(): string {
  return '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
}

export interface TwilioCallErrorInfo {
  code: 'rate_limit' | 'conflict' | 'permission_denied' | 'unknown';
  userMessage: string;
  retryAfterSeconds: number;
}

/** Map a Twilio REST error response to a friendly, classified error. */
export function classifyTwilioCallError(status: number, _errorText: string): TwilioCallErrorInfo {
  if (status === 429) {
    return {
      code: 'rate_limit',
      userMessage: 'Too many calls in a short time. Please wait a moment and try again.',
      retryAfterSeconds: 30,
    };
  }
  if (status === 401 || status === 403) {
    return {
      code: 'permission_denied',
      userMessage: 'Twilio rejected this request. Please verify your Twilio credentials and phone number permissions.',
      retryAfterSeconds: 0,
    };
  }
  if (status === 409) {
    return {
      code: 'conflict',
      userMessage: 'A conflicting call is already in progress. Please try again shortly.',
      retryAfterSeconds: 10,
    };
  }
  return {
    code: 'unknown',
    userMessage: 'The call could not be placed. Please try again.',
    retryAfterSeconds: 0,
  };
}
