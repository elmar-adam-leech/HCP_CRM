/**
 * ROI by Source report (task #696).
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
 * page agree on the bucket list. Each platform also exposes a `bySource`
 * drill-down with the same per-row metrics for the raw sources that rolled
 * into it.
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

/** Fetch leads grouped by raw source for the given window. */
async function fetchLeadsBySource(
  contractorId: string,
  startDate: Date,
  endDate: Date,
): Promise<{ source: string | null; count: number }[]> {
  const result = await db.execute<{ source: string | null; count: string | number }>(sql`
    SELECT LOWER(source) AS source, COUNT(*)::int AS count
    FROM leads
    WHERE contractor_id = ${contractorId}
      AND created_at >= ${startDate.toISOString()}
      AND created_at < ${endDate.toISOString()}
    GROUP BY LOWER(source)
  `);
  return result.rows.map((r) => ({
    source: r.source ?? null,
    count: num(r.count),
  }));
}

/** Won estimates grouped by source. Uses the canonical-estimate dedup CTE so
 *  HCP option rows don't double-count. Source = COALESCE(lead.source, contact.source). */
async function fetchWonEstimatesBySource(
  contractorId: string,
  startDate: Date,
  endDate: Date,
): Promise<{ source: string | null; count: number; revenue: number }[]> {
  const result = await db.execute<{
    source: string | null;
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
    -- Resolve one source per canonical estimate (lead → contact fallback). The
    -- subquery + LIMIT 1 prevents multiple leads pointing at the same estimate
    -- from multiplying the COUNT/SUM in the aggregate below.
    estimate_source AS (
      SELECT
        e.id,
        e.amount,
        LOWER(COALESCE(
          (SELECT l.source FROM leads l
            WHERE l.converted_to_estimate_id = e.id
              AND l.source IS NOT NULL
            LIMIT 1),
          (SELECT c.source FROM contacts c
            WHERE c.id = e.contact_id LIMIT 1)
        )) AS source
      FROM canonical e
      WHERE e.status = 'approved'
        AND e.created_at >= ${startDate.toISOString()}
        AND e.created_at < ${endDate.toISOString()}
    )
    SELECT
      source,
      COUNT(*)::int AS count,
      SUM(amount::numeric)::float8 AS revenue
    FROM estimate_source
    GROUP BY source
  `);
  return result.rows.map((r) => ({
    source: r.source ?? null,
    count: num(r.count),
    revenue: round2(num(r.revenue)),
  }));
}

/** Won (completed) jobs grouped by source. Source resolved by:
 *  1. lead.converted_to_job_id → job, 2. lead.converted_to_estimate_id → job.estimate_id, 3. contact.source. */
async function fetchWonJobsBySource(
  contractorId: string,
  startDate: Date,
  endDate: Date,
): Promise<{ source: string | null; count: number; revenue: number }[]> {
  const result = await db.execute<{
    source: string | null;
    count: string | number;
    revenue: string | null;
  }>(sql`
    WITH job_source AS (
      SELECT
        j.id,
        j.value,
        LOWER(COALESCE(
          (SELECT source FROM leads l
            WHERE l.converted_to_job_id = j.id LIMIT 1),
          (SELECT source FROM leads l
            WHERE l.converted_to_estimate_id = j.estimate_id LIMIT 1),
          (SELECT source FROM contacts c
            WHERE c.id = j.contact_id LIMIT 1)
        )) AS source
      FROM jobs j
      WHERE j.contractor_id = ${contractorId}
        AND j.status = 'completed'
        AND j.created_at >= ${startDate.toISOString()}
        AND j.created_at < ${endDate.toISOString()}
    )
    SELECT
      source,
      COUNT(*)::int AS count,
      SUM(value::numeric)::float8 AS revenue
    FROM job_source
    GROUP BY source
  `);
  return result.rows.map((r) => ({
    source: r.source ?? null,
    count: num(r.count),
    revenue: round2(num(r.revenue)),
  }));
}

/** Manual ad spend whose month overlaps [startDate, endDate). */
async function fetchSpendByPlatform(
  contractorId: string,
  startDate: Date,
  endDate: Date,
): Promise<{ platformKey: string; spend: number }[]> {
  const result = await db.execute<{ platform: string; spend: string | null }>(sql`
    SELECT
      LOWER(platform) AS platform,
      SUM(amount::numeric)::float8 AS spend
    FROM media_spend
    WHERE contractor_id = ${contractorId}
      AND month < date_trunc('month', ${endDate.toISOString()}::timestamptz) + interval '1 month'
      AND (month + interval '1 month') > date_trunc('month', ${startDate.toISOString()}::timestamptz)
    GROUP BY LOWER(platform)
  `);
  return result.rows.map((r) => ({
    platformKey: r.platform,
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

interface PlatformAccumulator {
  leadCount: number;
  wonCount: number;
  wonRevenue: number;
  bySource: Map<string, RoiSourceBreakdown>;
}

function ensurePlatform(
  acc: Map<LeadPlatform, PlatformAccumulator>,
  platform: LeadPlatform,
): PlatformAccumulator {
  let entry = acc.get(platform);
  if (!entry) {
    entry = { leadCount: 0, wonCount: 0, wonRevenue: 0, bySource: new Map() };
    acc.set(platform, entry);
  }
  return entry;
}

function ensureSource(
  acc: PlatformAccumulator,
  source: string | null,
): RoiSourceBreakdown {
  const key = source ?? "__unknown__";
  let entry = acc.bySource.get(key);
  if (!entry) {
    entry = {
      source,
      label: sourceLabel(source),
      leadCount: 0,
      wonCount: 0,
      wonRevenue: 0,
    };
    acc.bySource.set(key, entry);
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
    const sourceEntry = ensureSource(acc, row.source);
    sourceEntry.leadCount += row.count;
  }

  for (const row of wonBySource) {
    const platform = getLeadPlatform(row.source);
    const acc = ensurePlatform(platforms, platform);
    acc.wonCount += row.count;
    acc.wonRevenue += row.revenue;
    const sourceEntry = ensureSource(acc, row.source);
    sourceEntry.wonCount += row.count;
    sourceEntry.wonRevenue += row.revenue;
  }

  // Spend lookup keyed by platformKey (lowercase). Ensure every platform with
  // spend appears even if it had zero leads/wins (so wasted spend is visible).
  const spendByKey = new Map<string, number>();
  for (const row of spendByPlatform) {
    spendByKey.set(row.platformKey, row.spend);
    // Map back to a known LeadPlatform — unknown keys fall through to "Other".
    const platform =
      LEAD_PLATFORMS.find((p) => platformKey(p) === row.platformKey) ?? "Other";
    ensurePlatform(platforms, platform);
  }

  const platformRows: RoiPlatformRow[] = Array.from(platforms.entries()).map(
    ([platform, acc]) => {
      const key = platformKey(platform);
      const spend = spendByKey.has(key) ? spendByKey.get(key)! : null;
      const rates = computeRates(spend, acc.leadCount, acc.wonCount, acc.wonRevenue);
      const bySource = Array.from(acc.bySource.values()).sort((a, b) => {
        if (b.leadCount !== a.leadCount) return b.leadCount - a.leadCount;
        return b.wonRevenue - a.wonRevenue;
      });
      return {
        platform,
        platformKey: key,
        leadCount: acc.leadCount,
        wonCount: acc.wonCount,
        wonRevenue: round2(acc.wonRevenue),
        spend: spend === null ? null : round2(spend),
        ...rates,
        bySource,
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
