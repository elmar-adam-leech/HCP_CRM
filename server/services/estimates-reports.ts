/**
 * Estimates reports backend.
 *
 * One service that exposes a focused set of report builders for the Estimates
 * reports suite. Every report is scoped by tenant and accepts the same
 * filter shape (date range + optional salesperson + optional lead source).
 * Lead source is joined via leads.converted_to_estimate_id; estimates with no
 * originating lead are bucketed as 'Unknown' where relevant.
 *
 * All reports speak in dollars (estimates.amount is numeric($,)) and use
 * estimates.created_at for date filtering unless a specific report needs a
 * different anchor (e.g. time-to-close uses the transition timestamp).
 */

import { db } from "../db";
import { sql, type SQL } from "drizzle-orm";

export interface EstimatesReportFilters {
  startDate: Date;
  endDate: Date;
  salespersonId?: string | null;
  leadSource?: string | null;
  page?: number;
  pageSize?: number;
}

const num = (v: unknown): number => {
  if (v === null || v === undefined) return 0;
  const n = typeof v === "number" ? v : Number(v as string);
  return Number.isFinite(n) ? n : 0;
};

const round2 = (n: number) => Math.round(n * 100) / 100;
const round1 = (n: number) => Math.round(n * 10) / 10;

// Build a SQL fragment that returns the canonical row per logical estimate for a
// given tenant. HCP estimates with multiple Good/Better/Best options produce one
// local row per option in the `estimates` table — those rows share a
// `housecall_pro_estimate_id` and would otherwise be counted/summed multiple
// times by every report. This fragment deduplicates them by picking, for each
// logical estimate (keyed by housecall_pro_estimate_id when present, else id),
// the single best representative row.
//
// Picking rule (mirrors `extractHcpAmount` in hcp-mappers.ts):
//   1. Approved status first — the option the customer picked is the deal.
//   2. Then highest `amount` (NULLS LAST) — prefer the priced option over the
//      $0 placeholder rows that HCP often produces.
//   3. Then most recent `updated_at` for a stable tiebreak.
//
// Native (non-HCP) estimates fall through the COALESCE to their own id and are
// unaffected. Date / salesperson / lead-source filters are intentionally NOT
// applied inside this CTE — DISTINCT ON runs after WHERE, so filtering first
// could change which row wins for an estimate whose options straddle a date
// boundary. Filters are layered on top of the canonical set instead.
function canonicalEstimates(contractorId: string): SQL {
  return sql`(
    SELECT DISTINCT ON (COALESCE(housecall_pro_estimate_id, id::text)) *
    FROM estimates
    WHERE contractor_id = ${contractorId}
    ORDER BY COALESCE(housecall_pro_estimate_id, id::text),
             CASE WHEN status = 'approved' THEN 0 ELSE 1 END,
             amount::numeric DESC NULLS LAST,
             updated_at DESC
  )`;
}

// Build the shared WHERE-fragment used by every estimates report. We keep this
// as a SQL fragment (not Drizzle conditions) because the report queries are
// hand-written joins that don't always go through the estimates table alone.
function buildEstimatesWhere(
  contractorId: string,
  f: EstimatesReportFilters,
  opts: { dateColumn?: string; tableAlias?: string } = {},
): SQL {
  const alias = opts.tableAlias ?? "e";
  const dateCol = opts.dateColumn ?? `${alias}.created_at`;
  const parts: SQL[] = [
    sql`${sql.raw(alias)}.contractor_id = ${contractorId}`,
    sql`${sql.raw(dateCol)} >= ${f.startDate.toISOString()}`,
    sql`${sql.raw(dateCol)} < ${f.endDate.toISOString()}`,
  ];
  if (f.salespersonId) {
    parts.push(sql`${sql.raw(alias)}.salesperson_user_id = ${f.salespersonId}`);
  }
  if (f.leadSource) {
    if (f.leadSource === "__unknown__") {
      parts.push(sql`COALESCE(l.source, c.source) IS NULL`);
    } else {
      parts.push(sql`COALESCE(l.source, c.source) = ${f.leadSource}`);
    }
  }
  return sql.join(parts, sql.raw(" AND "));
}

// Fetch distinct lead sources for the salesperson/lead-source filter dropdown.
// Returns sources as a sorted array; "Unknown" is always added so the user can
// filter to estimates with no originating lead.
export async function getEstimateFilterOptions(contractorId: string): Promise<{
  salespeople: { userId: string; name: string }[];
  leadSources: string[];
}> {
  const sp = await db.execute<{ user_id: string; name: string }>(sql`
    SELECT DISTINCT u.id AS user_id, u.name AS name
    FROM user_contractors uc
    JOIN users u ON u.id = uc.user_id
    WHERE uc.contractor_id = ${contractorId}
      AND uc.is_salesperson = true
    ORDER BY u.name
  `);
  const ls = await db.execute<{ source: string }>(sql`
    SELECT DISTINCT source FROM (
      SELECT source FROM leads
        WHERE contractor_id = ${contractorId}
          AND source IS NOT NULL
          AND source <> ''
      UNION
      SELECT source FROM contacts
        WHERE contractor_id = ${contractorId}
          AND source IS NOT NULL
          AND source <> ''
          AND source <> 'housecall-pro'
    ) s
    ORDER BY source
  `);
  return {
    salespeople: sp.rows.map((r) => ({ userId: r.user_id, name: r.name })),
    leadSources: ls.rows.map((r) => r.source),
  };
}

// ---------------------------------------------------------------------------
// 1. Revenue report
// ---------------------------------------------------------------------------

export interface RevenueReport {
  totalEstimated: number;
  totalWon: number;
  averageEstimateValue: number;
  estimateCount: number;
  byMonth: { month: string; estimated: number; won: number }[];
  bySalesperson: {
    userId: string | null;
    name: string;
    estimated: number;
    won: number;
    count: number;
  }[];
}

export async function getRevenueReport(
  contractorId: string,
  f: EstimatesReportFilters,
): Promise<RevenueReport> {
  const where = buildEstimatesWhere(contractorId, f);
  const result = await db.execute<{
    total_estimated: string | null;
    total_won: string | null;
    estimate_count: string | number;
    by_month: { month: string; estimated: number; won: number }[] | null;
    by_salesperson: {
      user_id: string | null;
      name: string;
      estimated: number;
      won: number;
      count: number;
    }[] | null;
  }>(sql`
    WITH base AS (
      SELECT e.*, COALESCE(l.source, c.source) AS lead_source
      FROM ${canonicalEstimates(contractorId)} e
      LEFT JOIN leads l ON l.converted_to_estimate_id = e.id
      LEFT JOIN contacts c ON c.id = e.contact_id
      WHERE ${where}
    ),
    monthly AS (
      SELECT
        to_char(date_trunc('month', created_at), 'YYYY-MM') AS month,
        SUM(amount::numeric)::float8 AS estimated,
        SUM(amount::numeric) FILTER (WHERE status = 'approved')::float8 AS won
      FROM base
      GROUP BY 1
      ORDER BY 1
    ),
    sp AS (
      SELECT
        b.salesperson_user_id AS user_id,
        COALESCE(u.name, 'Unassigned') AS name,
        SUM(b.amount::numeric)::float8 AS estimated,
        SUM(b.amount::numeric) FILTER (WHERE b.status = 'approved')::float8 AS won,
        COUNT(*)::int AS count
      FROM base b
      LEFT JOIN users u ON u.id = b.salesperson_user_id
      GROUP BY b.salesperson_user_id, u.name
      ORDER BY SUM(b.amount::numeric) DESC NULLS LAST
    )
    SELECT
      COALESCE((SELECT SUM(amount::numeric) FROM base), 0)::float8 AS total_estimated,
      COALESCE((SELECT SUM(amount::numeric) FROM base WHERE status = 'approved'), 0)::float8 AS total_won,
      (SELECT COUNT(*) FROM base)::int AS estimate_count,
      (SELECT json_agg(monthly) FROM monthly) AS by_month,
      (SELECT json_agg(sp) FROM sp) AS by_salesperson
  `);
  const r = result.rows[0];
  const totalEstimated = num(r?.total_estimated);
  const count = num(r?.estimate_count);
  return {
    totalEstimated: round2(totalEstimated),
    totalWon: round2(num(r?.total_won)),
    averageEstimateValue: count > 0 ? round2(totalEstimated / count) : 0,
    estimateCount: count,
    byMonth: (r?.by_month ?? []).map((m) => ({
      month: m.month,
      estimated: round2(num(m.estimated)),
      won: round2(num(m.won)),
    })),
    bySalesperson: (r?.by_salesperson ?? []).map((s) => ({
      userId: s.user_id,
      name: s.name,
      estimated: round2(num(s.estimated)),
      won: round2(num(s.won)),
      count: num(s.count),
    })),
  };
}

// ---------------------------------------------------------------------------
// 2. Lost revenue
// ---------------------------------------------------------------------------

export interface LostRevenueReport {
  totalLost: number;
  lostCount: number;
  bySalesperson: { userId: string | null; name: string; amount: number; count: number }[];
  byMonth: { month: string; amount: number; count: number }[];
  estimates: {
    id: string;
    title: string;
    contactId: string;
    contactName: string;
    amount: number;
    rejectedAt: string;
  }[];
}

export async function getLostRevenueReport(
  contractorId: string,
  f: EstimatesReportFilters,
): Promise<LostRevenueReport> {
  const where = buildEstimatesWhere(contractorId, f);
  const result = await db.execute<{
    total_lost: string | null;
    lost_count: string | number;
    by_salesperson: { user_id: string | null; name: string; amount: number; count: number }[] | null;
    by_month: { month: string; amount: number; count: number }[] | null;
    estimates: {
      id: string;
      title: string;
      contact_id: string;
      contact_name: string;
      amount: number;
      rejected_at: string;
    }[] | null;
  }>(sql`
    WITH base AS (
      SELECT e.*, COALESCE(l.source, c.source) AS lead_source
      FROM ${canonicalEstimates(contractorId)} e
      LEFT JOIN leads l ON l.converted_to_estimate_id = e.id
      LEFT JOIN contacts c ON c.id = e.contact_id
      WHERE ${where} AND e.status = 'rejected'
    ),
    sp AS (
      SELECT
        b.salesperson_user_id AS user_id,
        COALESCE(u.name, 'Unassigned') AS name,
        SUM(b.amount::numeric)::float8 AS amount,
        COUNT(*)::int AS count
      FROM base b
      LEFT JOIN users u ON u.id = b.salesperson_user_id
      GROUP BY b.salesperson_user_id, u.name
      ORDER BY amount DESC NULLS LAST
    ),
    mo AS (
      SELECT
        to_char(date_trunc('month', COALESCE(rejected_at, updated_at)), 'YYYY-MM') AS month,
        SUM(amount::numeric)::float8 AS amount,
        COUNT(*)::int AS count
      FROM base
      GROUP BY 1
      ORDER BY 1
    ),
    list AS (
      SELECT
        b.id, b.title, b.contact_id,
        COALESCE(c.name, 'Unknown') AS contact_name,
        b.amount::numeric::float8 AS amount,
        COALESCE(b.rejected_at, b.updated_at) AS rejected_at
      FROM base b
      LEFT JOIN contacts c ON c.id = b.contact_id
      ORDER BY COALESCE(b.rejected_at, b.updated_at) DESC
      LIMIT 200
    )
    SELECT
      COALESCE((SELECT SUM(amount::numeric) FROM base), 0)::float8 AS total_lost,
      (SELECT COUNT(*) FROM base)::int AS lost_count,
      (SELECT json_agg(sp) FROM sp) AS by_salesperson,
      (SELECT json_agg(mo) FROM mo) AS by_month,
      (SELECT json_agg(list) FROM list) AS estimates
  `);
  const r = result.rows[0];
  return {
    totalLost: round2(num(r?.total_lost)),
    lostCount: num(r?.lost_count),
    bySalesperson: (r?.by_salesperson ?? []).map((s) => ({
      userId: s.user_id,
      name: s.name,
      amount: round2(num(s.amount)),
      count: num(s.count),
    })),
    byMonth: (r?.by_month ?? []).map((m) => ({
      month: m.month,
      amount: round2(num(m.amount)),
      count: num(m.count),
    })),
    estimates: (r?.estimates ?? []).map((e) => ({
      id: e.id,
      title: e.title,
      contactId: e.contact_id,
      contactName: e.contact_name,
      amount: round2(num(e.amount)),
      rejectedAt: e.rejected_at,
    })),
  };
}

// ---------------------------------------------------------------------------
// 3. Pipeline forecast
// ---------------------------------------------------------------------------

export interface PipelineForecastReport {
  pendingValue: number;
  weightedForecast: number;
  pendingCount: number;
  bySalesperson: {
    userId: string | null;
    name: string;
    pendingValue: number;
    pendingCount: number;
    historicalCloseRate: number;
    weighted: number;
  }[];
}

const PENDING_STATUSES = sql`('sent', 'scheduled', 'in_progress')`;

export async function getPipelineForecastReport(
  contractorId: string,
  f: EstimatesReportFilters,
): Promise<PipelineForecastReport> {
  // Pipeline is an "as of now" snapshot of pending estimates. We still honour the
  // date range as the lookback window for computing each salesperson's
  // historical close rate.
  const pendingWhere = (() => {
    const parts: SQL[] = [
      sql.raw(`e.contractor_id = `).append(sql`${contractorId}`),
      sql.raw(`e.status IN `).append(PENDING_STATUSES),
    ];
    if (f.salespersonId) parts.push(sql.raw(`e.salesperson_user_id = `).append(sql`${f.salespersonId}`));
    if (f.leadSource) {
      if (f.leadSource === "__unknown__") parts.push(sql.raw(`COALESCE(l.source, c.source) IS NULL`));
      else parts.push(sql.raw(`COALESCE(l.source, c.source) = `).append(sql`${f.leadSource}`));
    }
    return sql.join(parts, sql.raw(" AND "));
  })();
  const histWhere = buildEstimatesWhere(contractorId, f);
  const result = await db.execute<{
    pending_value: string | null;
    pending_count: string | number;
    rows: {
      user_id: string | null;
      name: string;
      pending_value: number;
      pending_count: number;
      decided: number;
      won: number;
    }[] | null;
  }>(sql`
    WITH pending AS (
      SELECT e.*, COALESCE(l.source, c.source) AS lead_source
      FROM ${canonicalEstimates(contractorId)} e
      LEFT JOIN leads l ON l.converted_to_estimate_id = e.id
      LEFT JOIN contacts c ON c.id = e.contact_id
      WHERE ${pendingWhere}
    ),
    hist AS (
      SELECT e.salesperson_user_id, e.status
      FROM ${canonicalEstimates(contractorId)} e
      LEFT JOIN leads l ON l.converted_to_estimate_id = e.id
      LEFT JOIN contacts c ON c.id = e.contact_id
      WHERE ${histWhere} AND e.status IN ('approved', 'rejected')
    ),
    rates AS (
      SELECT
        salesperson_user_id AS user_id,
        COUNT(*)::int AS decided,
        COUNT(*) FILTER (WHERE status = 'approved')::int AS won
      FROM hist
      GROUP BY salesperson_user_id
    ),
    sp AS (
      SELECT
        p.salesperson_user_id AS user_id,
        COALESCE(u.name, 'Unassigned') AS name,
        SUM(p.amount::numeric)::float8 AS pending_value,
        COUNT(*)::int AS pending_count,
        COALESCE(r.decided, 0)::int AS decided,
        COALESCE(r.won, 0)::int AS won
      FROM pending p
      LEFT JOIN users u ON u.id = p.salesperson_user_id
      LEFT JOIN rates r ON r.user_id = p.salesperson_user_id
      GROUP BY p.salesperson_user_id, u.name, r.decided, r.won
      ORDER BY pending_value DESC NULLS LAST
    )
    SELECT
      COALESCE((SELECT SUM(amount::numeric) FROM pending), 0)::float8 AS pending_value,
      (SELECT COUNT(*) FROM pending)::int AS pending_count,
      (SELECT json_agg(sp) FROM sp) AS rows
  `);
  const r = result.rows[0];
  const rows = (r?.rows ?? []).map((s) => {
    const closeRate = s.decided > 0 ? s.won / s.decided : 0;
    const weighted = num(s.pending_value) * closeRate;
    return {
      userId: s.user_id,
      name: s.name,
      pendingValue: round2(num(s.pending_value)),
      pendingCount: num(s.pending_count),
      historicalCloseRate: round1(closeRate * 100),
      weighted: round2(weighted),
    };
  });
  const weightedForecast = rows.reduce((acc, x) => acc + x.weighted, 0);
  return {
    pendingValue: round2(num(r?.pending_value)),
    weightedForecast: round2(weightedForecast),
    pendingCount: num(r?.pending_count),
    bySalesperson: rows,
  };
}

// ---------------------------------------------------------------------------
// 4. Closing rate by salesperson
// ---------------------------------------------------------------------------

export interface CloseRateRow {
  key: string;
  name: string;
  sent: number;
  won: number;
  lost: number;
  open: number;
  closeRate: number;
  decisionRate: number;
}

export interface CloseRateReport {
  totals: {
    sent: number;
    won: number;
    lost: number;
    open: number;
    closeRate: number;
    decisionRate: number;
  };
  rows: CloseRateRow[];
}

async function getCloseRate(
  contractorId: string,
  f: EstimatesReportFilters,
  groupBy: "salesperson" | "source",
): Promise<CloseRateReport> {
  const where = buildEstimatesWhere(contractorId, f);
  const groupExpr =
    groupBy === "salesperson"
      ? sql`COALESCE(e.salesperson_user_id, '__unassigned__')`
      : sql`COALESCE(l.source, c.source, '__unknown__')`;
  const nameExpr =
    groupBy === "salesperson"
      ? sql`COALESCE(MAX(u.name), 'Unassigned')`
      : sql`COALESCE(MAX(COALESCE(l.source, c.source)), 'Unknown')`;
  const join =
    groupBy === "salesperson"
      ? sql`LEFT JOIN users u ON u.id = e.salesperson_user_id`
      : sql``;
  const result = await db.execute<{
    rows: { key: string; name: string; sent: number; won: number; lost: number; open: number }[] | null;
    totals: { sent: number; won: number; lost: number; open: number } | null;
  }>(sql`
    WITH base AS (
      SELECT e.*, COALESCE(l.source, c.source) AS lead_source
      FROM ${canonicalEstimates(contractorId)} e
      LEFT JOIN leads l ON l.converted_to_estimate_id = e.id
      LEFT JOIN contacts c ON c.id = e.contact_id
      WHERE ${where}
    ),
    grp AS (
      SELECT
        ${groupExpr} AS key,
        ${nameExpr} AS name,
        COUNT(*)::int AS sent,
        COUNT(*) FILTER (WHERE e.status = 'approved')::int AS won,
        COUNT(*) FILTER (WHERE e.status = 'rejected')::int AS lost,
        COUNT(*) FILTER (WHERE e.status IN ('sent', 'scheduled', 'in_progress'))::int AS open
      FROM ${canonicalEstimates(contractorId)} e
      LEFT JOIN leads l ON l.converted_to_estimate_id = e.id
      LEFT JOIN contacts c ON c.id = e.contact_id
      ${join}
      WHERE e.id IN (SELECT id FROM base)
      GROUP BY ${groupExpr}
      ORDER BY sent DESC
    ),
    tot AS (
      SELECT
        (SELECT COUNT(*) FROM base)::int AS sent,
        (SELECT COUNT(*) FROM base WHERE status = 'approved')::int AS won,
        (SELECT COUNT(*) FROM base WHERE status = 'rejected')::int AS lost,
        (SELECT COUNT(*) FROM base WHERE status IN ('sent', 'scheduled', 'in_progress'))::int AS open
    )
    SELECT
      (SELECT json_agg(grp) FROM grp) AS rows,
      (SELECT row_to_json(tot) FROM tot) AS totals
  `);
  const r = result.rows[0];
  const rows: CloseRateRow[] = (r?.rows ?? []).map((g) => {
    const sent = num(g.sent);
    const won = num(g.won);
    const lost = num(g.lost);
    const decided = won + lost;
    return {
      key: g.key,
      name: g.name,
      sent,
      won,
      lost,
      open: num(g.open),
      closeRate: sent > 0 ? round1((won / sent) * 100) : 0,
      decisionRate: decided > 0 ? round1((won / decided) * 100) : 0,
    };
  });
  const totals = r?.totals;
  const tSent = num(totals?.sent);
  const tWon = num(totals?.won);
  const tLost = num(totals?.lost);
  const tDecided = tWon + tLost;
  return {
    rows,
    totals: {
      sent: tSent,
      won: tWon,
      lost: tLost,
      open: num(totals?.open),
      closeRate: tSent > 0 ? round1((tWon / tSent) * 100) : 0,
      decisionRate: tDecided > 0 ? round1((tWon / tDecided) * 100) : 0,
    },
  };
}

export const getCloseRateBySalesperson = (c: string, f: EstimatesReportFilters) =>
  getCloseRate(c, f, "salesperson");
export const getCloseRateBySource = (c: string, f: EstimatesReportFilters) =>
  getCloseRate(c, f, "source");

// ---------------------------------------------------------------------------
// 5. Time-to-close
// ---------------------------------------------------------------------------

export interface TimeToCloseReport {
  averageDays: number | null;
  medianDays: number | null;
  decidedCount: number;
  bySalesperson: {
    userId: string | null;
    name: string;
    averageDays: number | null;
    medianDays: number | null;
    count: number;
  }[];
  histogram: { bucket: string; count: number }[];
}

export async function getTimeToCloseReport(
  contractorId: string,
  f: EstimatesReportFilters,
): Promise<TimeToCloseReport> {
  const where = buildEstimatesWhere(contractorId, f);
  // Days from estimate created_at to status transition. We prefer the explicit
  // approved_at / rejected_at timestamps (stamped on first transition) and fall
  // back to updated_at for legacy rows that were created before the columns
  // existed and were never re-touched after the backfill.
  const result = await db.execute<{
    avg_days: string | null;
    median_days: string | null;
    decided_count: string | number;
    by_sp: {
      user_id: string | null;
      name: string;
      avg_days: number | null;
      median_days: number | null;
      count: number;
    }[] | null;
    histogram: { bucket: string; count: number }[] | null;
  }>(sql`
    WITH base AS (
      SELECT e.*, COALESCE(l.source, c.source) AS lead_source,
        EXTRACT(EPOCH FROM (
          COALESCE(
            CASE WHEN e.status = 'approved' THEN e.approved_at END,
            CASE WHEN e.status = 'rejected' THEN e.rejected_at END,
            e.updated_at
          ) - e.created_at
        )) / 86400.0 AS days_to_close
      FROM ${canonicalEstimates(contractorId)} e
      LEFT JOIN leads l ON l.converted_to_estimate_id = e.id
      LEFT JOIN contacts c ON c.id = e.contact_id
      WHERE ${where} AND e.status IN ('approved', 'rejected')
    ),
    sp AS (
      SELECT
        b.salesperson_user_id AS user_id,
        COALESCE(u.name, 'Unassigned') AS name,
        AVG(b.days_to_close)::float8 AS avg_days,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY b.days_to_close)::float8 AS median_days,
        COUNT(*)::int AS count
      FROM base b
      LEFT JOIN users u ON u.id = b.salesperson_user_id
      GROUP BY b.salesperson_user_id, u.name
      ORDER BY count DESC
    ),
    hist AS (
      SELECT bucket, COUNT(*)::int AS count
      FROM (
        SELECT
          CASE
            WHEN days_to_close < 1 THEN '<1d'
            WHEN days_to_close < 3 THEN '1-3d'
            WHEN days_to_close < 7 THEN '3-7d'
            WHEN days_to_close < 14 THEN '7-14d'
            WHEN days_to_close < 30 THEN '14-30d'
            ELSE '30d+'
          END AS bucket
        FROM base
      ) sub
      GROUP BY bucket
    )
    SELECT
      (SELECT AVG(days_to_close) FROM base)::float8 AS avg_days,
      (SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY days_to_close) FROM base)::float8 AS median_days,
      (SELECT COUNT(*) FROM base)::int AS decided_count,
      (SELECT json_agg(sp) FROM sp) AS by_sp,
      (SELECT json_agg(hist) FROM hist) AS histogram
  `);
  const r = result.rows[0];
  const order = ["<1d", "1-3d", "3-7d", "7-14d", "14-30d", "30d+"];
  const histMap = new Map<string, number>();
  for (const h of r?.histogram ?? []) histMap.set(h.bucket, num(h.count));
  return {
    averageDays: r?.avg_days !== null ? round1(num(r?.avg_days)) : null,
    medianDays: r?.median_days !== null ? round1(num(r?.median_days)) : null,
    decidedCount: num(r?.decided_count),
    bySalesperson: (r?.by_sp ?? []).map((s) => ({
      userId: s.user_id,
      name: s.name,
      averageDays: s.avg_days !== null ? round1(num(s.avg_days)) : null,
      medianDays: s.median_days !== null ? round1(num(s.median_days)) : null,
      count: num(s.count),
    })),
    histogram: order.map((b) => ({ bucket: b, count: histMap.get(b) ?? 0 })),
  };
}

// ---------------------------------------------------------------------------
// 6. Pending / 7. In-progress
// ---------------------------------------------------------------------------

export interface OutstandingEstimateRow {
  id: string;
  title: string;
  contactId: string;
  contactName: string;
  amount: number;
  status: string;
  createdAt: string;
  ageDays: number;
  salespersonName: string | null;
  ageBucket: "0-7" | "8-14" | "15-30" | "30+";
}

export interface OutstandingReport {
  total: number;
  totalValue: number;
  estimates: OutstandingEstimateRow[];
  buckets: { bucket: string; count: number }[];
}

const OUTSTANDING_DEFAULT_PAGE_SIZE = 25;
const OUTSTANDING_MAX_PAGE_SIZE = 100;

async function getOutstanding(
  contractorId: string,
  f: EstimatesReportFilters,
  statuses: string[],
): Promise<OutstandingReport> {
  // Date range filter applies to e.created_at; salesperson + lead-source still
  // apply. Pagination is server-side: stats span the full filtered set, only
  // the row list is sliced.
  const parts: SQL[] = [
    sql.raw(`e.contractor_id = `).append(sql`${contractorId}`),
    sql`e.status IN (${sql.join(statuses.map((s) => sql`${s}`), sql`, `)})`,
    sql`e.created_at >= ${f.startDate.toISOString()}`,
    sql`e.created_at < ${f.endDate.toISOString()}`,
  ];
  if (f.salespersonId) {
    parts.push(sql.raw(`e.salesperson_user_id = `).append(sql`${f.salespersonId}`));
  }
  if (f.leadSource) {
    if (f.leadSource === "__unknown__") parts.push(sql.raw(`COALESCE(l.source, c.source) IS NULL`));
    else parts.push(sql.raw(`COALESCE(l.source, c.source) = `).append(sql`${f.leadSource}`));
  }
  const where = sql.join(parts, sql.raw(" AND "));

  const page = Math.max(0, Math.floor(f.page ?? 0));
  const rawSize = Math.floor(f.pageSize ?? OUTSTANDING_DEFAULT_PAGE_SIZE);
  const pageSize = Math.min(OUTSTANDING_MAX_PAGE_SIZE, Math.max(1, rawSize));
  const offset = page * pageSize;

  // Aggregate query: totals + age bucket counts across the full filtered set.
  const aggResult = await db.execute<{
    total: string | number;
    total_value: string | null;
    bucket_0_7: string | number;
    bucket_8_14: string | number;
    bucket_15_30: string | number;
    bucket_30_plus: string | number;
  }>(sql`
    WITH base AS (
      SELECT
        e.amount::numeric AS amount,
        EXTRACT(EPOCH FROM (NOW() - e.created_at)) / 86400.0 AS age_days
      FROM ${canonicalEstimates(contractorId)} e
      LEFT JOIN leads l ON l.converted_to_estimate_id = e.id
      WHERE ${where}
    )
    SELECT
      COUNT(*)::int AS total,
      COALESCE(SUM(amount), 0)::float8 AS total_value,
      COUNT(*) FILTER (WHERE age_days <= 7)::int AS bucket_0_7,
      COUNT(*) FILTER (WHERE age_days > 7 AND age_days <= 14)::int AS bucket_8_14,
      COUNT(*) FILTER (WHERE age_days > 14 AND age_days <= 30)::int AS bucket_15_30,
      COUNT(*) FILTER (WHERE age_days > 30)::int AS bucket_30_plus
    FROM base
  `);
  const agg = aggResult.rows[0];

  // Row query: only the requested page slice.
  const rowResult = await db.execute<{
    id: string;
    title: string;
    contact_id: string;
    contact_name: string;
    amount: number;
    status: string;
    created_at: string;
    age_days: number;
    salesperson_name: string | null;
  }>(sql`
    SELECT
      e.id, e.title, e.contact_id,
      COALESCE(c.name, 'Unknown') AS contact_name,
      e.amount::numeric::float8 AS amount,
      e.status,
      e.created_at,
      EXTRACT(EPOCH FROM (NOW() - e.created_at)) / 86400.0 AS age_days,
      u.name AS salesperson_name
    FROM ${canonicalEstimates(contractorId)} e
    LEFT JOIN contacts c ON c.id = e.contact_id
    LEFT JOIN users u ON u.id = e.salesperson_user_id
    LEFT JOIN leads l ON l.converted_to_estimate_id = e.id
    WHERE ${where}
    ORDER BY e.created_at ASC
    LIMIT ${pageSize} OFFSET ${offset}
  `);
  const rows: OutstandingEstimateRow[] = rowResult.rows.map((r) => {
    const age = num(r.age_days);
    const bucket: OutstandingEstimateRow["ageBucket"] =
      age <= 7 ? "0-7" : age <= 14 ? "8-14" : age <= 30 ? "15-30" : "30+";
    return {
      id: r.id,
      title: r.title,
      contactId: r.contact_id,
      contactName: r.contact_name,
      amount: round2(num(r.amount)),
      status: r.status,
      createdAt: r.created_at,
      ageDays: Math.floor(age),
      salespersonName: r.salesperson_name,
      ageBucket: bucket,
    };
  });
  const buckets = [
    { bucket: "0-7", count: num(agg?.bucket_0_7) },
    { bucket: "8-14", count: num(agg?.bucket_8_14) },
    { bucket: "15-30", count: num(agg?.bucket_15_30) },
    { bucket: "30+", count: num(agg?.bucket_30_plus) },
  ];
  return {
    total: num(agg?.total),
    totalValue: round2(num(agg?.total_value)),
    estimates: rows,
    buckets,
  };
}

export const getPendingReport = (c: string, f: EstimatesReportFilters) =>
  getOutstanding(c, f, ["sent", "scheduled"]);

export const getInProgressReport = (c: string, f: EstimatesReportFilters) =>
  getOutstanding(c, f, ["in_progress"]);

// ---------------------------------------------------------------------------
// 8. Sales activity
// ---------------------------------------------------------------------------

export interface SalesActivityReport {
  totalCreated: number;
  averagePerWeek: number;
  weeks: string[];
  bySalesperson: {
    userId: string | null;
    name: string;
    weekly: { week: string; count: number }[];
    averagePerWeek: number;
    total: number;
  }[];
}

export async function getSalesActivityReport(
  contractorId: string,
  f: EstimatesReportFilters,
): Promise<SalesActivityReport> {
  const where = buildEstimatesWhere(contractorId, f);
  const result = await db.execute<{
    user_id: string | null;
    name: string;
    week: string;
    count: number;
  }>(sql`
    WITH base AS (
      SELECT e.*, COALESCE(l.source, c.source) AS lead_source
      FROM estimates e
      LEFT JOIN leads l ON l.converted_to_estimate_id = e.id
      LEFT JOIN contacts c ON c.id = e.contact_id
      WHERE ${where}
    )
    SELECT
      b.salesperson_user_id AS user_id,
      COALESCE(u.name, 'Unassigned') AS name,
      to_char(date_trunc('week', b.created_at), 'YYYY-MM-DD') AS week,
      COUNT(*)::int AS count
    FROM base b
    LEFT JOIN users u ON u.id = b.salesperson_user_id
    GROUP BY b.salesperson_user_id, u.name, date_trunc('week', b.created_at)
    ORDER BY week ASC
  `);
  const weeksSet = new Set<string>();
  const bySpMap = new Map<string, { name: string; weekly: Map<string, number>; userId: string | null }>();
  for (const r of result.rows) {
    weeksSet.add(r.week);
    const key = r.user_id ?? "__unassigned__";
    if (!bySpMap.has(key)) {
      bySpMap.set(key, { name: r.name, weekly: new Map(), userId: r.user_id });
    }
    bySpMap.get(key)!.weekly.set(r.week, num(r.count));
  }
  const weeks = Array.from(weeksSet).sort();
  // Compute total weeks in the date range so averagePerWeek divides by the
  // user's selected window and not just weeks they created in.
  const ms = f.endDate.getTime() - f.startDate.getTime();
  const totalWeeks = Math.max(1, Math.round(ms / (7 * 86400000)));
  const bySalesperson = Array.from(bySpMap.values()).map((sp) => {
    const weekly = weeks.map((w) => ({ week: w, count: sp.weekly.get(w) ?? 0 }));
    const total = weekly.reduce((a, x) => a + x.count, 0);
    return {
      userId: sp.userId,
      name: sp.name,
      weekly,
      total,
      averagePerWeek: round1(total / totalWeeks),
    };
  });
  bySalesperson.sort((a, b) => b.total - a.total);
  const totalCreated = bySalesperson.reduce((a, x) => a + x.total, 0);
  return {
    totalCreated,
    averagePerWeek: round1(totalCreated / totalWeeks),
    weeks,
    bySalesperson,
  };
}

// ---------------------------------------------------------------------------
// 9. Repeat customer
// ---------------------------------------------------------------------------

export interface RepeatCustomerReport {
  totalEstimates: number;
  repeatEstimates: number;
  newEstimates: number;
  repeatPercentage: number;
  topRepeaters: {
    contactId: string;
    contactName: string;
    estimateCount: number;
    totalWon: number;
  }[];
}

export async function getRepeatCustomerReport(
  contractorId: string,
  f: EstimatesReportFilters,
): Promise<RepeatCustomerReport> {
  const where = buildEstimatesWhere(contractorId, f);
  const result = await db.execute<{
    total_estimates: string | number;
    repeat_estimates: string | number;
    new_estimates: string | number;
    top: {
      contact_id: string;
      contact_name: string;
      estimate_count: number;
      total_won: number;
    }[] | null;
  }>(sql`
    WITH base AS (
      SELECT e.*, COALESCE(l.source, c.source) AS lead_source
      FROM estimates e
      LEFT JOIN leads l ON l.converted_to_estimate_id = e.id
      LEFT JOIN contacts c ON c.id = e.contact_id
      WHERE ${where}
    ),
    flagged AS (
      SELECT b.*,
        EXISTS(
          SELECT 1 FROM estimates pe
          WHERE pe.contact_id = b.contact_id
            AND pe.contractor_id = b.contractor_id
            AND pe.created_at < b.created_at
        ) AS is_repeat
      FROM base b
    ),
    top AS (
      SELECT
        b.contact_id,
        COALESCE(c.name, 'Unknown') AS contact_name,
        COUNT(*)::int AS estimate_count,
        COALESCE(SUM(b.amount::numeric) FILTER (WHERE b.status = 'approved'), 0)::float8 AS total_won
      FROM base b
      LEFT JOIN contacts c ON c.id = b.contact_id
      GROUP BY b.contact_id, c.name
      HAVING COUNT(*) > 1
      ORDER BY estimate_count DESC, total_won DESC
      LIMIT 25
    )
    SELECT
      (SELECT COUNT(*) FROM flagged)::int AS total_estimates,
      (SELECT COUNT(*) FROM flagged WHERE is_repeat)::int AS repeat_estimates,
      (SELECT COUNT(*) FROM flagged WHERE NOT is_repeat)::int AS new_estimates,
      (SELECT json_agg(top) FROM top) AS top
  `);
  const r = result.rows[0];
  const total = num(r?.total_estimates);
  const repeats = num(r?.repeat_estimates);
  return {
    totalEstimates: total,
    repeatEstimates: repeats,
    newEstimates: num(r?.new_estimates),
    repeatPercentage: total > 0 ? round1((repeats / total) * 100) : 0,
    topRepeaters: (r?.top ?? []).map((t) => ({
      contactId: t.contact_id,
      contactName: t.contact_name,
      estimateCount: num(t.estimate_count),
      totalWon: round2(num(t.total_won)),
    })),
  };
}

// ---------------------------------------------------------------------------
// 10. Geographic
// ---------------------------------------------------------------------------

export interface GeographicReport {
  rows: {
    city: string;
    state: string;
    estimateCount: number;
    wonCount: number;
    wonValue: number;
    closeRate: number;
    lowCloseRate: boolean;
  }[];
}

export async function getGeographicReport(
  contractorId: string,
  f: EstimatesReportFilters,
): Promise<GeographicReport> {
  const where = buildEstimatesWhere(contractorId, f);
  const result = await db.execute<{
    city: string | null;
    state: string | null;
    estimate_count: number;
    won_count: number;
    decided_count: number;
    won_value: number;
  }>(sql`
    WITH base AS (
      SELECT e.*, c.city, c.state, COALESCE(l.source, c.source) AS lead_source
      FROM estimates e
      LEFT JOIN contacts c ON c.id = e.contact_id
      LEFT JOIN leads l ON l.converted_to_estimate_id = e.id
      WHERE ${where}
    )
    SELECT
      COALESCE(NULLIF(TRIM(city), ''), 'Unknown') AS city,
      COALESCE(NULLIF(TRIM(state), ''), '') AS state,
      COUNT(*)::int AS estimate_count,
      COUNT(*) FILTER (WHERE status = 'approved')::int AS won_count,
      COUNT(*) FILTER (WHERE status IN ('approved', 'rejected'))::int AS decided_count,
      COALESCE(SUM(amount::numeric) FILTER (WHERE status = 'approved'), 0)::float8 AS won_value
    FROM base
    GROUP BY 1, 2
    ORDER BY estimate_count DESC
    LIMIT 100
  `);
  const rows = result.rows.map((r) => {
    const decided = num(r.decided_count);
    const closeRate = decided > 0 ? round1((num(r.won_count) / decided) * 100) : 0;
    return {
      city: r.city ?? "Unknown",
      state: r.state ?? "",
      estimateCount: num(r.estimate_count),
      wonCount: num(r.won_count),
      wonValue: round2(num(r.won_value)),
      closeRate,
      // Only flag cities with enough decided volume to make the rate meaningful
      lowCloseRate: decided >= 5 && closeRate < 25,
    };
  });
  return { rows };
}
