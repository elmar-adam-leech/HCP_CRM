/**
 * Self-Scheduled vs Sales-Scheduled Bookings report (task #694).
 *
 * For a given tenant and date range (filtered on `scheduled_bookings.created_at`)
 * this returns:
 *   - Totals: total bookings, count + percentage of public-link self-bookings vs
 *     salesperson-scheduled bookings.
 *   - A daily time-series with one row per local-date in [start, end] containing
 *     `selfBooked` and `salespersonBooked` counts (zero-filled days included so
 *     the stacked-bar chart has no gaps).
 *   - Per-salesperson breakdown of bookings the salesperson assisted with —
 *     i.e. rows whose `source NOT IN ('public_booking','ai_agent')` grouped
 *     by `assigned_salesperson_id`. Both the public booking widget and the
 *     AI scheduling agent count as customer-self-scheduled.
 *
 * Cancellations are NOT subtracted: every booking row counts once toward the
 * day it was created. This matches how the rest of the leads reports treat
 * activity counts and avoids backfilling state changes through the activity
 * log.
 *
 * The report runs in a single DB round-trip via three CTEs aggregated as
 * JSON columns on a single output row, mirroring the speed-to-lead service.
 */

import { db } from "../db";
import { sql } from "drizzle-orm";

export interface SchedulingSourceTotals {
  total: number;
  selfBooked: number;
  salespersonBooked: number;
  selfBookedPct: number;
  salespersonBookedPct: number;
}

export interface SchedulingSourceDailyPoint {
  /** Local-tz YYYY-MM-DD bucket. */
  date: string;
  selfBooked: number;
  salespersonBooked: number;
}

export interface SchedulingSourceSalespersonRow {
  userId: string | null;
  name: string;
  bookings: number;
}

export interface SchedulingSourceReport {
  range: { start: string; end: string };
  /** IANA timezone used for `daily.date` bucketing. */
  timezone: string;
  totals: SchedulingSourceTotals;
  daily: SchedulingSourceDailyPoint[];
  bySalesperson: SchedulingSourceSalespersonRow[];
}

interface RawTotalsRow {
  total: string | number;
  self_booked: string | number;
  salesperson_booked: string | number;
}

interface RawDailyRow {
  date: string; // YYYY-MM-DD
  self_booked: string | number;
  salesperson_booked: string | number;
}

interface RawSalespersonRow {
  user_id: string | null;
  name: string | null;
  bookings: string | number;
}

interface ReportRow {
  [key: string]: unknown;
  totals: RawTotalsRow | null;
  daily: RawDailyRow[] | null;
  by_salesperson: RawSalespersonRow[] | null;
  timezone: string | null;
}

const num = (v: string | number | null | undefined): number => {
  if (v === null || v === undefined) return 0;
  return typeof v === "number" ? v : Number(v);
};

const pct = (n: number, d: number): number => {
  if (d <= 0) return 0;
  return Math.round((n / d) * 1000) / 10;
};

/**
 * Zero-fill any missing local-date buckets in [start, end] so the stacked-bar
 * chart never has visual gaps. Iterates by adding 1 day at a time; the day
 * count is bounded by the date-range picker (max ~366 days for "this year").
 */
function zeroFillDaily(
  rows: SchedulingSourceDailyPoint[],
  start: Date,
  end: Date,
  timezone: string,
): SchedulingSourceDailyPoint[] {
  const have = new Map(rows.map((r) => [r.date, r] as const));
  const out: SchedulingSourceDailyPoint[] = [];
  // Build a list of YYYY-MM-DD strings in `timezone` for every day in [start, end).
  // We use Intl.DateTimeFormat for tz-aware date extraction; then advance one
  // calendar day at a time by adding 24h to the cursor (safe enough for the
  // bounded range; a true DST-correct iterator is unnecessary because each
  // bucket is identified by its tz-localized date string).
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const startStr = fmt.format(start);
  const endStr = fmt.format(new Date(end.getTime() - 1));
  const seen = new Set<string>();
  let cursor = new Date(start.getTime());
  // Hard upper bound to avoid infinite loops if the range is malformed.
  for (let i = 0; i < 400; i++) {
    const d = fmt.format(cursor);
    if (!seen.has(d)) {
      seen.add(d);
      out.push(have.get(d) ?? { date: d, selfBooked: 0, salespersonBooked: 0 });
    }
    if (d >= endStr) break;
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
  }
  // Make sure startStr is included (it always should be, but be defensive).
  if (!seen.has(startStr)) {
    out.unshift(have.get(startStr) ?? { date: startStr, selfBooked: 0, salespersonBooked: 0 });
  }
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return out;
}

export async function getLeadsSchedulingSourceReport(
  contractorId: string,
  opts: { startDate: Date; endDate: Date },
): Promise<SchedulingSourceReport> {
  const start = opts.startDate;
  const end = opts.endDate;

  // Single round-trip. The contractor's timezone (defaulted to America/New_York
  // when null) is also returned so the response can label its own bucketing
  // and the frontend can render dates consistently.
  const result = await db.execute<ReportRow>(sql`
    WITH ctr AS (
      SELECT COALESCE(timezone, 'America/New_York') AS tz
      FROM contractors
      WHERE id = ${contractorId}
    ),
    base AS (
      SELECT
        sb.id,
        sb.assigned_salesperson_id,
        sb.source,
        (sb.source IN ('public_booking', 'ai_agent')) AS is_self_booked,
        (sb.created_at AT TIME ZONE (SELECT tz FROM ctr))::date AS local_date
      FROM scheduled_bookings sb
      WHERE sb.contractor_id = ${contractorId}
        AND sb.created_at >= ${start.toISOString()}
        AND sb.created_at < ${end.toISOString()}
    ),
    totals AS (
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE is_self_booked)::int AS self_booked,
        COUNT(*) FILTER (WHERE NOT is_self_booked)::int AS salesperson_booked
      FROM base
    ),
    daily AS (
      SELECT
        to_char(local_date, 'YYYY-MM-DD') AS date,
        COUNT(*) FILTER (WHERE is_self_booked)::int AS self_booked,
        COUNT(*) FILTER (WHERE NOT is_self_booked)::int AS salesperson_booked
      FROM base
      GROUP BY local_date
      ORDER BY local_date
    ),
    by_sp AS (
      SELECT
        b.assigned_salesperson_id AS user_id,
        COALESCE(u.name, 'Unassigned') AS name,
        COUNT(*)::int AS bookings
      FROM base b
      LEFT JOIN users u ON u.id = b.assigned_salesperson_id
      WHERE NOT b.is_self_booked
      GROUP BY b.assigned_salesperson_id, u.name
      ORDER BY bookings DESC, name ASC
    )
    SELECT
      (SELECT row_to_json(totals) FROM totals) AS totals,
      (SELECT json_agg(daily) FROM daily) AS daily,
      (SELECT json_agg(by_sp) FROM by_sp) AS by_salesperson,
      (SELECT tz FROM ctr) AS timezone
  `);

  const row = result.rows[0];
  const totalsRaw = row?.totals ?? null;
  const total = num(totalsRaw?.total);
  const selfBooked = num(totalsRaw?.self_booked);
  const salespersonBooked = num(totalsRaw?.salesperson_booked);

  const totals: SchedulingSourceTotals = {
    total,
    selfBooked,
    salespersonBooked,
    selfBookedPct: pct(selfBooked, total),
    salespersonBookedPct: pct(salespersonBooked, total),
  };

  const tz = row?.timezone ?? "America/New_York";

  const dailyRaw: RawDailyRow[] = Array.isArray(row?.daily) ? row!.daily : [];
  const daily = zeroFillDaily(
    dailyRaw.map((r) => ({
      date: r.date,
      selfBooked: num(r.self_booked),
      salespersonBooked: num(r.salesperson_booked),
    })),
    start,
    end,
    tz,
  );

  const bySalespersonRaw: RawSalespersonRow[] = Array.isArray(row?.by_salesperson)
    ? row!.by_salesperson
    : [];
  const bySalesperson: SchedulingSourceSalespersonRow[] = bySalespersonRaw.map((r) => ({
    userId: r.user_id ?? null,
    name: r.name ?? "Unassigned",
    bookings: num(r.bookings),
  }));

  return {
    range: { start: start.toISOString(), end: end.toISOString() },
    timezone: tz,
    totals,
    daily,
    bySalesperson,
  };
}
