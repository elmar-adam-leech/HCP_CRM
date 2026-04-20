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
