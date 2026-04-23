/**
 * Dialpad module — shared utility helpers.
 *
 * Phone normalization delegates to the shared phone-normalizer utility.
 * Error mapping and response normalization helpers live here.
 */

import { normalizePhoneNumber } from '../utils/phone-normalizer';

export { normalizePhoneNumber };

/**
 * Normalize a phone number for E.164 storage/comparison.
 * Returns an empty string if the number cannot be normalized.
 */
export function formatToE164(phoneNumber: string): string {
  return normalizePhoneNumber(phoneNumber);
}

/**
 * Extract a human-readable error message from an unknown thrown value.
 */
export function extractErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Unknown error occurred';
}

export type DialpadCallErrorCode = 'rate_limit' | 'conflict' | 'permission_denied' | 'unknown';

export interface DialpadCallErrorInfo {
  code: DialpadCallErrorCode;
  userMessage: string;
  retryAfterSeconds: number;
}

/**
 * Translate a Dialpad call API error (status + body text) into a user-friendly
 * shape suitable for surfacing in the UI. The raw body is still expected to
 * be logged separately at the call site so we keep server-side fidelity.
 */
export function classifyDialpadCallError(status: number, errorText: string): DialpadCallErrorInfo {
  let innerMessage = '';
  let innerReason = '';
  try {
    const parsed = JSON.parse(errorText);
    innerMessage = String(parsed?.message ?? '').toLowerCase();
    innerReason = String(parsed?.reason ?? '').toLowerCase();
  } catch {
    // Non-JSON body — fall back to substring matching on the raw text.
    innerMessage = errorText.toLowerCase();
  }

  const haystack = `${innerMessage} ${innerReason}`;

  if (status === 429 || haystack.includes('rate_limit')) {
    return {
      code: 'rate_limit',
      userMessage: 'Dialpad is temporarily limiting calls. Please wait ~60 seconds and try again.',
      retryAfterSeconds: 60,
    };
  }

  if (status === 409 || haystack.includes('conflict')) {
    return {
      code: 'conflict',
      userMessage: "Dialpad couldn't place the call (the line or your Dialpad app may be busy). Try again in a few seconds.",
      retryAfterSeconds: 5,
    };
  }

  if (status === 401 || status === 403 || haystack.includes('permission') || haystack.includes('forbidden') || haystack.includes('unauthorized')) {
    return {
      code: 'permission_denied',
      userMessage: "You don't have permission to call from this number. Check your Dialpad permissions in Settings.",
      retryAfterSeconds: 0,
    };
  }

  return {
    code: 'unknown',
    userMessage: "Couldn't start the call. Please try again or check your Dialpad connection.",
    retryAfterSeconds: 5,
  };
}
