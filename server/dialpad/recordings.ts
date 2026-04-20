/**
 * Dialpad call recordings — on-demand fetch by recording ID.
 *
 * Why this exists:
 *   The webhook payloads Dialpad sends carry a short-lived `recording_url`
 *   that expires within minutes. We persist the recording IDs alongside the
 *   activity (in `metadata.recording_details[*].id`) so we can fetch a fresh,
 *   playable copy on demand from the Dialpad recordings export API.
 *
 * Required Dialpad scope:
 *   The configured Dialpad API key must be granted the `recordings_export`
 *   scope. Without it, Dialpad returns 403 from the recordings endpoint.
 */

import { getCredentials } from './client';
import { logger } from '../utils/logger';

const log = logger('DialpadRecordings');

export type FetchRecordingResult =
  | {
      ok: true;
      body: ReadableStream<Uint8Array>;
      contentType: string;
      contentLength: string | null;
    }
  | {
      ok: false;
      status: number;
      error: string;
      missingScope?: boolean;
    };

/**
 * Fetch a Dialpad call recording by its ID using the recordings export API.
 * Returns the raw response stream so callers can pipe it back to the browser
 * without buffering the full audio in memory.
 */
export async function fetchRecording(
  contractorId: string,
  recordingId: string,
): Promise<FetchRecordingResult> {
  const { apiKey, baseUrl } = await getCredentials(contractorId);

  // Dialpad recordings export endpoint. Returns the audio bytes directly
  // (or a 302 to a signed CDN URL — fetch transparently follows it).
  const url = `${baseUrl}/callrecordings/${encodeURIComponent(recordingId)}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Accept': 'audio/*',
    },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    const missingScope = response.status === 403 && /scope|recordings_export/i.test(text);
    if (missingScope) {
      log.warn(
        `Dialpad recording fetch failed for contractor ${contractorId}: missing recordings_export scope`,
      );
    } else {
      log.warn(
        `Dialpad recording fetch failed for contractor ${contractorId}, recording ${recordingId}: ${response.status} ${text.slice(0, 200)}`,
      );
    }
    return {
      ok: false,
      status: response.status,
      error: text || `Dialpad responded with ${response.status}`,
      missingScope,
    };
  }

  if (!response.body) {
    return {
      ok: false,
      status: 502,
      error: 'Dialpad returned an empty recording body',
    };
  }

  return {
    ok: true,
    body: response.body,
    contentType: response.headers.get('content-type') ?? 'audio/mpeg',
    contentLength: response.headers.get('content-length'),
  };
}
