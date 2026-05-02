/**
 * Speed-to-Lead by Salesperson aggregation service.
 *
 * For a given tenant and date range (filtered on lead.created_at) this returns
 * one row per salesperson summarising:
 *   - how many leads they were the *first* to call,
 *   - the median / average time-to-first-call,
 *   - the average number of outbound calls per lead,
 *   - the same averaged across leads that ended up scheduled (estimate booked),
 *   - the same restricted to non-self-booked leads,
 *   - and a histogram bucket distribution of the first-call latency.
 *
 * Plus a contractor-wide `totals` row whose per-lead aggregates use the
 * earliest call across *any* salesperson (so multi-salesperson leads are not
 * double-counted at the totals level).
 *
 * The whole report is computed in a single DB round-trip: one SQL statement
 * builds shared CTEs (outbound_calls + per-lead/per-user grouping) then emits
 * two aggregated result groups (per-salesperson rows + a single totals row)
 * via JSON aggregation so they come back together.
 */

import { db } from "../db";
import { sql } from "drizzle-orm";

export interface DistributionBuckets {
  lt5m: number;
  lt15m: number;
  lt1h: number;
  lt4h: number;
  lt24h: number;
  gte24h: number;
}

export interface SalespersonRow {
  userId: string;
  name: string;
  leadsCalled: number;
  medianMinutesToFirstCall: number;
  averageMinutesToFirstCall: number;
  averageCallsPerLead: number;
  averageCallsPerScheduledLead: number | null;
  averageCallsPerScheduledLeadNonSelfBook: number | null;
  scheduledLeadsCalled: number;
  scheduledLeadsCalledNonSelfBook: number;
  distribution: DistributionBuckets;
}

export type SpeedToLeadEmptyReason =
  | "no_calls_ever"
  | "no_calls_in_range"
  | "no_lead_calls_in_range";

export interface SpeedToLeadReport {
  range: { start: string; end: string };
  salespeople: SalespersonRow[];
  totals: Omit<SalespersonRow, "userId" | "name">;
  emptyReason: SpeedToLeadEmptyReason | null;
}

interface RawPerUserRow {
  user_id: string;
  name: string;
  leads_called: string | number;
  median_min: string | number | null;
  avg_min: string | number | null;
  avg_calls: string | number | null;
  avg_calls_scheduled: string | number | null;
  avg_calls_scheduled_non_selfbook: string | number | null;
  scheduled_leads_called: string | number;
  scheduled_leads_called_non_selfbook: string | number;
  lt5m: string | number;
  lt15m: string | number;
  lt1h: string | number;
  lt4h: string | number;
  lt24h: string | number;
  gte24h: string | number;
}

type RawTotalsRow = Omit<RawPerUserRow, "user_id" | "name">;

interface ReportRow {
  [key: string]: unknown;
  per_user: RawPerUserRow[] | null;
  totals: RawTotalsRow | null;
}

const num = (v: string | number | null | undefined): number => {
  if (v === null || v === undefined) return 0;
  return typeof v === "number" ? v : Number(v);
};

const numOrNull = (
  v: string | number | null | undefined,
  denominator: number,
): number | null => {
  if (denominator <= 0 || v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

const round1 = (n: number) => Math.round(n * 10) / 10;
const round1OrNull = (n: number | null) => (n === null ? null : round1(n));

const buildDistribution = (r: RawPerUserRow | RawTotalsRow): DistributionBuckets => ({
  lt5m: num(r.lt5m),
  lt15m: num(r.lt15m),
  lt1h: num(r.lt1h),
  lt4h: num(r.lt4h),
  lt24h: num(r.lt24h),
  gte24h: num(r.gte24h),
});

export async function getSpeedToLeadReport(
  contractorId: string,
  opts: { startDate: Date; endDate: Date },
): Promise<SpeedToLeadReport> {
  const start = opts.startDate;
  const end = opts.endDate;

  // Single round-trip: shared CTEs feed both the per-salesperson aggregates
  // and the contractor-wide totals (which collapse per lead first using
  // MIN(first_call_at) across any salesperson so multi-salesperson leads are
  // not double-counted). The two result sets are returned as JSON columns on
  // a single row.
  const result = await db.execute<ReportRow>(sql`
    WITH outbound_calls AS (
      -- Resolve a "responsible user" for every outbound call activity.
      -- Three sources, in priority order, so legacy Dialpad-webhook rows
      -- (which historically left activities.user_id NULL) still get
      -- attributed:
      --   1. activities.user_id            (set by /api/calls/initiate,
      --                                     /api/calls/log-personal,
      --                                     POST /api/activities, and the
      --                                     Dialpad webhook going forward)
      --   2. metadata.operator_id          → dialpad_users.dialpad_user_id
      --                                     → users.email → user_contractors
      --   3. metadata.operator_email       → users.email → user_contractors
      --   4. metadata.operatorName         → dialpad_users.full_name
      --                                     → users.email → user_contractors
      --                                     (legacy fallback — pre-fix
      --                                     Dialpad-webhook rows only stored
      --                                     the operator's display name)
      -- Email/name comparisons are case-insensitive. Rows that still don't
      -- resolve to a user are dropped at the salesperson_calls filter.
      SELECT
        COALESCE(
          a.user_id,
          (
            SELECT uc.user_id
            FROM dialpad_users du
            JOIN users u
              ON lower(u.email) = lower(du.email)
            JOIN user_contractors uc
              ON uc.user_id = u.id
             AND uc.contractor_id = ${contractorId}
            WHERE du.contractor_id = ${contractorId}
              AND du.dialpad_user_id = (a.metadata::jsonb)->>'operator_id'
            LIMIT 1
          ),
          (
            SELECT uc.user_id
            FROM users u
            JOIN user_contractors uc
              ON uc.user_id = u.id
             AND uc.contractor_id = ${contractorId}
            WHERE lower(u.email) = lower((a.metadata::jsonb)->>'operator_email')
            LIMIT 1
          ),
          (
            SELECT uc.user_id
            FROM dialpad_users du
            JOIN users u
              ON lower(u.email) = lower(du.email)
            JOIN user_contractors uc
              ON uc.user_id = u.id
             AND uc.contractor_id = ${contractorId}
            WHERE du.contractor_id = ${contractorId}
              AND lower(du.full_name) = lower((a.metadata::jsonb)->>'operatorName')
            LIMIT 1
          )
        ) AS user_id,
        a.contact_id,
        a.created_at
      FROM activities a
      WHERE a.contractor_id = ${contractorId}
        AND a.type = 'call'
        AND (a.metadata::jsonb)->>'direction' = 'outbound'
    ),
    salesperson_calls AS (
      SELECT oc.user_id, oc.contact_id, oc.created_at
      FROM outbound_calls oc
      JOIN user_contractors uc
        ON uc.user_id = oc.user_id
       AND uc.contractor_id = ${contractorId}
       AND uc.is_salesperson = true
      WHERE oc.user_id IS NOT NULL
    ),
    lead_user_calls AS (
      SELECT
        l.id AS lead_id,
        l.created_at AS lead_created_at,
        (l.converted_to_estimate_id IS NOT NULL) AS is_scheduled,
        (l.source IS DISTINCT FROM 'public_booking') AS not_self_booked,
        sc.user_id,
        MIN(sc.created_at) FILTER (
          WHERE sc.created_at >= l.created_at
            AND (l.converted_at IS NULL OR sc.created_at <= l.converted_at)
        ) AS first_call_at,
        COUNT(*) FILTER (
          WHERE sc.created_at >= l.created_at
            AND (l.converted_at IS NULL OR sc.created_at <= l.converted_at)
        ) AS calls_made
      FROM leads l
      JOIN salesperson_calls sc ON sc.contact_id = l.contact_id
      WHERE l.contractor_id = ${contractorId}
        AND l.created_at >= ${start.toISOString()}
        AND l.created_at < ${end.toISOString()}
      GROUP BY l.id, l.created_at, l.converted_to_estimate_id, l.source, sc.user_id
      HAVING COUNT(*) FILTER (
        WHERE sc.created_at >= l.created_at
          AND (l.converted_at IS NULL OR sc.created_at <= l.converted_at)
      ) > 0
    ),
    per_lead AS (
      SELECT
        lead_id,
        MAX(lead_created_at) AS lead_created_at,
        bool_or(is_scheduled) AS is_scheduled,
        bool_or(not_self_booked) AS not_self_booked,
        MIN(first_call_at) AS first_call_at,
        SUM(calls_made) AS calls_made
      FROM lead_user_calls
      GROUP BY lead_id
    ),
    per_user AS (
      SELECT
        u.id AS user_id,
        u.name AS name,
        COUNT(DISTINCT luc.lead_id)::int AS leads_called,
        PERCENTILE_CONT(0.5) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM (luc.first_call_at - luc.lead_created_at)) / 60.0
        ) AS median_min,
        AVG(EXTRACT(EPOCH FROM (luc.first_call_at - luc.lead_created_at)) / 60.0) AS avg_min,
        AVG(luc.calls_made) AS avg_calls,
        AVG(luc.calls_made) FILTER (WHERE luc.is_scheduled) AS avg_calls_scheduled,
        AVG(luc.calls_made) FILTER (WHERE luc.is_scheduled AND luc.not_self_booked) AS avg_calls_scheduled_non_selfbook,
        COUNT(*) FILTER (WHERE luc.is_scheduled)::int AS scheduled_leads_called,
        COUNT(*) FILTER (WHERE luc.is_scheduled AND luc.not_self_booked)::int AS scheduled_leads_called_non_selfbook,
        COUNT(*) FILTER (WHERE EXTRACT(EPOCH FROM (luc.first_call_at - luc.lead_created_at)) / 60.0 < 5)::int AS lt5m,
        COUNT(*) FILTER (WHERE EXTRACT(EPOCH FROM (luc.first_call_at - luc.lead_created_at)) / 60.0 >= 5
                           AND EXTRACT(EPOCH FROM (luc.first_call_at - luc.lead_created_at)) / 60.0 < 15)::int AS lt15m,
        COUNT(*) FILTER (WHERE EXTRACT(EPOCH FROM (luc.first_call_at - luc.lead_created_at)) / 60.0 >= 15
                           AND EXTRACT(EPOCH FROM (luc.first_call_at - luc.lead_created_at)) / 60.0 < 60)::int AS lt1h,
        COUNT(*) FILTER (WHERE EXTRACT(EPOCH FROM (luc.first_call_at - luc.lead_created_at)) / 60.0 >= 60
                           AND EXTRACT(EPOCH FROM (luc.first_call_at - luc.lead_created_at)) / 60.0 < 240)::int AS lt4h,
        COUNT(*) FILTER (WHERE EXTRACT(EPOCH FROM (luc.first_call_at - luc.lead_created_at)) / 60.0 >= 240
                           AND EXTRACT(EPOCH FROM (luc.first_call_at - luc.lead_created_at)) / 60.0 < 1440)::int AS lt24h,
        COUNT(*) FILTER (WHERE EXTRACT(EPOCH FROM (luc.first_call_at - luc.lead_created_at)) / 60.0 >= 1440)::int AS gte24h
      FROM lead_user_calls luc
      JOIN users u ON u.id = luc.user_id
      GROUP BY u.id, u.name
    ),
    totals AS (
      SELECT
        COUNT(*)::int AS leads_called,
        PERCENTILE_CONT(0.5) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM (first_call_at - lead_created_at)) / 60.0
        ) AS median_min,
        AVG(EXTRACT(EPOCH FROM (first_call_at - lead_created_at)) / 60.0) AS avg_min,
        AVG(calls_made) AS avg_calls,
        AVG(calls_made) FILTER (WHERE is_scheduled) AS avg_calls_scheduled,
        AVG(calls_made) FILTER (WHERE is_scheduled AND not_self_booked) AS avg_calls_scheduled_non_selfbook,
        COUNT(*) FILTER (WHERE is_scheduled)::int AS scheduled_leads_called,
        COUNT(*) FILTER (WHERE is_scheduled AND not_self_booked)::int AS scheduled_leads_called_non_selfbook,
        COUNT(*) FILTER (WHERE EXTRACT(EPOCH FROM (first_call_at - lead_created_at)) / 60.0 < 5)::int AS lt5m,
        COUNT(*) FILTER (WHERE EXTRACT(EPOCH FROM (first_call_at - lead_created_at)) / 60.0 >= 5
                           AND EXTRACT(EPOCH FROM (first_call_at - lead_created_at)) / 60.0 < 15)::int AS lt15m,
        COUNT(*) FILTER (WHERE EXTRACT(EPOCH FROM (first_call_at - lead_created_at)) / 60.0 >= 15
                           AND EXTRACT(EPOCH FROM (first_call_at - lead_created_at)) / 60.0 < 60)::int AS lt1h,
        COUNT(*) FILTER (WHERE EXTRACT(EPOCH FROM (first_call_at - lead_created_at)) / 60.0 >= 60
                           AND EXTRACT(EPOCH FROM (first_call_at - lead_created_at)) / 60.0 < 240)::int AS lt4h,
        COUNT(*) FILTER (WHERE EXTRACT(EPOCH FROM (first_call_at - lead_created_at)) / 60.0 >= 240
                           AND EXTRACT(EPOCH FROM (first_call_at - lead_created_at)) / 60.0 < 1440)::int AS lt24h,
        COUNT(*) FILTER (WHERE EXTRACT(EPOCH FROM (first_call_at - lead_created_at)) / 60.0 >= 1440)::int AS gte24h
      FROM per_lead
    )
    SELECT
      (SELECT json_agg(per_user ORDER BY leads_called DESC) FROM per_user) AS per_user,
      (SELECT row_to_json(totals) FROM totals) AS totals
  `);

  const row = result.rows[0];
  const perUserRows: RawPerUserRow[] = Array.isArray(row?.per_user) ? row!.per_user : [];
  const totalsRaw: RawTotalsRow | null = row?.totals ?? null;

  const salespeople: SalespersonRow[] = perUserRows.map((r) => {
    const scheduled = num(r.scheduled_leads_called);
    const scheduledNonSelfBook = num(r.scheduled_leads_called_non_selfbook);
    return {
      userId: r.user_id,
      name: r.name,
      leadsCalled: num(r.leads_called),
      medianMinutesToFirstCall: round1(num(r.median_min)),
      averageMinutesToFirstCall: round1(num(r.avg_min)),
      averageCallsPerLead: round1(num(r.avg_calls)),
      averageCallsPerScheduledLead: round1OrNull(numOrNull(r.avg_calls_scheduled, scheduled)),
      averageCallsPerScheduledLeadNonSelfBook: round1OrNull(
        numOrNull(r.avg_calls_scheduled_non_selfbook, scheduledNonSelfBook),
      ),
      scheduledLeadsCalled: scheduled,
      scheduledLeadsCalledNonSelfBook: scheduledNonSelfBook,
      distribution: buildDistribution(r),
    };
  });

  const totalsScheduled = num(totalsRaw?.scheduled_leads_called);
  const totalsScheduledNonSelfBook = num(totalsRaw?.scheduled_leads_called_non_selfbook);
  const totals: SpeedToLeadReport["totals"] = totalsRaw
    ? {
        leadsCalled: num(totalsRaw.leads_called),
        medianMinutesToFirstCall: round1(num(totalsRaw.median_min)),
        averageMinutesToFirstCall: round1(num(totalsRaw.avg_min)),
        averageCallsPerLead: round1(num(totalsRaw.avg_calls)),
        averageCallsPerScheduledLead: round1OrNull(
          numOrNull(totalsRaw.avg_calls_scheduled, totalsScheduled),
        ),
        averageCallsPerScheduledLeadNonSelfBook: round1OrNull(
          numOrNull(totalsRaw.avg_calls_scheduled_non_selfbook, totalsScheduledNonSelfBook),
        ),
        scheduledLeadsCalled: totalsScheduled,
        scheduledLeadsCalledNonSelfBook: totalsScheduledNonSelfBook,
        distribution: buildDistribution(totalsRaw),
      }
    : {
        leadsCalled: 0,
        medianMinutesToFirstCall: 0,
        averageMinutesToFirstCall: 0,
        averageCallsPerLead: 0,
        averageCallsPerScheduledLead: null,
        averageCallsPerScheduledLeadNonSelfBook: null,
        scheduledLeadsCalled: 0,
        scheduledLeadsCalledNonSelfBook: 0,
        distribution: { lt5m: 0, lt15m: 0, lt1h: 0, lt4h: 0, lt24h: 0, gte24h: 0 },
      };

  let emptyReason: SpeedToLeadEmptyReason | null = null;
  if (salespeople.length === 0) {
    // Two cheap scalar queries to classify why the report is empty.
    const everResult = await db.execute<{ exists: boolean }>(sql`
      SELECT EXISTS(
        SELECT 1 FROM activities
        WHERE contractor_id = ${contractorId}
          AND type = 'call'
      ) AS exists
    `);
    const hasEver = everResult.rows[0]?.exists === true;
    if (!hasEver) {
      emptyReason = "no_calls_ever";
    } else {
      const inRangeResult = await db.execute<{ exists: boolean }>(sql`
        SELECT EXISTS(
          SELECT 1 FROM activities
          WHERE contractor_id = ${contractorId}
            AND type = 'call'
            AND created_at >= ${start.toISOString()}
            AND created_at < ${end.toISOString()}
        ) AS exists
      `);
      emptyReason = inRangeResult.rows[0]?.exists === true
        ? "no_lead_calls_in_range"
        : "no_calls_in_range";
    }
  }

  return {
    range: { start: start.toISOString(), end: end.toISOString() },
    salespeople,
    totals,
    emptyReason,
  };
}
