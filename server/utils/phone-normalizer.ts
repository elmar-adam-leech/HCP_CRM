/**
 * Comprehensive phone number normalization utility
 * Handles various phone number formats and normalizes to E.164 format (+1XXXXXXXXXX for US)
 * 
 * Supported formats:
 * - (xxx)xxx-xxxx
 * - (xxx) xxx-xxxx
 * - xxx-xxx-xxxx
 * - xxx.xxx.xxxx
 * - xxxxxxxxxx
 * - +1(xxx)xxx-xxxx
 * - +1 (xxx) xxx-xxxx
 * - +1-xxx-xxx-xxxx
 * - 1-xxx-xxx-xxxx
 * - Any combination with spaces, dots, dashes, or parentheses
 */

/**
 * Normalize a phone number to E.164 format
 * @param phone - Phone number in any format
 * @param defaultCountryCode - Default country code (default: '1' for US)
 * @returns Normalized phone number in E.164 format (+1XXXXXXXXXX) or empty string if invalid
 */
export function normalizePhoneNumber(phone: string | null | undefined, defaultCountryCode: string = '1'): string {
  if (!phone) return '';
  
  // Convert to string and trim whitespace
  const phoneStr = String(phone).trim();
  if (!phoneStr) return '';
  
  // Remove all non-digit characters except leading +
  const hasPlus = phoneStr.startsWith('+');
  const digitsOnly = phoneStr.replace(/\D/g, '');
  
  // If no digits found, return empty
  if (!digitsOnly) return '';
  
  // Handle different cases:
  
  // Case 1: Already has + and 11+ digits (international format)
  if (hasPlus && digitsOnly.length >= 11) {
    return `+${digitsOnly}`;
  }
  
  // Case 2: 11 digits starting with country code (e.g., 14155551234)
  if (digitsOnly.length === 11 && digitsOnly.startsWith(defaultCountryCode)) {
    return `+${digitsOnly}`;
  }
  
  // Case 3: 10 digits (US number without country code)
  if (digitsOnly.length === 10) {
    return `+${defaultCountryCode}${digitsOnly}`;
  }
  
  // Case 4: 11 digits not starting with default country code (might be different country)
  if (digitsOnly.length === 11) {
    return `+${digitsOnly}`;
  }
  
  // Case 5: More than 11 digits (international with explicit country code)
  if (digitsOnly.length > 11) {
    return `+${digitsOnly}`;
  }
  
  // Case 6: Less than 10 digits - try to salvage by adding country code
  // This handles edge cases where numbers might be incomplete
  if (digitsOnly.length > 0 && digitsOnly.length < 10) {
    // If it looks like it might be missing area code, we can't fix it reliably
    // Return as-is with country code prepended
    return `+${defaultCountryCode}${digitsOnly}`;
  }
  
  // Default: prepend country code
  return `+${defaultCountryCode}${digitsOnly}`;
}

/**
 * Normalize an array of phone numbers
 * @param phones - Array of phone numbers in any format
 * @param defaultCountryCode - Default country code (default: '1' for US)
 * @returns Array of normalized phone numbers, filtering out empty/invalid ones
 */
export function normalizePhoneNumbers(
  phones: (string | null | undefined)[] | null | undefined,
  defaultCountryCode: string = '1'
): string[] {
  if (!phones || !Array.isArray(phones)) return [];
  
  return phones
    .map(phone => normalizePhoneNumber(phone, defaultCountryCode))
    .filter(phone => phone !== '');
}

/**
 * Check if a phone number is valid (has at least 10 digits after normalization)
 * @param phone - Phone number in any format
 * @returns true if phone number is valid
 */
export function isValidPhoneNumber(phone: string | null | undefined): boolean {
  const normalized = normalizePhoneNumber(phone);
  if (!normalized) return false;
  
  // E.164 format should have at least 11 characters (+1 and 10 digits for US)
  const digitsOnly = normalized.replace(/\D/g, '');
  return digitsOnly.length >= 10;
}

/**
 * Format a normalized phone number for display
 * @param phone - Normalized phone number in E.164 format
 * @returns Formatted phone number (xxx) xxx-xxxx
 */
export function formatPhoneForDisplay(phone: string | null | undefined): string {
  const normalized = normalizePhoneNumber(phone);
  if (!normalized) return '';
  
  const digitsOnly = normalized.replace(/\D/g, '');
  
  // US format: +1 (xxx) xxx-xxxx
  if (digitsOnly.startsWith('1') && digitsOnly.length === 11) {
    const areaCode = digitsOnly.slice(1, 4);
    const prefix = digitsOnly.slice(4, 7);
    const lineNumber = digitsOnly.slice(7, 11);
    return `(${areaCode}) ${prefix}-${lineNumber}`;
  }
  
  // International or other format: just return normalized
  return normalized;
}

/**
 * Normalize phone number for storage in CRM (xxx) xxx-xxxx format
 * This is the standard format used throughout the CRM for consistency
 * @param phone - Phone number in any format
 * @returns Formatted phone number (xxx) xxx-xxxx or empty string if invalid
 */
export function normalizePhoneForStorage(phone: string | null | undefined): string {
  if (!phone) return '';
  
  // First normalize to E.164 to handle all input formats
  const e164 = normalizePhoneNumber(phone);
  if (!e164) return '';
  
  // Then format for display/storage
  return formatPhoneForDisplay(e164);
}

/**
 * Normalize an array of phone numbers for storage in CRM format
 * @param phones - Array of phone numbers in any format
 * @returns Array of normalized phone numbers in (xxx) xxx-xxxx format, filtering out empty/invalid ones
 */
export function normalizePhoneArrayForStorage(
  phones: (string | null | undefined)[] | null | undefined
): string[] {
  if (!phones || !Array.isArray(phones)) return [];
  
  return phones
    .map(phone => normalizePhoneForStorage(phone))
    .filter(phone => phone !== '');
}

// Example usage:
// normalizePhoneNumber('(415) 555-1234')      -> '+14155551234'
// normalizePhoneNumber('415-555-1234')        -> '+14155551234'
// normalizePhoneNumber('4155551234')          -> '+14155551234'
// normalizePhoneNumber('+1(415)555-1234')     -> '+14155551234'
// normalizePhoneNumber('+1 415 555 1234')     -> '+14155551234'
// normalizePhoneNumber('1-415-555-1234')      -> '+14155551234'
// normalizePhoneNumber('+44 20 7946 0958')    -> '+442079460958'

/**
 * Normalize a phone number into Housecall Pro's required `mobile_number` format:
 * exactly 10 digits with no formatting characters. Drops a leading `1` country
 * code if present (so `+1 (415) 555-1234` and `(415) 555-1234` both yield
 * `4155551234`). Returns `undefined` when the input does not contain a usable
 * 10-digit US number — callers should omit the field entirely in that case
 * rather than send an invalid value to HCP (which 400s with
 * "Mobile number must be exactly 10 digits").
 */
export function normalizePhoneForHcp(phone: string | null | undefined): string | undefined {
  if (!phone) return undefined;
  const digitsOnly = String(phone).replace(/\D/g, '');
  if (!digitsOnly) return undefined;

  let tenDigits = digitsOnly;
  if (tenDigits.length === 11 && tenDigits.startsWith('1')) {
    tenDigits = tenDigits.slice(1);
  }
  if (tenDigits.length !== 10) return undefined;
  return tenDigits;
}

/**
 * Mask a phone number for logging: show country code (if present) + last 4 digits.
 * Examples:
 *   +14155551234  →  +1...1234
 *   4155551234    →  ...1234
 *   +447700900123 →  +44...0123
 */
export function maskPhone(phone: string | null | undefined): string {
  if (!phone || typeof phone !== 'string' || phone.trim() === '') return '';
  const cleaned = phone.replace(/[^\d+]/g, '');
  if (cleaned.length < 4) return '...';
  const lastFour = cleaned.slice(-4);
  const countryCodeMatch = cleaned.match(/^\+(\d{1,3})/);
  const prefix = countryCodeMatch ? `+${countryCodeMatch[1]}...` : '...';
  return `${prefix}${lastFour}`;
}
