/**
 * ROI by Source report.
 *
 * Returns per-platform aggregates over a date range:
 *   - leadCount     : leads.created_at falls in [start, end), grouped by source
 *   - wonCount      : approved canonical estimates (mode=estimates) OR
 *                     completed jobs (mode=jobs) created in [start, end),
 *                     grouped by the same source rollup
 *   - wonRevenue    : SUM(amount) of the won set
 *   - spend         : SUM(media_spend.amount) for months overlapping [start, end)
 *
 * Raw lead sources are rolled up to platforms (Facebook, Google, Yelp, ...)
 * via shared/lib/lead-platform.ts so the report and the Ad Spend settings
 * page agree on the bucket list. Each platform exposes:
 *   - `bySource`   : raw-source drill-down.
 *   - `byCampaign` : campaign drill-down. Leads/wins are matched to campaigns
 *                    via lead.utm_campaign (case/space-insensitive). Spend
 *                    rows with no campaign and leads/wins without
 *                    utm_campaign collapse into a single "Unattributed" bucket.
 */

import { db } from "../db";
import { sql } from "drizzle-orm";
import {
  LEAD_PLATFORMS,
  type LeadPlatform,
  getLeadPlatform,
  platformKey,
} from "@shared/lib/lead-platform";

export type RoiMode = "estimates" | "jobs";

export interface RoiSourceBreakdown {
  /** Raw source string (lowercased) or null when no source was recorded. */
  source: string | null;
  /** Friendly label — Title-cased raw key, or "Unknown" when source is null. */
  label: string;
  leadCount: number;
  wonCount: number;
  wonRevenue: number;
}

export interface RoiCampaignBreakdown {
  /** Normalized campaign key (lowercased+trimmed) or null for "Unattributed". */
  campaign: string | null;
  /** Friendly label — original campaign text or "Unattributed". */
  label: string;
  leadCount: number;
  wonCount: number;
  wonRevenue: number;
  spend: number | null;
  costPerLead: number | null;
  costPerWon: number | null;
  roas: number | null;
  roiPercent: number | null;
  /** Raw sources that rolled up into this campaign within the platform. */
  bySource: RoiSourceBreakdown[];
}

export interface RoiPlatformRow {
  platform: LeadPlatform;
  /** Lower-case canonical key — also used as `media_spend.platform`. */
  platformKey: string;
  leadCount: number;
  wonCount: number;
  wonRevenue: number;
  /** Manual ad spend, or null when no spend rows for this platform overlap the range. */
  spend: number | null;
  /** Cost per lead — null when spend is missing. */
  costPerLead: number | null;
  /** Cost per won deal — null when spend is missing. */
  costPerWon: number | null;
  /** Return on ad spend (revenue / spend) — null when spend is missing. */
  roas: number | null;
  /** ROI percent ((revenue - spend) / spend * 100) — null when spend is missing. */
  roiPercent: number | null;
  /** Drill-down: the raw sources that rolled up into this platform. */
  bySource: RoiSourceBreakdown[];
  /** Drill-down: campaigns within this platform. */
  byCampaign: RoiCampaignBreakdown[];
}

export interface RoiBySourceReport {
  mode: RoiMode;
  totals: {
    leadCount: number;
    wonCount: number;
    wonRevenue: number;
    spend: number | null;
    costPerLead: number | null;
    costPerWon: number | null;
    roas: number | null;
    roiPercent: number | null;
  };
  platforms: RoiPlatformRow[];
  /** True when the tenant has no media_spend rows at all (drives the empty state). */
  hasAnySpend: boolean;
}

const num = (v: unknown): number => {
  if (v === null || v === undefined) return 0;
  const n = typeof v === "number" ? v : Number(v as string);
  return Number.isFinite(n) ? n : 0;
};

const round2 = (n: number) => Math.round(n * 100) / 100;
const round1 = (n: number) => Math.round(n * 10) / 10;

function sourceLabel(source: string | null): string {
  if (!source) return "Unknown";
  return source
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Fetch leads grouped by raw source + utm_campaign for the given window. */
async function fetchLeadsBySource(
  contractorId: string,
  startDate: Date,
  endDate: Date,
): Promise<{ source: string | null; campaignKey: string | null; campaignLabel: string; count: number }[]> {
  const result = await db.execute<{
    source: string | null;
    campaign_key: string | null;
    campaign_label: string | null;
    count: string | number;
  }>(sql`
    SELECT
      LOWER(source) AS source,
      NULLIF(LOWER(TRIM(utm_campaign)), '') AS campaign_key,
      MIN(NULLIF(TRIM(utm_campaign), '')) AS campaign_label,
      COUNT(*)::int AS count
    FROM leads
    WHERE contractor_id = ${contractorId}
      AND created_at >= ${startDate.toISOString()}
      AND created_at < ${endDate.toISOString()}
    GROUP BY LOWER(source), NULLIF(LOWER(TRIM(utm_campaign)), '')
  `);
  return result.rows.map((r) => ({
    source: r.source ?? null,
    campaignKey: r.campaign_key ?? null,
    campaignLabel: r.campaign_label ?? "Unattributed",
    count: num(r.count),
  }));
}

/** Won estimates grouped by source + utm_campaign. */
async function fetchWonEstimatesBySource(
  contractorId: string,
  startDate: Date,
  endDate: Date,
): Promise<{ source: string | null; campaignKey: string | null; campaignLabel: string; count: number; revenue: number }[]> {
  const result = await db.execute<{
    source: string | null;
    campaign_key: string | null;
    campaign_label: string | null;
    count: string | number;
    revenue: string | null;
  }>(sql`
    WITH canonical AS (
      SELECT DISTINCT ON (COALESCE(housecall_pro_estimate_id, id::text)) *
      FROM estimates
      WHERE contractor_id = ${contractorId}
      ORDER BY COALESCE(housecall_pro_estimate_id, id::text),
               CASE WHEN status = 'approved' THEN 0 ELSE 1 END,
               amount::numeric DESC NULLS LAST,
               updated_at DESC
    ),
    estimate_lead AS (
      -- Pick a single lead per estimate so source and utm_campaign always
      -- come from the same row (avoids cross-attribution when an estimate
      -- has multiple converted leads).
      SELECT DISTINCT ON (l.converted_to_estimate_id)
        l.converted_to_estimate_id AS estimate_id,
        l.source AS source,
        l.utm_campaign AS utm_campaign
      FROM leads l
      WHERE l.contractor_id = ${contractorId}
        AND l.converted_to_estimate_id IS NOT NULL
      ORDER BY l.converted_to_estimate_id,
               (l.source IS NULL),
               (l.utm_campaign IS NULL),
               l.created_at DESC
    ),
    estimate_source AS (
      SELECT
        e.id,
        e.amount,
        LOWER(COALESCE(
          el.source,
          (SELECT c.source FROM contacts c WHERE c.id = e.contact_id LIMIT 1)
        )) AS source,
        NULLIF(TRIM(COALESCE(
          el.utm_campaign,
          (SELECT c.utm_campaign FROM contacts c WHERE c.id = e.contact_id LIMIT 1)
        )), '') AS campaign_raw
      FROM canonical e
      LEFT JOIN estimate_lead el ON el.estimate_id = e.id
      WHERE e.status = 'approved'
        AND e.created_at >= ${startDate.toISOString()}
        AND e.created_at < ${endDate.toISOString()}
    )
    SELECT
      source,
      LOWER(campaign_raw) AS campaign_key,
      MIN(campaign_raw) AS campaign_label,
      COUNT(*)::int AS count,
      SUM(amount::numeric)::float8 AS revenue
    FROM estimate_source
    GROUP BY source, LOWER(campaign_raw)
  `);
  return result.rows.map((r) => ({
    source: r.source ?? null,
    campaignKey: r.campaign_key ?? null,
    campaignLabel: r.campaign_label ?? "Unattributed",
    count: num(r.count),
    revenue: round2(num(r.revenue)),
  }));
}

/** Won (completed) jobs grouped by source + utm_campaign. */
async function fetchWonJobsBySource(
  contractorId: string,
  startDate: Date,
  endDate: Date,
): Promise<{ source: string | null; campaignKey: string | null; campaignLabel: string; count: number; revenue: number }[]> {
  const result = await db.execute<{
    source: string | null;
    campaign_key: string | null;
    campaign_label: string | null;
    count: string | number;
    revenue: string | null;
  }>(sql`
    WITH job_lead AS (
      -- One lead row per job (direct conversion preferred over estimate path),
      -- so source and utm_campaign always come from the same lead.
      SELECT DISTINCT ON (job_id)
        job_id,
        source,
        utm_campaign
      FROM (
        SELECT
          l.converted_to_job_id AS job_id,
          0 AS priority,
          l.source,
          l.utm_campaign,
          l.created_at
        FROM leads l
        WHERE l.contractor_id = ${contractorId}
          AND l.converted_to_job_id IS NOT NULL
        UNION ALL
        SELECT
          j.id AS job_id,
          1 AS priority,
          l.source,
          l.utm_campaign,
          l.created_at
        FROM jobs j
        JOIN leads l ON l.converted_to_estimate_id = j.estimate_id
        WHERE j.contractor_id = ${contractorId}
          AND j.estimate_id IS NOT NULL
          AND l.contractor_id = ${contractorId}
      ) candidates
      ORDER BY job_id, priority,
               (source IS NULL),
               (utm_campaign IS NULL),
               created_at DESC
    ),
    job_source AS (
      SELECT
        j.id,
        j.value,
        LOWER(COALESCE(
          jl.source,
          (SELECT c.source FROM contacts c WHERE c.id = j.contact_id LIMIT 1)
        )) AS source,
        NULLIF(TRIM(COALESCE(
          jl.utm_campaign,
          (SELECT c.utm_campaign FROM contacts c WHERE c.id = j.contact_id LIMIT 1)
        )), '') AS campaign_raw
      FROM jobs j
      LEFT JOIN job_lead jl ON jl.job_id = j.id
      WHERE j.contractor_id = ${contractorId}
        AND j.status = 'completed'
        AND j.created_at >= ${startDate.toISOString()}
        AND j.created_at < ${endDate.toISOString()}
    )
    SELECT
      source,
      LOWER(campaign_raw) AS campaign_key,
      MIN(campaign_raw) AS campaign_label,
      COUNT(*)::int AS count,
      SUM(value::numeric)::float8 AS revenue
    FROM job_source
    GROUP BY source, LOWER(campaign_raw)
  `);
  return result.rows.map((r) => ({
    source: r.source ?? null,
    campaignKey: r.campaign_key ?? null,
    campaignLabel: r.campaign_label ?? "Unattributed",
    count: num(r.count),
    revenue: round2(num(r.revenue)),
  }));
}

/** Manual ad spend whose month overlaps [startDate, endDate). Grouped by
 *  platform + campaign so each campaign gets its own ROI line. */
async function fetchSpendByPlatform(
  contractorId: string,
  startDate: Date,
  endDate: Date,
): Promise<{ platformKey: string; campaignKey: string | null; campaignLabel: string; spend: number }[]> {
  const result = await db.execute<{
    platform: string;
    campaign_key: string | null;
    campaign_label: string | null;
    spend: string | null;
  }>(sql`
    SELECT
      LOWER(platform) AS platform,
      NULLIF(LOWER(TRIM(campaign)), '') AS campaign_key,
      MIN(NULLIF(TRIM(campaign), '')) AS campaign_label,
      SUM(amount::numeric)::float8 AS spend
    FROM media_spend
    WHERE contractor_id = ${contractorId}
      AND month < date_trunc('month', ${endDate.toISOString()}::timestamptz) + interval '1 month'
      AND (month + interval '1 month') > date_trunc('month', ${startDate.toISOString()}::timestamptz)
    GROUP BY LOWER(platform), NULLIF(LOWER(TRIM(campaign)), '')
  `);
  return result.rows.map((r) => ({
    platformKey: r.platform,
    campaignKey: r.campaign_key ?? null,
    campaignLabel: r.campaign_label ?? "Unattributed",
    spend: round2(num(r.spend)),
  }));
}

/** Whether the tenant has any media_spend rows at all (used for empty state). */
async function tenantHasAnySpend(contractorId: string): Promise<boolean> {
  const result = await db.execute<{ exists_: boolean }>(sql`
    SELECT EXISTS(
      SELECT 1 FROM media_spend WHERE contractor_id = ${contractorId}
    ) AS exists_
  `);
  return Boolean(result.rows[0]?.exists_);
}

interface CampaignAccumulator {
  campaign: string | null;
  label: string;
  leadCount: number;
  wonCount: number;
  wonRevenue: number;
  bySource: Map<string, RoiSourceBreakdown>;
}

interface PlatformAccumulator {
  leadCount: number;
  wonCount: number;
  wonRevenue: number;
  bySource: Map<string, RoiSourceBreakdown>;
  byCampaign: Map<string, CampaignAccumulator>;
}

const CAMPAIGN_NULL_KEY = "__unattributed__";

function ensurePlatform(
  acc: Map<LeadPlatform, PlatformAccumulator>,
  platform: LeadPlatform,
): PlatformAccumulator {
  let entry = acc.get(platform);
  if (!entry) {
    entry = {
      leadCount: 0,
      wonCount: 0,
      wonRevenue: 0,
      bySource: new Map(),
      byCampaign: new Map(),
    };
    acc.set(platform, entry);
  }
  return entry;
}

function ensureSource(
  bySource: Map<string, RoiSourceBreakdown>,
  source: string | null,
): RoiSourceBreakdown {
  const key = source ?? "__unknown__";
  let entry = bySource.get(key);
  if (!entry) {
    entry = {
      source,
      label: sourceLabel(source),
      leadCount: 0,
      wonCount: 0,
      wonRevenue: 0,
    };
    bySource.set(key, entry);
  }
  return entry;
}

function ensureCampaign(
  acc: PlatformAccumulator,
  campaignKey: string | null,
  label: string,
): CampaignAccumulator {
  const key = campaignKey ?? CAMPAIGN_NULL_KEY;
  let entry = acc.byCampaign.get(key);
  if (!entry) {
    entry = {
      campaign: campaignKey,
      label,
      leadCount: 0,
      wonCount: 0,
      wonRevenue: 0,
      bySource: new Map(),
    };
    acc.byCampaign.set(key, entry);
  } else if (entry.label === "Unattributed" && label !== "Unattributed") {
    entry.label = label;
  }
  return entry;
}

function computeRates(
  spend: number | null,
  leadCount: number,
  wonCount: number,
  wonRevenue: number,
): {
  costPerLead: number | null;
  costPerWon: number | null;
  roas: number | null;
  roiPercent: number | null;
} {
  if (spend === null || spend <= 0) {
    return { costPerLead: null, costPerWon: null, roas: null, roiPercent: null };
  }
  return {
    costPerLead: leadCount > 0 ? round2(spend / leadCount) : null,
    costPerWon: wonCount > 0 ? round2(spend / wonCount) : null,
    roas: round2(wonRevenue / spend),
    roiPercent: round1(((wonRevenue - spend) / spend) * 100),
  };
}

export interface RoiBySourceFilters {
  startDate: Date;
  endDate: Date;
  mode: RoiMode;
}

export async function getRoiBySourceReport(
  contractorId: string,
  filters: RoiBySourceFilters,
): Promise<RoiBySourceReport> {
  const { startDate, endDate, mode } = filters;

  const [leadsBySource, wonBySource, spendByPlatform, hasAnySpend] = await Promise.all([
    fetchLeadsBySource(contractorId, startDate, endDate),
    mode === "estimates"
      ? fetchWonEstimatesBySource(contractorId, startDate, endDate)
      : fetchWonJobsBySource(contractorId, startDate, endDate),
    fetchSpendByPlatform(contractorId, startDate, endDate),
    tenantHasAnySpend(contractorId),
  ]);

  const platforms = new Map<LeadPlatform, PlatformAccumulator>();

  for (const row of leadsBySource) {
    const platform = getLeadPlatform(row.source);
    const acc = ensurePlatform(platforms, platform);
    acc.leadCount += row.count;
    ensureSource(acc.bySource, row.source).leadCount += row.count;

    const camp = ensureCampaign(acc, row.campaignKey, row.campaignLabel);
    camp.leadCount += row.count;
    ensureSource(camp.bySource, row.source).leadCount += row.count;
  }

  for (const row of wonBySource) {
    const platform = getLeadPlatform(row.source);
    const acc = ensurePlatform(platforms, platform);
    acc.wonCount += row.count;
    acc.wonRevenue += row.revenue;
    const sEntry = ensureSource(acc.bySource, row.source);
    sEntry.wonCount += row.count;
    sEntry.wonRevenue += row.revenue;

    const camp = ensureCampaign(acc, row.campaignKey, row.campaignLabel);
    camp.wonCount += row.count;
    camp.wonRevenue += row.revenue;
    const csEntry = ensureSource(camp.bySource, row.source);
    csEntry.wonCount += row.count;
    csEntry.wonRevenue += row.revenue;
  }

  // Spend lookup: total per platform, plus per (platform, campaign).
  const spendByPlatformKey = new Map<string, number>();
  const spendByCampaign = new Map<string, Map<string, { spend: number; label: string }>>();
  for (const row of spendByPlatform) {
    spendByPlatformKey.set(
      row.platformKey,
      (spendByPlatformKey.get(row.platformKey) ?? 0) + row.spend,
    );
    const platform =
      LEAD_PLATFORMS.find((p) => platformKey(p) === row.platformKey) ?? "Other";
    const acc = ensurePlatform(platforms, platform);
    // Make sure the campaign bucket exists even when no leads/wins matched it.
    ensureCampaign(acc, row.campaignKey, row.campaignLabel);

    let perCampaign = spendByCampaign.get(row.platformKey);
    if (!perCampaign) {
      perCampaign = new Map();
      spendByCampaign.set(row.platformKey, perCampaign);
    }
    const campKey = row.campaignKey ?? CAMPAIGN_NULL_KEY;
    const existing = perCampaign.get(campKey);
    if (existing) {
      existing.spend += row.spend;
    } else {
      perCampaign.set(campKey, { spend: row.spend, label: row.campaignLabel });
    }
  }

  const platformRows: RoiPlatformRow[] = Array.from(platforms.entries()).map(
    ([platform, acc]) => {
      const key = platformKey(platform);
      const spend = spendByPlatformKey.has(key)
        ? round2(spendByPlatformKey.get(key)!)
        : null;
      const rates = computeRates(spend, acc.leadCount, acc.wonCount, acc.wonRevenue);
      const bySource = Array.from(acc.bySource.values()).sort((a, b) => {
        if (b.leadCount !== a.leadCount) return b.leadCount - a.leadCount;
        return b.wonRevenue - a.wonRevenue;
      });

      const campSpendMap = spendByCampaign.get(key);
      const byCampaign: RoiCampaignBreakdown[] = Array.from(acc.byCampaign.values())
        .map((camp) => {
          const campKey = camp.campaign ?? CAMPAIGN_NULL_KEY;
          const campSpend = campSpendMap?.get(campKey)?.spend ?? null;
          const campSpendRounded = campSpend === null ? null : round2(campSpend);
          const campRates = computeRates(
            campSpendRounded,
            camp.leadCount,
            camp.wonCount,
            camp.wonRevenue,
          );
          const campSources = Array.from(camp.bySource.values()).sort((a, b) => {
            if (b.leadCount !== a.leadCount) return b.leadCount - a.leadCount;
            return b.wonRevenue - a.wonRevenue;
          });
          return {
            campaign: camp.campaign,
            label: camp.label,
            leadCount: camp.leadCount,
            wonCount: camp.wonCount,
            wonRevenue: round2(camp.wonRevenue),
            spend: campSpendRounded,
            ...campRates,
            bySource: campSources,
          };
        })
        // Hide a noise-only Unattributed bucket (no leads, no wins, no spend).
        .filter(
          (c) =>
            c.leadCount > 0 ||
            c.wonCount > 0 ||
            c.wonRevenue > 0 ||
            (c.spend !== null && c.spend > 0),
        )
        .sort((a, b) => {
          // Real campaigns first, "Unattributed" last.
          const aUn = a.campaign === null ? 1 : 0;
          const bUn = b.campaign === null ? 1 : 0;
          if (aUn !== bUn) return aUn - bUn;
          if (b.wonRevenue !== a.wonRevenue) return b.wonRevenue - a.wonRevenue;
          if (b.leadCount !== a.leadCount) return b.leadCount - a.leadCount;
          return a.label.localeCompare(b.label);
        });

      return {
        platform,
        platformKey: key,
        leadCount: acc.leadCount,
        wonCount: acc.wonCount,
        wonRevenue: round2(acc.wonRevenue),
        spend,
        ...rates,
        bySource,
        byCampaign,
      };
    },
  );

  // Sort platforms: revenue desc, then leadCount desc, then platform name asc.
  platformRows.sort((a, b) => {
    if (b.wonRevenue !== a.wonRevenue) return b.wonRevenue - a.wonRevenue;
    if (b.leadCount !== a.leadCount) return b.leadCount - a.leadCount;
    return a.platform.localeCompare(b.platform);
  });

  const totalLeadCount = platformRows.reduce((s, r) => s + r.leadCount, 0);
  const totalWonCount = platformRows.reduce((s, r) => s + r.wonCount, 0);
  const totalWonRevenue = platformRows.reduce((s, r) => s + r.wonRevenue, 0);
  const totalSpendRaw = platformRows.reduce(
    (s, r) => (r.spend === null ? s : s + r.spend),
    0,
  );
  const totalSpend =
    platformRows.some((r) => r.spend !== null) ? round2(totalSpendRaw) : null;
  const totalRates = computeRates(totalSpend, totalLeadCount, totalWonCount, totalWonRevenue);

  return {
    mode,
    totals: {
      leadCount: totalLeadCount,
      wonCount: totalWonCount,
      wonRevenue: round2(totalWonRevenue),
      spend: totalSpend,
      ...totalRates,
    },
    platforms: platformRows,
    hasAnySpend,
  };
}
