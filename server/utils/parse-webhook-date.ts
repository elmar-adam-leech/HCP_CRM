/**
 * Parses date values from Housecall Pro (and similar) webhook payloads.
 *
 * HCP sends dates in three incompatible formats depending on the field:
 *   1. The string "none" or empty string — treat as null
 *   2. A Unix timestamp in SECONDS (values < 10,000,000,000 = before year 2286)
 *   3. A Unix timestamp in MILLISECONDS (values >= 10,000,000,000)
 *   4. An ISO 8601 string parseable by new Date()
 *
 * The seconds-vs-milliseconds threshold (10,000,000,000) is a safe cutoff:
 * Unix seconds won't reach that value until the year 2286, so any numeric
 * value below it is unambiguously seconds.
 */
export function parseWebhookDate(value: unknown): Date | null {
  if (!value) return null;

  if (typeof value === 'string') {
    const lower = value.toLowerCase().trim();
    if (lower === 'none' || lower === '') return null;

    // Try ISO / standard date string first (catches "2024-01-15T10:00:00Z" etc.)
    const isoDate = new Date(value);
    if (!isNaN(isoDate.getTime())) return isoDate;
  }

  // Handle numeric values (may arrive as a JS number or a numeric string)
  const numValue = typeof value === 'number' ? value : parseFloat(value as string);

  if (
    !isNaN(numValue) &&
    // Guard: only treat pure-numeric strings as timestamps (reject "2024-01-15")
    (typeof value !== 'string' || /^\d+(\.\d+)?$/.test(value as string))
  ) {
    // Values below 10^10 are Unix seconds; at or above are milliseconds
    return numValue < 10_000_000_000
      ? new Date(numValue * 1000)
      : new Date(numValue);
  }

  return null;
}
