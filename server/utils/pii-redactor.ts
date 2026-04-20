/**
 * PII redaction utilities for server-side logging.
 *
 * These helpers mask personally identifiable information (email, phone, address)
 * before it is written to log output. They are intentionally minimal — enough to
 * obscure the sensitive value while still providing diagnostic context.
 *
 * Usage:
 *   import { maskEmail, maskPhone, maskAddress } from '../utils/pii-redactor';
 *
 * maskPhone is re-exported here for convenience but lives in phone-normalizer.ts
 * so that the normalizer module stays self-contained.
 */

export { maskPhone } from './phone-normalizer';

/**
 * Mask an email address for logging.
 * Shows only the first character of the local part and the full domain.
 *
 * Examples:
 *   john.doe@example.com  →  j***@example.com
 *   a@b.co                →  a***@b.co
 *   invalid               →  [invalid email]
 */
export function maskEmail(email: string | null | undefined): string {
  if (!email || typeof email !== 'string' || email.trim() === '') return '';
  const atIndex = email.indexOf('@');
  if (atIndex <= 0) return '[invalid email]';
  const localPart = email.slice(0, atIndex);
  const domain = email.slice(atIndex);
  const visibleChar = localPart[0];
  return `${visibleChar}***${domain}`;
}

/**
 * Redact a physical address for logging.
 * Addresses are replaced entirely with a fixed token because even a partial
 * address reveals sensitive location information.
 *
 * Examples:
 *   123 Main St, Springfield, IL 62701  →  [address redacted]
 *   ""                                  →  ""
 */
export function maskAddress(address: string | null | undefined): string {
  if (!address || typeof address !== 'string' || address.trim() === '') return '';
  return '[address redacted]';
}
