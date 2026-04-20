import { placesTextSearch } from './places-client';

/**
 * Calls the Google Places v1 text-search API to canonicalize a raw address
 * string. Returns the `formattedAddress` from the first result, or `undefined`
 * if the lookup fails, returns no results, or the API key is missing.
 *
 * Callers should fall back to the raw value when `undefined` is returned.
 */
export async function normalizeAddress(
  rawAddress: string,
  apiKey: string | undefined
): Promise<string | undefined> {
  if (!rawAddress || !rawAddress.trim()) {
    return undefined;
  }
  return placesTextSearch(rawAddress, apiKey);
}
