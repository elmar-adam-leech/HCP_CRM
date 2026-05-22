/**
 * Thin Google Local Services Ads (GLS) API client.
 *
 * Centralizes:
 *   - OAuth refresh-token → access-token exchange (with brief in-memory cache).
 *   - List the GLS accounts the connected Google user can manage.
 *   - Fetch detailed lead reports for a date window.
 *   - Consistent error reporting + retry on transient 5xx/429.
 *
 * GLS API docs:
 *   https://developers.google.com/local-services-ads/reference/rest
 *
 * Required OAuth scope:
 *   https://www.googleapis.com/auth/adwords
 *
 * Credentials are passed in by the caller (resolved per tenant via
 * `resolveGlsCredentials`). Tenants may bring their own OAuth client + Google
 * Ads developer token; otherwise the platform-level credentials are used.
 */
import { httpJson, type HttpError } from '../utils/http';
import { logger } from '../utils/logger';
import type { GlsCredentials } from './google-local-services-credentials';

const log = logger('GoogleLocalServicesClient');

const GLS_BASE_URL = 'https://localservices.googleapis.com/v1';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

// Buffer access tokens for ~50 minutes (Google issues ~1h tokens).
const ACCESS_TOKEN_TTL_MS = 50 * 60 * 1000;

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}
// Keyed on `${refreshToken}::${clientId}` so platform vs. tenant OAuth-client
// access tokens never collide for the same refresh token. (In practice a
// refresh token only works against the client that issued it, but if a tenant
// changes their client_id mid-flight we never want to hand back a token that
// was minted under a different client.)
const tokenCache = new Map<string, CachedToken>();

function cacheKey(refreshToken: string, clientId: string): string {
  return `${refreshToken}::${clientId}`;
}

export interface GlsAccountSummary {
  accountId: string;
  businessName: string;
  currencyCode?: string;
}

/**
 * Dispute reason codes accepted by GLS. The set Google publishes evolves; we
 * keep ours intentionally small and map directly to GLS's documented values
 * (https://support.google.com/localservices/answer/7641956 — "Dispute a lead").
 * `OTHER` requires a free-text note so contractors can explain unusual cases.
 */
export const GLS_DISPUTE_REASONS = [
  'SPAM',
  'WRONG_GEO',
  'WRONG_JOB_TYPE',
  'WRONG_BUSINESS',
  'DUPLICATE',
  'NO_CONTACT_INFO',
  'OTHER',
] as const;
export type GlsDisputeReason = typeof GLS_DISPUTE_REASONS[number];

export type GlsLeadType = 'MESSAGE' | 'PHONE_CALL' | 'BOOKING' | string;
export type GlsLeadCategory = string;
export type GlsChargeStatus = 'CHARGED' | 'NOT_CHARGED' | string;
export type GlsDisputeStatus =
  | 'NOT_DISPUTED'
  | 'DISPUTED'
  | 'DISPUTE_APPROVED'
  | 'DISPUTE_REJECTED'
  | string;

export interface GlsDetailedLead {
  /** Stable Google identifier for the lead — primary key for status updates. */
  leadId: string;
  /** Account this lead belongs to. */
  accountId: string;
  leadType: GlsLeadType;
  leadCategory?: GlsLeadCategory;
  leadCreationTimestamp?: string; // ISO 8601
  businessName?: string;
  geo?: string;
  chargeStatus?: GlsChargeStatus;
  disputeStatus?: GlsDisputeStatus;
  currencyCode?: string;
  leadPrice?: number;
  // Subtype-specific payloads
  messageLead?: {
    consumerPhoneNumber?: string;
    customerName?: string;
    postalCode?: string;
    jobType?: string;
    message?: string;
  };
  phoneLead?: {
    consumerPhoneNumber?: string;
    chargedCallTimestamp?: string;
    chargedConnectedCallDurationSeconds?: number;
  };
  bookingLead?: {
    consumerPhoneNumber?: string;
    customerName?: string;
    customerEmail?: string;
    jobType?: string;
    bookingAppointmentTimestamp?: string;
  };
  // The full original payload returned by GLS — preserved for audit.
  raw: Record<string, unknown>;
}

function requireOauth(creds: GlsCredentials): { clientId: string; clientSecret: string } {
  if (!creds.clientId || !creds.clientSecret) {
    throw new Error('Google Local Services OAuth client credentials are not configured');
  }
  return { clientId: creds.clientId, clientSecret: creds.clientSecret };
}

function buildHeaders(accessToken: string, developerToken: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };
  if (developerToken) headers['developer-token'] = developerToken;
  return headers;
}

async function withRetry<T>(label: string, fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
  let attempt = 0;
  let lastErr: unknown;
  while (attempt < maxAttempts) {
    attempt++;
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const ax = err as HttpError;
      const status = ax?.response?.status;
      const transient = !status || status >= 500 || status === 429;
      if (!transient || attempt >= maxAttempts) break;
      const delayMs = 500 * Math.pow(2, attempt - 1);
      log.warn(`[${label}] transient error (status=${status ?? 'n/a'}), retrying in ${delayMs}ms`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

export const googleLocalServicesClient = {
  /**
   * Exchange an OAuth authorization code for tokens (refresh + access).
   */
  async exchangeCodeForTokens(
    creds: GlsCredentials,
    code: string,
    redirectUri: string,
  ): Promise<{
    refreshToken: string;
    accessToken: string;
    expiresInSeconds: number;
  }> {
    const { clientId, clientSecret } = requireOauth(creds);

    const res = await httpJson(GOOGLE_TOKEN_URL, {
      method: 'POST',
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
      timeout: 15000,
    });

    const refresh = res.data?.refresh_token as string | undefined;
    if (!refresh) {
      throw new Error('Google did not return a refresh_token. The user may need to revoke prior access and re-authorize with prompt=consent.');
    }
    return {
      refreshToken: refresh,
      accessToken: res.data.access_token,
      expiresInSeconds: res.data.expires_in,
    };
  },

  /**
   * Get a fresh access token for a contractor, refreshing via the stored
   * refresh token if needed. Cached in-memory for ~50 minutes per
   * (refreshToken, clientId) pair to avoid hammering Google's token endpoint
   * and to keep platform/tenant OAuth-client tokens from colliding.
   */
  async getAccessToken(creds: GlsCredentials, refreshToken: string): Promise<string> {
    const { clientId, clientSecret } = requireOauth(creds);
    const key = cacheKey(refreshToken, clientId);

    const cached = tokenCache.get(key);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.accessToken;

    const res = await httpJson(GOOGLE_TOKEN_URL, {
      method: 'POST',
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
      timeout: 15000,
    });

    const accessToken = res.data?.access_token as string | undefined;
    if (!accessToken) throw new Error('Google did not return an access_token from refresh exchange');

    tokenCache.set(key, {
      accessToken,
      expiresAt: Date.now() + ACCESS_TOKEN_TTL_MS,
    });
    return accessToken;
  },

  /**
   * Probe the OAuth token endpoint to check whether the supplied
   * client_id / client_secret are valid, *without* consuming any GLS API
   * quota and without needing a real refresh token.
   *
   * Trick: we POST a deliberately bogus refresh_token to the token endpoint.
   *   - If the credentials are bad, Google returns 400 `invalid_client`.
   *   - If the credentials are good, Google returns 400 `invalid_grant`
   *     (the refresh token itself is rejected — which is what we want).
   *   - 5xx / network errors are treated as transient (we don't block save).
   *
   * Returns:
   *   { ok: true }                          → client_id / secret are valid
   *   { ok: false, kind: 'invalid_client' } → client_id or client_secret is wrong
   *   { ok: true, kind: 'transient' }       → couldn't reach Google; don't block
   */
  async verifyOauthClient(
    creds: GlsCredentials,
  ): Promise<
    | { ok: true; transient?: boolean }
    | { ok: false; reason: string; field: 'clientId' | 'clientSecret' | 'credentials' }
  > {
    if (!creds.clientId || !creds.clientSecret) {
      return { ok: false, reason: 'OAuth client_id and client_secret are required.', field: 'credentials' };
    }
    try {
      await httpJson(GOOGLE_TOKEN_URL, {
        method: 'POST',
        body: new URLSearchParams({
          client_id: creds.clientId,
          client_secret: creds.clientSecret,
          refresh_token: 'invalid-probe-token',
          grant_type: 'refresh_token',
        }),
        timeout: 10000,
      });
      // Unexpected 200 — treat as ok.
      return { ok: true };
    } catch (err) {
      const ax = err as HttpError;
      const status = ax?.response?.status;
      const data = ax?.response?.data;
      const errorCode = data?.error;
      if (status === 400 && errorCode === 'invalid_client') {
        // Google's invalid_client response doesn't tell us *which* of the
        // two is wrong, so attribute the error to clientSecret (by far the
        // more common typo — most users paste a fresh secret each time).
        return {
          ok: false,
          field: 'clientSecret',
          reason: 'Google rejected the OAuth Client ID or Client Secret. Double-check both values in your Google Cloud OAuth 2.0 client.',
        };
      }
      if (status === 401) {
        return {
          ok: false,
          field: 'clientSecret',
          reason: 'Google rejected the OAuth Client ID or Client Secret (401 unauthorized).',
        };
      }
      // invalid_grant (expected), or any 5xx / network — credentials are
      // either good or we just can't tell. Don't block the save.
      if (status && status >= 500) {
        log.warn(`[verifyOauthClient] transient ${status} from Google — allowing save`);
        return { ok: true, transient: true };
      }
      if (!status) {
        log.warn(`[verifyOauthClient] network error reaching Google — allowing save: ${ax?.message}`);
        return { ok: true, transient: true };
      }
      return { ok: true };
    }
  },

  /**
   * Verify the developer token by issuing a tiny `accountReports:search`
   * request (pageSize: 1, last 1 day). Requires a usable refresh_token whose
   * issuing client matches `creds.clientId`.
   *
   * Returns:
   *   { ok: true }                              → developer token works
   *   { ok: false, reason: '...' }              → developer token rejected
   *   { ok: true, transient: true }             → couldn't tell; don't block
   */
  async verifyDeveloperToken(
    creds: GlsCredentials,
    refreshToken: string,
  ): Promise<
    | { ok: true; transient?: boolean }
    | { ok: false; reason: string; field: 'developerToken' | 'credentials' }
  > {
    if (!creds.developerToken) {
      return { ok: false, reason: 'Developer token is required.', field: 'developerToken' };
    }
    let accessToken: string;
    try {
      accessToken = await this.getAccessToken(creds, refreshToken);
    } catch (err: any) {
      log.warn(`[verifyDeveloperToken] couldn't refresh access token — skipping check: ${err?.message || err}`);
      return { ok: true, transient: true };
    }
    const today = new Date();
    const start = new Date(today.getTime() - 24 * 60 * 60 * 1000);
    const query =
      `start_date_year:${start.getUTCFullYear()};start_date_month:${start.getUTCMonth() + 1};start_date_day:${start.getUTCDate()};` +
      `end_date_year:${today.getUTCFullYear()};end_date_month:${today.getUTCMonth() + 1};end_date_day:${today.getUTCDate()}`;
    try {
      await httpJson(`${GLS_BASE_URL}/accountReports:search`, {
        params: { query, pageSize: 1 },
        headers: buildHeaders(accessToken, creds.developerToken),
        timeout: 10000,
      });
      return { ok: true };
    } catch (err) {
      const ax = err as HttpError;
      const status = ax?.response?.status;
      const apiMsg = ax?.response?.data?.error?.message
        || (typeof ax?.response?.data === 'string' ? ax?.response?.data : undefined)
        || ax?.message
        || '';
      const lower = String(apiMsg).toLowerCase();
      const looksLikeDevTokenIssue =
        lower.includes('developer token') ||
        lower.includes('developer-token') ||
        lower.includes('developertoken');
      if (status === 401 || status === 403 || (status === 400 && looksLikeDevTokenIssue)) {
        return {
          ok: false,
          field: looksLikeDevTokenIssue ? 'developerToken' : 'credentials',
          reason: looksLikeDevTokenIssue
            ? `Google rejected the developer token: ${apiMsg}`
            : `Google rejected the credentials (HTTP ${status}): ${apiMsg}`,
        };
      }
      if (!status || status >= 500 || status === 429) {
        log.warn(`[verifyDeveloperToken] transient (status=${status ?? 'n/a'}) — allowing save`);
        return { ok: true, transient: true };
      }
      // Other 4xx — surface as a save-blocking error so the admin sees it.
      return {
        ok: false,
        field: 'credentials',
        reason: `Google rejected the request (HTTP ${status}): ${apiMsg}`,
      };
    }
  },

  /**
   * Revoke a refresh token at Google so the user is fully disconnected.
   * Failures are logged but never thrown — disconnect should always succeed locally.
   */
  async revokeRefreshToken(refreshToken: string, clientId?: string): Promise<void> {
    try {
      await httpJson('https://oauth2.googleapis.com/revoke', {
        method: 'POST',
        body: new URLSearchParams({ token: refreshToken }),
        timeout: 10000,
      });
    } catch (err: any) {
      log.warn(`[revoke] Failed to revoke Google refresh token (non-fatal): ${err?.message || err}`);
    }
    if (clientId) {
      tokenCache.delete(cacheKey(refreshToken, clientId));
    } else {
      // Drop every cached token for this refresh token regardless of clientId.
      for (const k of Array.from(tokenCache.keys())) {
        if (k.startsWith(`${refreshToken}::`)) tokenCache.delete(k);
      }
    }
  },

  /**
   * List accounts the user can manage via GLS.
   * GLS exposes accounts indirectly via accountReports — we collapse the report
   * into a unique list of (accountId, businessName).
   */
  async listAccounts(creds: GlsCredentials, refreshToken: string): Promise<GlsAccountSummary[]> {
    const accessToken = await this.getAccessToken(creds, refreshToken);
    // Query last 30 days so even quiet accounts show up in the report.
    const today = new Date();
    const start = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
    const query =
      `start_date_year:${start.getUTCFullYear()};start_date_month:${start.getUTCMonth() + 1};start_date_day:${start.getUTCDate()};` +
      `end_date_year:${today.getUTCFullYear()};end_date_month:${today.getUTCMonth() + 1};end_date_day:${today.getUTCDate()}`;

    const data: any = await withRetry('listAccounts', async () => {
      const res = await httpJson(`${GLS_BASE_URL}/accountReports:search`, {
        params: { query, pageSize: 100 },
        headers: buildHeaders(accessToken, creds.developerToken),
        timeout: 15000,
      });
      return res.data;
    });

    const reports: any[] = data?.accountReports ?? [];
    const map = new Map<string, GlsAccountSummary>();
    for (const r of reports) {
      const id = String(r.accountId ?? r.account_id ?? '');
      if (!id) continue;
      if (!map.has(id)) {
        map.set(id, {
          accountId: id,
          businessName: r.businessName ?? r.business_name ?? '',
          currencyCode: r.currencyCode ?? r.currency_code ?? undefined,
        });
      }
    }
    return Array.from(map.values());
  },

  /**
   * Submit a dispute for a single GLS lead so Google can review it for
   * credit. Mirrors the "Dispute" action available in the GLS dashboard.
   *
   * Endpoint:
   *   POST {GLS_BASE_URL}/accounts/{accountId}/leads/{leadId}:dispute
   *   Body: { disputeReason, disputeNotes? }
   *
   * Notes:
   * - Requires the same OAuth scope + developer token as the read endpoints.
   * - Google rejects duplicate disputes for the same lead with HTTP 409 — the
   *   caller surfaces that as "already disputed" rather than treating it as
   *   a hard failure. All other 4xx responses are surfaced verbatim so the
   *   contractor sees Google's explanation (e.g. "lead is too old to
   *   dispute").
   * - The full Google response body is returned (and persisted by the
   *   caller) for audit.
   */
  async disputeLead(opts: {
    creds: GlsCredentials;
    refreshToken: string;
    accountId: string;
    leadId: string;
    reason: GlsDisputeReason;
    notes?: string;
  }): Promise<{ status: 'submitted' | 'already_disputed'; response: Record<string, unknown> }> {
    const { creds, refreshToken, accountId, leadId, reason, notes } = opts;
    const accessToken = await this.getAccessToken(creds, refreshToken);
    const url = `${GLS_BASE_URL}/accounts/${encodeURIComponent(accountId)}/leads/${encodeURIComponent(leadId)}:dispute`;
    const body: Record<string, unknown> = { disputeReason: reason };
    if (notes) body.disputeNotes = notes;

    try {
      const data = await withRetry('disputeLead', async () => {
        const res = await httpJson(url, {
          method: 'POST',
          body,
          headers: buildHeaders(accessToken, creds.developerToken),
          timeout: 15000,
        });
        return res.data;
      });
      return { status: 'submitted', response: (data ?? {}) as Record<string, unknown> };
    } catch (err) {
      const ax = err as HttpError;
      const status = ax?.response?.status;
      // Google returns 409 (conflict) when the lead is already in a disputed
      // state. Treat that as a benign no-op so the CRM can still record local
      // metadata without surfacing a scary error.
      if (status === 409) {
        return {
          status: 'already_disputed',
          response: (ax.response?.data ?? { code: 409, message: 'Lead is already disputed.' }) as Record<string, unknown>,
        };
      }
      throw err;
    }
  },

  /**
   * Fetch detailed leads for a single account between two dates (inclusive).
   * Pagination is handled internally — returns the full list.
   */
  async fetchDetailedLeads(opts: {
    creds: GlsCredentials;
    refreshToken: string;
    accountId: string;
    startDate: Date;
    endDate: Date;
  }): Promise<GlsDetailedLead[]> {
    const { creds, refreshToken, accountId, startDate, endDate } = opts;
    const accessToken = await this.getAccessToken(creds, refreshToken);

    const query =
      `manager_customer_id:${accountId};` +
      `start_date_year:${startDate.getUTCFullYear()};start_date_month:${startDate.getUTCMonth() + 1};start_date_day:${startDate.getUTCDate()};` +
      `end_date_year:${endDate.getUTCFullYear()};end_date_month:${endDate.getUTCMonth() + 1};end_date_day:${endDate.getUTCDate()}`;

    const collected: GlsDetailedLead[] = [];
    let pageToken: string | undefined;
    do {
      const params: Record<string, string | number> = { query, pageSize: 200 };
      if (pageToken) params.pageToken = pageToken;

      const data: any = await withRetry('fetchDetailedLeads', async () => {
        const res = await httpJson(`${GLS_BASE_URL}/detailedLeadReports:search`, {
          params,
          headers: buildHeaders(accessToken, creds.developerToken),
          timeout: 20000,
        });
        return res.data;
      });

      const items: any[] = data?.detailedLeadReports ?? [];
      for (const r of items) {
        const lead = normalizeDetailedLead(r);
        if (lead.leadId) collected.push(lead);
      }
      pageToken = data?.nextPageToken || undefined;
    } while (pageToken);

    return collected;
  },
};

function normalizeDetailedLead(raw: any): GlsDetailedLead {
  const leadId = String(raw.leadId ?? raw.lead_id ?? '');
  return {
    leadId,
    accountId: String(raw.accountId ?? raw.account_id ?? ''),
    leadType: raw.leadType ?? raw.lead_type ?? '',
    leadCategory: raw.leadCategory ?? raw.lead_category,
    leadCreationTimestamp: raw.leadCreationTimestamp ?? raw.lead_creation_timestamp,
    businessName: raw.businessName ?? raw.business_name,
    geo: raw.geo,
    chargeStatus: raw.chargeStatus ?? raw.charge_status,
    disputeStatus: raw.disputeStatus ?? raw.dispute_status,
    currencyCode: raw.currencyCode ?? raw.currency_code,
    leadPrice: typeof raw.leadPrice === 'number' ? raw.leadPrice : raw.lead_price,
    messageLead: raw.messageLead ?? raw.message_lead,
    phoneLead: raw.phoneLead ?? raw.phone_lead,
    bookingLead: raw.bookingLead ?? raw.booking_lead,
    raw,
  };
}
