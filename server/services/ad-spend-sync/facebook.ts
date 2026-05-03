import { CredentialService } from "../../credential-service";
import { storage } from "../../storage";
import { logger } from "../../utils/logger";

const log = logger("AdSpendSyncFacebook");

const FB_API_VERSION = "v25.0";
const SERVICE = "facebook-ads";
const PLATFORM_KEY = "facebook";
const SOURCE = "facebook_ads" as const;

const LOOKBACK_MONTHS = 6;

export interface FacebookAdsCredentials {
  accessToken: string;
  adAccountId: string; // e.g. "act_1234567890"
}

async function loadCredentials(contractorId: string): Promise<FacebookAdsCredentials | null> {
  const [accessToken, adAccountId] = await Promise.all([
    CredentialService.getCredential(contractorId, SERVICE, "access_token"),
    CredentialService.getCredential(contractorId, SERVICE, "ad_account_id"),
  ]);
  if (!accessToken || !adAccountId) return null;
  return { accessToken, adAccountId };
}

interface FbInsightRow {
  spend?: string;
  date_start?: string;
  date_stop?: string;
}

async function fetchMonthlySpend(creds: FacebookAdsCredentials): Promise<{ month: string; amount: string }[]> {
  const today = new Date();
  const since = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - (LOOKBACK_MONTHS - 1), 1));
  const sinceStr = since.toISOString().slice(0, 10);
  const untilStr = today.toISOString().slice(0, 10);

  const url = new URL(`https://graph.facebook.com/${FB_API_VERSION}/${creds.adAccountId}/insights`);
  url.searchParams.set("fields", "spend");
  url.searchParams.set("time_range", JSON.stringify({ since: sinceStr, until: untilStr }));
  url.searchParams.set("time_increment", "monthly");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  let response: Response;
  try {
    response = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${creds.accessToken}` },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`facebook insights ${response.status}: ${body.slice(0, 300)}`);
  }
  const json = await response.json() as { data?: FbInsightRow[] };
  const data = Array.isArray(json.data) ? json.data : [];
  return data.flatMap((row) => {
    if (!row.date_start || !row.spend) return [];
    const month = `${row.date_start.slice(0, 7)}-01`;
    return [{ month, amount: String(row.spend) }];
  });
}

export interface FacebookSyncResult {
  contractorId: string;
  attempted: number;
  upserted: number;
  skippedManual: number;
  error?: string;
}

export async function syncFacebookAdSpendForContractor(contractorId: string): Promise<FacebookSyncResult> {
  const result: FacebookSyncResult = {
    contractorId, attempted: 0, upserted: 0, skippedManual: 0,
  };
  let creds: FacebookAdsCredentials | null;
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
    log.warn(`Facebook fetch failed for ${contractorId}: ${result.error}`);
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
        externalAccountId: creds.adAccountId,
      });
      if (upserted) result.upserted += 1;
      else result.skippedManual += 1;
    } catch (err) {
      log.warn(`Failed to upsert FB spend for ${contractorId} ${row.month}: ${err instanceof Error ? err.message : err}`);
    }
  }
  return result;
}

export const _facebookAdSpendInternal = { loadCredentials, fetchMonthlySpend };
