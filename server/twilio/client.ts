/**
 * Twilio module — credential resolution and HTTP client helpers.
 *
 * Uses the raw Twilio REST API (no twilio SDK). Authentication is HTTP Basic
 * with AccountSid:AuthToken. All REST calls go to the per-account base URL.
 *
 * Retry policy mirrors the Dialpad module: reads may retry on 429/5xx; writes
 * (calls/SMS) must NOT retry to avoid duplicate side effects.
 */

import { credentialService } from '../credential-service';

export interface TwilioCredentials {
  accountSid: string;
  authToken: string;
  /** Base REST URL scoped to the account, e.g. https://api.twilio.com/2010-04-01/Accounts/ACxxxx */
  baseUrl: string;
}

/**
 * Resolve Twilio API credentials for a contractor. Twilio is contractor-scoped
 * only — there is no system-wide environment fallback (mirrors Dialpad).
 * Throws if credentials are not configured.
 */
export async function getTwilioCredentials(contractorId: string): Promise<TwilioCredentials> {
  const creds = await credentialService.getCredentialsWithFallback(contractorId, 'twilio');
  const accountSid = creds.account_sid || '';
  const authToken = creds.auth_token || '';

  if (!accountSid || !authToken) {
    throw new Error(`Twilio credentials not configured for contractor ${contractorId}`);
  }

  return {
    accountSid,
    authToken,
    baseUrl: `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}`,
  };
}

/** Build the HTTP Basic auth header value for Twilio REST calls. */
export function basicAuthHeader(accountSid: string, authToken: string): string {
  return `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`;
}

/**
 * POST application/x-www-form-urlencoded to the Twilio REST API.
 * Twilio expects form-encoded bodies, not JSON.
 */
export async function twilioForm(
  creds: TwilioCredentials,
  path: string,
  params: Record<string, string | undefined>,
): Promise<Response> {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') body.append(k, v);
  }
  return fetch(`${creds.baseUrl}${path}`, {
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader(creds.accountSid, creds.authToken),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });
}

/** GET JSON from the Twilio REST API. */
export async function twilioGet(creds: TwilioCredentials, path: string): Promise<Response> {
  return fetch(`${creds.baseUrl}${path}`, {
    method: 'GET',
    headers: {
      Authorization: basicAuthHeader(creds.accountSid, creds.authToken),
    },
  });
}

/**
 * Base URL for the Twilio Messaging API (Messaging Services live here, NOT on
 * the per-account REST host used by `creds.baseUrl`). Same Basic auth applies.
 */
export const TWILIO_MESSAGING_BASE_URL = 'https://messaging.twilio.com/v1';

/** GET JSON from the Twilio Messaging API (messaging.twilio.com/v1). */
export async function twilioMessagingGet(creds: TwilioCredentials, path: string): Promise<Response> {
  return fetch(`${TWILIO_MESSAGING_BASE_URL}${path}`, {
    method: 'GET',
    headers: {
      Authorization: basicAuthHeader(creds.accountSid, creds.authToken),
    },
  });
}

/**
 * POST application/x-www-form-urlencoded to the Twilio Messaging API
 * (messaging.twilio.com/v1). Mirrors `twilioForm` but targets the messaging host.
 */
export async function twilioMessagingForm(
  creds: TwilioCredentials,
  path: string,
  params: Record<string, string | undefined>,
): Promise<Response> {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') body.append(k, v);
  }
  return fetch(`${TWILIO_MESSAGING_BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader(creds.accountSid, creds.authToken),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });
}
