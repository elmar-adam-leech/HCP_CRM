/**
 * Dialpad module — credential resolution and HTTP client helper.
 *
 * Retry policy (reads only):
 *   - dialpadFetch throws on HTTP 429 / 5xx so withRetry can retry them.
 *   - 4xx (except 429) are NOT retried — they indicate a caller mistake.
 *   - Write operations (POST/DELETE) must NOT use withRetry. Comment each
 *     write-path call site with "no retry on write" to make this explicit.
 */

import { credentialService } from '../credential-service';

/**
 * Resolve Dialpad API credentials for a contractor.
 *
 * Resolution order:
 *   1. Tenant credentials stored via CredentialService.
 *   2. Environment variables (DIALPAD_API_KEY, DIALPAD_API_BASE_URL) as a
 *      system-level fallback for callers that operate without a specific tenant.
 *
 * Throws if no API key is available after both lookups.
 */
export async function getCredentials(
  contractorId: string
): Promise<{ apiKey: string; baseUrl: string }> {
  let credentials: Record<string, string> = {};

  if (contractorId) {
    credentials = await credentialService.getCredentialsWithFallback(contractorId, 'dialpad');
  }

  const apiKey = credentials.api_key || process.env.DIALPAD_API_KEY || '';
  const baseUrl =
    credentials.base_url ||
    process.env.DIALPAD_API_BASE_URL ||
    'https://dialpad.com/api/v2';

  if (!apiKey) {
    throw new Error(
      `Dialpad API key not configured for ${
        contractorId ? `contractor ${contractorId}` : 'system'
      }`
    );
  }

  return { apiKey, baseUrl };
}

/**
 * Wraps a fetch call and throws on retryable HTTP errors (429, 5xx) so that
 * `withRetry` can transparently retry transient Dialpad API failures.
 * 4xx errors (except 429) are not retried — they indicate a caller mistake.
 */
export async function dialpadFetch(url: string, init: RequestInit): Promise<Response> {
  const response = await fetch(url, init);
  if (response.status === 429 || response.status >= 500) {
    const body = await response.text();
    throw new Error(`Dialpad API error ${response.status}: ${body}`);
  }
  return response;
}
