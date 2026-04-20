import { logger } from '../utils/logger';
import { credentialService } from '../credential-service';
import type { HousecallProResponse } from './types';

const log = logger('HcpService');

/** Per-tenant credential cache entry */
interface CachedCredential {
  apiKey: string;
  /** Unix timestamp (ms) after which the cache entry should be discarded */
  expiresAt: number;
}

/** 5-minute TTL for cached credentials (ms) */
const CREDENTIAL_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Extracts a typed array from a Housecall Pro response envelope.
 *
 * HCP uses several different top-level keys across endpoints:
 *   - `data`      (JSON:API style)
 *   - `<resource>` (e.g. `estimates`, `jobs`, `events`)
 *   - bare array  (some older endpoints)
 *
 * Callers pass the expected primary key so the right field is checked first.
 * Falls back through `data` then a bare-array check so the helper is robust
 * against future HCP API inconsistencies.
 */
export function extractHcpList<T>(envelope: unknown, primaryKey: string): T[] {
  if (envelope === null || envelope === undefined) return [];
  const env = envelope as Record<string, unknown>;
  if (Array.isArray(env[primaryKey])) return env[primaryKey] as T[];
  if (Array.isArray(env['data'])) return env['data'] as T[];
  if (Array.isArray(envelope)) return envelope as T[];
  return [];
}

export class HcpBaseClient {
  protected readonly baseUrl = 'https://api.housecallpro.com';

  /**
   * Shared credential cache across all HcpBaseClient subclass instances.
   * Static so estimates, scheduling, jobs, and all other modules share the
   * same cached values — eliminating duplicate DB lookups regardless of
   * which module makes the first request for a given tenant.
   */
  private static readonly credentialCache = new Map<string, CachedCredential>();

  protected async getCredentials(tenantId: string): Promise<{ apiKey: string }> {
    const now = Date.now();
    const cached = HcpBaseClient.credentialCache.get(tenantId);
    if (cached) {
      if (cached.expiresAt > now) {
        return { apiKey: cached.apiKey };
      }
      // Entry exists but has expired — evict it so the Map stays bounded.
      HcpBaseClient.credentialCache.delete(tenantId);
    }

    let credentials = await credentialService.getCredentialsWithFallback(tenantId, 'housecall-pro');
    
    if (!credentials.api_key) {
      credentials = await credentialService.getCredentialsWithFallback(tenantId, 'housecallpro');
    }

    if (!credentials.api_key) {
      throw new Error(`Housecall Pro API key not configured for tenant ${tenantId}`);
    }

    HcpBaseClient.credentialCache.set(tenantId, {
      apiKey: credentials.api_key,
      expiresAt: now + CREDENTIAL_CACHE_TTL_MS,
    });

    return { apiKey: credentials.api_key };
  }

  /** Invalidates the credential cache for a tenant (called on 401 responses). */
  protected invalidateCredentialCache(tenantId: string): void {
    HcpBaseClient.credentialCache.delete(tenantId);
  }

  protected isRetryableStatus(status: number): boolean {
    return status === 429 || (status >= 500 && status < 600);
  }

  protected sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async makeRequest<T>(
    endpoint: string,
    tenantId: string,
    method: string = 'GET',
    body?: Record<string, unknown>,
    maxRetries: number = 3,
    /** Explicit Accept header; defaults to application/vnd.api+json */
    acceptHeader: string = 'application/vnd.api+json'
  ): Promise<HousecallProResponse<T>> {
    let apiKey: string;
    try {
      const credentials = await this.getCredentials(tenantId);
      apiKey = credentials.apiKey;
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get Housecall Pro credentials',
      };
    }

    let lastError: string = 'Unknown error occurred';
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          const backoffMs = Math.pow(2, attempt - 1) * 1000;
          log.info(`[HCP] Retry attempt ${attempt}/${maxRetries} after ${backoffMs}ms delay for ${method} ${endpoint}`);
          await this.sleep(backoffMs);
        }
        
        const response = await fetch(`${this.baseUrl}${endpoint}`, {
          method,
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'Accept': acceptHeader,
          },
          body: body ? JSON.stringify(body) : undefined,
        });

        if (!response.ok) {
          // A 401 means the cached key is no longer valid — evict it so the
          // next caller fetches a fresh key from the credential service.
          if (response.status === 401) {
            this.invalidateCredentialCache(tenantId);
          }

          let errorMessage = `HTTP ${response.status}`;
          try {
            const contentType = response.headers.get('content-type');
            if (contentType && contentType.includes('application/json')) {
              const errorData = await response.json();
              log.info(`[HCP] API Error ${response.status} for ${method} ${endpoint}:`, JSON.stringify(errorData));
              errorMessage = errorData.message || errorData.error || JSON.stringify(errorData);
            } else {
              const errorText = await response.text();
              log.info(`[HCP] API Error ${response.status} for ${method} ${endpoint}:`, errorText);
              errorMessage = errorText.substring(0, 200) || errorMessage;
            }
          } catch (parseError) {
            errorMessage = `HTTP ${response.status} ${response.statusText}`;
          }
          
          if (body) {
            log.info(`[HCP] Request body was:`, JSON.stringify(body));
          }
          
          lastError = `Housecall Pro API Error: ${errorMessage}`;
          
          if (this.isRetryableStatus(response.status) && attempt < maxRetries) {
            log.info(`[HCP] Retryable error (${response.status}), will retry...`);
            continue;
          }
          
          return {
            success: false,
            error: lastError,
          };
        }

        // Some endpoints (e.g. DELETE /customers/:id/addresses/:address_id)
        // return 204 No Content with an empty body. Don't try to parse JSON
        // in that case — calling response.json() on an empty body throws and
        // would surface a successful API call as a false failure.
        const contentLengthHeader = response.headers.get('content-length');
        const isNoContent = response.status === 204 || contentLengthHeader === '0';
        if (isNoContent) {
          return { success: true, data: undefined as unknown as T };
        }
        const rawBody = await response.text();
        if (!rawBody) {
          return { success: true, data: undefined as unknown as T };
        }
        const responseData = JSON.parse(rawBody);

        return {
          success: true,
          data: responseData,
        };
      } catch (error) {
        lastError = error instanceof Error ? error.message : 'Unknown error occurred';
        log.info(`[HCP] Network error on attempt ${attempt + 1}/${maxRetries + 1}: ${lastError}`);
        
        if (attempt < maxRetries) {
          continue;
        }
      }
    }
    
    return {
      success: false,
      error: lastError,
    };
  }
}
