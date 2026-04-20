/**
 * Parses a US address string of the form "street, city, STATE zip[, Country]"
 * into structured components.  Any part that cannot be identified is returned
 * as an empty string so callers can always destructure safely.
 *
 * Supported format (produced by Facebook, Google, etc.):
 *   "4 Pine St #4, Indian Head, MD 20640, USA"
 *
 * Returns empty strings for all fields when the input is falsy or cannot be
 * parsed — never throws.
 */
export function parseAddressString(address: string): {
  street: string;
  city: string;
  state: string;
  zip: string;
} {
  const empty = { street: '', city: '', state: '', zip: '' };
  if (!address || !address.trim()) return empty;

  // Strip a trailing known country token (e.g. ", USA" or ", United States")
  // Deliberately narrow so we only remove genuine country labels, not city names.
  const withoutCountry = address.replace(/,\s*(?:USA|US|United States of America|United States|Canada)\s*$/i, '').trim();

  // Split on commas — expect: [street, city, "STATE zip"]
  const parts = withoutCountry.split(',').map(p => p.trim()).filter(Boolean);

  // Only a street line — no city/state/zip to extract
  if (parts.length === 1) return { street: parts[0], city: '', state: '', zip: '' };
  if (parts.length < 2) return empty;

  const street = parts[0];
  const city = parts[1];
  const stateZipPart = parts[2] ?? '';

  // "STATE zip" — normalise state to upper-case for tolerance; zip is 5 (or 5+4) digits
  const stateZipMatch = stateZipPart.toUpperCase().match(/^([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/);
  if (!stateZipMatch) {
    // We at least have street and city
    return { street, city, state: '', zip: '' };
  }

  return { street, city, state: stateZipMatch[1], zip: stateZipMatch[2] };
}

/**
 * Builds a formatted display address string from structured address components.
 * Returns undefined if all fields are empty/falsy.
 */
export function buildFormattedAddress(
  street?: string | null,
  city?: string | null,
  state?: string | null,
  zip?: string | null,
): string | undefined {
  const stateZip = [state, zip].filter(Boolean).join(' ');
  const parts = [street, city, stateZip].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : undefined;
}
