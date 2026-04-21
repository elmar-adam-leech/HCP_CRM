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
 * Required env vars:
 *   GOOGLE_LOCAL_SERVICES_CLIENT_ID
 *   GOOGLE_LOCAL_SERVICES_CLIENT_SECRET
 *   GOOGLE_LOCAL_SERVICES_DEVELOPER_TOKEN  (issued by the Google Ads API team)
 */
import axios, { AxiosError } from 'axios';
import { logger } from '../utils/logger';

const log = logger('GoogleLocalServicesClient');

const GLS_BASE_URL = 'https://localservices.googleapis.com/v1';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

// Buffer access tokens for ~50 minutes (Google issues ~1h tokens).
const ACCESS_TOKEN_TTL_MS = 50 * 60 * 1000;

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}
const tokenCache = new Map<string, CachedToken>();

export interface GlsAccountSummary {
  accountId: string;
  businessName: string;
  currencyCode?: string;
}

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

function readClientCredentials(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env.GOOGLE_LOCAL_SERVICES_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_LOCAL_SERVICES_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

function buildHeaders(accessToken: string): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };
  const devToken = process.env.GOOGLE_LOCAL_SERVICES_DEVELOPER_TOKEN;
  if (devToken) headers['developer-token'] = devToken;
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
      const ax = err as AxiosError;
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
  isConfigured(): boolean {
    return !!readClientCredentials();
  },

  /**
   * Exchange an OAuth authorization code for tokens (refresh + access).
   */
  async exchangeCodeForTokens(code: string, redirectUri: string): Promise<{
    refreshToken: string;
    accessToken: string;
    expiresInSeconds: number;
  }> {
    const creds = readClientCredentials();
    if (!creds) throw new Error('GOOGLE_LOCAL_SERVICES_CLIENT_ID/SECRET not configured');

    const res = await axios.post(GOOGLE_TOKEN_URL, new URLSearchParams({
      code,
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }), { timeout: 15000 });

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
   * refresh token if needed. Cached in-memory for ~50 minutes per refresh
   * token to avoid hammering Google's token endpoint.
   */
  async getAccessToken(refreshToken: string): Promise<string> {
    const cached = tokenCache.get(refreshToken);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.accessToken;

    const creds = readClientCredentials();
    if (!creds) throw new Error('GOOGLE_LOCAL_SERVICES_CLIENT_ID/SECRET not configured');

    const res = await axios.post(GOOGLE_TOKEN_URL, new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }), { timeout: 15000 });

    const accessToken = res.data?.access_token as string | undefined;
    if (!accessToken) throw new Error('Google did not return an access_token from refresh exchange');

    tokenCache.set(refreshToken, {
      accessToken,
      expiresAt: Date.now() + ACCESS_TOKEN_TTL_MS,
    });
    return accessToken;
  },

  /**
   * Revoke a refresh token at Google so the user is fully disconnected.
   * Failures are logged but never thrown — disconnect should always succeed locally.
   */
  async revokeRefreshToken(refreshToken: string): Promise<void> {
    try {
      await axios.post(
        'https://oauth2.googleapis.com/revoke',
        new URLSearchParams({ token: refreshToken }),
        { timeout: 10000 }
      );
    } catch (err: any) {
      log.warn(`[revoke] Failed to revoke Google refresh token (non-fatal): ${err?.message || err}`);
    }
    tokenCache.delete(refreshToken);
  },

  /**
   * List accounts the user can manage via GLS.
   * GLS exposes accounts indirectly via accountReports — we collapse the report
   * into a unique list of (accountId, businessName).
   */
  async listAccounts(refreshToken: string): Promise<GlsAccountSummary[]> {
    const accessToken = await this.getAccessToken(refreshToken);
    // Query last 30 days so even quiet accounts show up in the report.
    const today = new Date();
    const start = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
    const query =
      `start_date_year:${start.getUTCFullYear()};start_date_month:${start.getUTCMonth() + 1};start_date_day:${start.getUTCDate()};` +
      `end_date_year:${today.getUTCFullYear()};end_date_month:${today.getUTCMonth() + 1};end_date_day:${today.getUTCDate()}`;

    const data: any = await withRetry('listAccounts', async () => {
      const res = await axios.get(`${GLS_BASE_URL}/accountReports:search`, {
        params: { query, pageSize: 100 },
        headers: buildHeaders(accessToken),
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
   * Fetch detailed leads for a single account between two dates (inclusive).
   * Pagination is handled internally — returns the full list.
   */
  async fetchDetailedLeads(opts: {
    refreshToken: string;
    accountId: string;
    startDate: Date;
    endDate: Date;
  }): Promise<GlsDetailedLead[]> {
    const { refreshToken, accountId, startDate, endDate } = opts;
    const accessToken = await this.getAccessToken(refreshToken);

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
        const res = await axios.get(`${GLS_BASE_URL}/detailedLeadReports:search`, {
          params,
          headers: buildHeaders(accessToken),
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
