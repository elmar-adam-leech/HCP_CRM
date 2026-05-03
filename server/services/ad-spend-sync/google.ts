import { CredentialService } from "../../credential-service";
import { storage } from "../../storage";
import { logger } from "../../utils/logger";

const log = logger("AdSpendSyncGoogle");

const SERVICE = "google-ads";
const PLATFORM_KEY = "google";
const SOURCE = "google_ads" as const;
const GOOGLE_ADS_API_VERSION = "v21";
const LOOKBACK_MONTHS = 6;

export interface GoogleAdsCredentials {
  developerToken: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  customerId: string;       // e.g. "1234567890" — the account to query
  loginCustomerId?: string; // manager account id, optional
}

async function loadCredentials(contractorId: string): Promise<GoogleAdsCredentials | null> {
  const creds = await CredentialService.getServiceCredentials(contractorId, SERVICE);
  const developerToken = creds.developer_token;
  const clientId = creds.client_id;
  const clientSecret = creds.client_secret;
  const refreshToken = creds.refresh_token;
  const customerId = creds.customer_id;
  if (!developerToken || !clientId || !clientSecret || !refreshToken || !customerId) {
    return null;
  }
  return {
    developerToken,
    clientId,
    clientSecret,
    refreshToken,
    customerId,
    loginCustomerId: creds.login_customer_id || undefined,
  };
}

const accessTokenCache = new Map<string, { token: string; expiresAt: number }>();

async function getAccessToken(creds: GoogleAdsCredentials): Promise<string> {
  const cacheKey = `${creds.clientId}:${creds.refreshToken}`;
  const cached = accessTokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.token;
  }
  const params = new URLSearchParams({
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    refresh_token: creds.refreshToken,
    grant_type: "refresh_token",
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  let response: Response;
  try {
    response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`google oauth ${response.status}: ${body.slice(0, 300)}`);
  }
  const json = await response.json() as { access_token?: string; expires_in?: number };
  if (!json.access_token) throw new Error("google oauth response missing access_token");
  accessTokenCache.set(cacheKey, {
    token: json.access_token,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
  });
  return json.access_token;
}

interface GoogleAdsSearchRow {
  segments?: { month?: string };
  metrics?: { costMicros?: string };
}

async function fetchMonthlySpend(creds: GoogleAdsCredentials): Promise<{ month: string; amount: string }[]> {
  const accessToken = await getAccessToken(creds);
  const today = new Date();
  const since = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - (LOOKBACK_MONTHS - 1), 1));
  const sinceStr = since.toISOString().slice(0, 10);
  const untilStr = today.toISOString().slice(0, 10);

  const query = `SELECT segments.month, metrics.cost_micros FROM customer WHERE segments.date BETWEEN '${sinceStr}' AND '${untilStr}'`;
  const url = `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}/customers/${creds.customerId}/googleAds:searchStream`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "developer-token": creds.developerToken,
    "Content-Type": "application/json",
  };
  if (creds.loginCustomerId) headers["login-customer-id"] = creds.loginCustomerId;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ query }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`google ads ${response.status}: ${body.slice(0, 300)}`);
  }
  const json = await response.json() as { results?: GoogleAdsSearchRow[] }[] | { results?: GoogleAdsSearchRow[] };
  const chunks = Array.isArray(json) ? json : [json];
  const allRows: GoogleAdsSearchRow[] = chunks.flatMap((c) => c.results ?? []);

  const byMonth = new Map<string, number>();
  for (const row of allRows) {
    const month = row.segments?.month;
    if (!month) continue;
    const monthKey = `${month.slice(0, 7)}-01`;
    const micros = Number(row.metrics?.costMicros ?? 0);
    if (!Number.isFinite(micros)) continue;
    byMonth.set(monthKey, (byMonth.get(monthKey) ?? 0) + micros);
  }
  return Array.from(byMonth.entries()).map(([month, micros]) => ({
    month,
    amount: (micros / 1_000_000).toFixed(2),
  }));
}

export interface GoogleSyncResult {
  contractorId: string;
  attempted: number;
  upserted: number;
  skippedManual: number;
  error?: string;
}

export async function syncGoogleAdSpendForContractor(contractorId: string): Promise<GoogleSyncResult> {
  const result: GoogleSyncResult = {
    contractorId, attempted: 0, upserted: 0, skippedManual: 0,
  };
  let creds: GoogleAdsCredentials | null;
  try {
    creds = await loadCredentials(contractorId);
  } catch (err) {
    result.error = `credentials: ${err instanceof Error ? err.message : String(err)}`;
    return result;
  }
  if (!creds) return result;

  let rows: { month: string; amount: string }[];
  try {
    rows = await fetchMonthlySpend(creds);
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    log.warn(`Google Ads fetch failed for ${contractorId}: ${result.error}`);
    return result;
  }

  for (const row of rows) {
    result.attempted += 1;
    try {
      const upserted = await storage.upsertAutoSyncedSpend({
        contractorId,
        platform: PLATFORM_KEY,
        month: row.month,
        amount: row.amount,
        source: SOURCE,
        externalAccountId: creds.customerId,
      });
      if (upserted) result.upserted += 1;
      else result.skippedManual += 1;
    } catch (err) {
      log.warn(`Failed to upsert Google spend for ${contractorId} ${row.month}: ${err instanceof Error ? err.message : err}`);
    }
  }
  return result;
}

export const _googleAdSpendInternal = { loadCredentials, fetchMonthlySpend, getAccessToken };
