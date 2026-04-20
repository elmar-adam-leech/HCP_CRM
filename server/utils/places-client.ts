import { logger } from './logger';

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
