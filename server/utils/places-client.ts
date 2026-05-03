import { logger } from './logger';
import type { AddressComponents } from '../types/scheduling';

const log = logger('PlacesClient');

const PLACES_BASE_URL = 'https://places.googleapis.com/v1';
const DEFAULT_APP_URL = 'https://hcpcrm.replit.app';

function getApiKey(): string | undefined {
  return process.env.GOOGLE_MAPS_API_KEY;
}

function getAppUrl(): string {
  return process.env.APP_URL || DEFAULT_APP_URL;
}

export interface PlacesAutocompleteResponse {
  suggestions?: unknown[];
  error?: { message?: string; status?: string };
}

export interface PlacesDetailsResponse {
  formattedAddress?: string;
  addressComponents?: unknown[];
  error?: { message?: string; status?: string };
}

export interface PlacesClientResult<T> {
  ok: boolean;
  status: number;
  data: T;
}

/**
 * Calls the Google Places v1 autocomplete endpoint.
 * Returns null if the API key is not configured.
 * Returns a result object with ok/status/data on success or API error.
 */
export async function placesAutocomplete(
  input: string,
  sessionToken?: string
): Promise<PlacesClientResult<PlacesAutocompleteResponse> | null> {
  const apiKey = getApiKey();
  if (!apiKey) return null;

  const requestBody: Record<string, unknown> = {
    input: input.trim(),
    includedRegionCodes: ['us'],
  };
  if (sessionToken) {
    requestBody.sessionToken = sessionToken;
  }

  const response = await fetch(`${PLACES_BASE_URL}/places:autocomplete`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'Referer': getAppUrl(),
    },
    body: JSON.stringify(requestBody),
  });

  const data = await response.json() as PlacesAutocompleteResponse;
  if (!response.ok) {
    log.warn(`[Places Autocomplete] API error HTTP ${response.status}: ${data.error?.message ?? data.error?.status ?? 'unknown'}`, data);
  }
  return { ok: response.ok, status: response.status, data };
}

/**
 * Calls the Google Places v1 place details endpoint.
 * Returns null if the API key is not configured.
 * Returns a result object with ok/status/data on success or API error.
 */
export async function placesDetails(
  placeId: string,
  sessionToken?: string
): Promise<PlacesClientResult<PlacesDetailsResponse> | null> {
  const apiKey = getApiKey();
  if (!apiKey) return null;

  const detailsUrl = new URL(`${PLACES_BASE_URL}/places/${encodeURIComponent(placeId)}`);
  detailsUrl.searchParams.set('fields', 'formattedAddress,addressComponents');
  if (sessionToken) {
    detailsUrl.searchParams.set('sessionToken', sessionToken);
  }

  const response = await fetch(detailsUrl.toString(), {
    method: 'GET',
    headers: {
      'X-Goog-Api-Key': apiKey,
      'Referer': getAppUrl(),
    },
  });

  const data = await response.json() as PlacesDetailsResponse;
  if (!response.ok) {
    log.warn(`[Places Details] API error HTTP ${response.status}: ${data.error?.message ?? data.error?.status ?? 'unknown'}`, data);
  }
  return { ok: response.ok, status: response.status, data };
}

/**
 * Calls the Google Places v1 text search endpoint to canonicalize an address.
 * Returns the formatted address from the first result, or undefined on failure/no results.
 * Includes the Referer header required by API key referrer restrictions.
 *
 * @param textQuery - The raw address string to look up.
 * @param apiKey - Optional API key override; falls back to GOOGLE_MAPS_API_KEY env var.
 */
export async function placesTextSearch(
  textQuery: string,
  apiKey?: string
): Promise<string | undefined> {
  const resolvedApiKey = apiKey ?? getApiKey();
  if (!resolvedApiKey || !textQuery || !textQuery.trim()) {
    return undefined;
  }

  try {
    const response = await fetch(`${PLACES_BASE_URL}/places:searchText`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': resolvedApiKey,
        'X-Goog-FieldMask': 'places.formattedAddress',
        'Referer': getAppUrl(),
      },
      body: JSON.stringify({ textQuery }),
    });

    if (!response.ok) {
      log.warn(`[Places Text Search] API returned ${response.status} for query "${textQuery}" — keeping raw value`);
      return undefined;
    }

    const data = await response.json() as { places?: Array<{ formattedAddress?: string }> };
    const formattedAddress = data?.places?.[0]?.formattedAddress;
    if (formattedAddress) {
      log.info(`[Places Text Search] Normalized: "${textQuery}" → "${formattedAddress}"`);
      return formattedAddress;
    }

    log.warn(`[Places Text Search] No results for: "${textQuery}" — keeping raw value`);
    return undefined;
  } catch (err) {
    log.warn(`[Places Text Search] Lookup failed for "${textQuery}" — keeping raw value:`, err instanceof Error ? err.message : err);
    return undefined;
  }
}

interface PlaceComponent { types?: string[]; longText?: string; shortText?: string }

/**
 * Pure helper: parses Places v1 `addressComponents` array into our
 * `AddressComponents` shape. Exported so callers (and tests) that already
 * have raw place data — e.g. the existing client place-details endpoint —
 * can reuse the exact same parsing rules.
 */
export function parsePlaceAddressComponents(
  components: PlaceComponent[] | undefined,
): AddressComponents | undefined {
  if (!components || components.length === 0) return undefined;
  let streetNumber = '';
  let route = '';
  let city = '';
  let state = '';
  let zip = '';
  for (const c of components) {
    const types = c.types || [];
    if (types.includes('street_number')) streetNumber = c.longText || '';
    else if (types.includes('route')) route = c.longText || '';
    else if (types.includes('locality')) city = c.longText || '';
    else if (!city && types.includes('postal_town')) city = c.longText || '';
    else if (!city && types.includes('sublocality')) city = c.longText || '';
    else if (types.includes('administrative_area_level_1')) state = c.shortText || '';
    else if (types.includes('postal_code')) zip = c.longText || '';
  }
  const street = [streetNumber, route].filter(Boolean).join(' ');
  if (!street || !city || !state || !zip) return undefined;
  return { street, city, state, zip, country: 'US' };
}

/**
 * Resolves a free-text address into structured `AddressComponents` via the
 * Google Places v1 text-search → details flow:
 *
 *   1. text-search returns the top matching place (id + formatted address).
 *   2. details lookup returns the parsed `addressComponents`, which we run
 *      through the same `parsePlaceAddressComponents` helper used by the
 *      client-side `/api/places/details` endpoint.
 *
 * Used as a server-side safety net when a booking submission arrives without
 * structured `customerAddressComponents` — or with only a partial set
 * (e.g. just `street` but no city/state/zip, which is what the client
 * produces when the details lookup fails). Returns `undefined` on any
 * failure; the caller falls through to the existing best-effort string
 * parser.
 */
export async function placesResolveAddressComponents(
  text: string,
): Promise<AddressComponents | undefined> {
  const apiKey = getApiKey();
  if (!apiKey) return undefined;
  const trimmed = text?.trim();
  if (!trimmed) return undefined;

  try {
    // Step 1: text-search to canonicalize the typed string into a placeId.
    const searchResp = await fetch(`${PLACES_BASE_URL}/places:searchText`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'places.id,places.formattedAddress',
        'Referer': getAppUrl(),
      },
      body: JSON.stringify({ textQuery: trimmed, regionCode: 'US' }),
    });
    if (!searchResp.ok) {
      log.warn(`[Places Resolve Components] text-search HTTP ${searchResp.status} for "${trimmed}"`);
      return undefined;
    }
    const searchData = (await searchResp.json()) as { places?: Array<{ id?: string; formattedAddress?: string }> };
    const top = searchData?.places?.[0];
    const placeId = top?.id;
    if (!placeId) {
      log.warn(`[Places Resolve Components] text-search returned no place for "${trimmed}"`);
      return undefined;
    }

    // Step 2: details lookup → addressComponents (reuses placesDetails so
    // we share parsing/error handling with the client-driven path).
    const detailsResult = await placesDetails(placeId);
    if (!detailsResult || !detailsResult.ok) {
      log.warn(`[Places Resolve Components] details lookup failed for placeId "${placeId}" (text="${trimmed}")`);
      return undefined;
    }
    const parsed = parsePlaceAddressComponents(
      detailsResult.data.addressComponents as PlaceComponent[] | undefined,
    );
    if (!parsed) {
      log.warn(`[Places Resolve Components] incomplete components parsed for "${trimmed}" (formatted="${top?.formattedAddress ?? ''}") — falling through`);
      return undefined;
    }

    log.info(`[Places Resolve Components] Resolved "${trimmed}" → street="${parsed.street}", city="${parsed.city}", state="${parsed.state}", zip="${parsed.zip}"`);
    return parsed;
  } catch (err) {
    log.warn(`[Places Resolve Components] Lookup failed for "${trimmed}":`, err instanceof Error ? err.message : err);
    return undefined;
  }
}
