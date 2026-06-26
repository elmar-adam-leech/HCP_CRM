/**
 * Twilio module — on-demand recording streaming proxy.
 *
 * Recording media on Twilio requires Basic auth, so the browser cannot fetch it
 * directly. We proxy the bytes through an authenticated app route, mirroring the
 * Dialpad recording proxy.
 */

import { getTwilioCredentials, basicAuthHeader } from './client';

/**
 * Fetch a Twilio recording's audio as a streamable Response. The caller is
 * responsible for piping the body to the client and forwarding content headers.
 * Returns the raw fetch Response (check `.ok` before streaming).
 */
export async function fetchTwilioRecording(contractorId: string, recordingSid: string): Promise<Response> {
  const creds = await getTwilioCredentials(contractorId);
  // The .mp3 media lives under the account Recordings resource.
  const url = `${creds.baseUrl}/Recordings/${encodeURIComponent(recordingSid)}.mp3`;
  return fetch(url, {
    headers: { Authorization: basicAuthHeader(creds.accountSid, creds.authToken) },
  });
}
