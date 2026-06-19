/**
 * Aggregate query service for contractor dashboard KPIs
 * (Speed-to-Lead, Set Rate, Close Rate, Follow-ups).
 *
 * These queries are cross-domain (leads + estimates + jobs) and are
 * intentionally separate from single-entity storage modules.
 *
 * Task #805: lead-pipeline KPIs are re-based onto the `leads` table (per-lead
 * grain) instead of `contacts` (type=lead), so two submissions from one person
 * count as two leads. Windowed by `leads.created_at`, archived leads excluded.
 * Definitions are shared with the Leads page derivation (see lead-stage.ts):
 *   - Total Leads      = COUNT(leads) in window
 *   - Disqualified     = COUNT(status = 'disqualified')  (not 'lost')
 *   - Set / Scheduled  = COUNT(converted_to_estimate_id IS NOT NULL)
 *   - Set Rate         = set / (total − disqualified)
 *   - Today's Follow-ups = COUNT(follow_up_date within today)
 *   - Speed-to-Lead    = AVG(contacted_at − created_at) where contacted_at set
 * Per-user (non-admin) scoping: set/touched slices filter on
 * `assigned_to_user_id`; contacted/speed slices on `contacted_by_user_id`.
 *
 * SCALE NOTE: At significant load (many concurrent dashboard loads) these
 * aggregate COUNT queries can create meaningful DB pressure. Consider caching
 * results for 60s in Redis or a lightweight in-process LRU cache to reduce
 * the number of full-table scans per minute.
 */

import { leads, estimates, jobs } from "@shared/schema";
import { db } from "../db";
import { eq, and, gte, lte, sql } from "drizzle-orm";

export interface MetricsAggregates {
  totalLeads: number;
  contactedLeads: number;
  avgSpeedToLeadHours: number;
  scheduledLeads: number;
  totalEstimates: number;
  completedJobs: number;
  revenue: number;
}

export async function getDashboardMetrics(
  contractorId: string,
  userId: string,
  userRole: string,
  startDate?: Date,
  endDate?: Date,
): Promise<{
  speedToLeadMinutes: number;
  setRate: number;
  totalLeads: number;
  todaysFollowUps: number;
  disqualifiedCount: number;
}> {
  const isAdmin = userRole === 'admin' || userRole === 'super_admin';

  const baseConditions = [eq(leads.contractorId, contractorId), eq(leads.archived, false)];
  if (startDate) baseConditions.push(gte(leads.createdAt, startDate));
  if (endDate) baseConditions.push(lte(leads.createdAt, endDate));

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const [metricsRow] = await db.select({
    totalLeads: sql<number>`COUNT(*)::int`,
    // "Set" = converted to an estimate. Org-wide and per-user (assigned) slices.
    setAll: sql<number>`COUNT(*) FILTER (WHERE ${leads.convertedToEstimateId} IS NOT NULL)::int`,
    setByUser: sql<number>`COUNT(*) FILTER (WHERE ${leads.convertedToEstimateId} IS NOT NULL AND ${leads.assignedToUserId} = ${userId})::int`,
    // "Touched" (non-admin denominator) = assigned to this user.
    touchedByUser: sql<number>`COUNT(*) FILTER (WHERE ${leads.assignedToUserId} = ${userId})::int`,
    speedToLeadAll: sql<number>`COALESCE(AVG(EXTRACT(EPOCH FROM (${leads.contactedAt} - ${leads.createdAt})) / 60.0) FILTER (WHERE ${leads.contactedAt} IS NOT NULL), 0)::float`,
    speedToLeadUser: sql<number>`COALESCE(AVG(EXTRACT(EPOCH FROM (${leads.contactedAt} - ${leads.createdAt})) / 60.0) FILTER (WHERE ${leads.contactedAt} IS NOT NULL AND ${leads.contactedByUserId} = ${userId}), 0)::float`,
    todaysFollowUps: sql<number>`COUNT(*) FILTER (WHERE ${leads.followUpDate} >= ${today} AND ${leads.followUpDate} < ${tomorrow})::int`,
    disqualifiedAll: sql<number>`COUNT(*) FILTER (WHERE ${leads.status} = 'disqualified')::int`,
    disqualifiedTouchedByUser: sql<number>`COUNT(*) FILTER (WHERE ${leads.status} = 'disqualified' AND ${leads.assignedToUserId} = ${userId})::int`,
  }).from(leads).where(and(...baseConditions));

  const totalLeads = metricsRow?.totalLeads ?? 0;
  const speedToLeadMinutes = isAdmin
    ? (metricsRow?.speedToLeadAll ?? 0)
    : (metricsRow?.speedToLeadUser ?? 0);

  const setCount = isAdmin
    ? (metricsRow?.setAll ?? 0)
    : (metricsRow?.setByUser ?? 0);
  // disqualifiedCount mirrors the scoping of totalLeads (org-wide for both
  // roles, since totalLeads above is COUNT(*) without a user filter), so the
  // "* N disqualified" subtitle on the Total Leads card stays consistent with
  // its headline number.
  const disqualifiedCount = metricsRow?.disqualifiedAll ?? 0;
  const rawDenominator = isAdmin
    ? totalLeads - (metricsRow?.disqualifiedAll ?? 0)
    : (metricsRow?.touchedByUser ?? 0) - (metricsRow?.disqualifiedTouchedByUser ?? 0);
  const denominatorCount = Math.max(rawDenominator, 0);
  const setRate = denominatorCount > 0 ? (setCount / denominatorCount) * 100 : 0;

  return {
    speedToLeadMinutes: Math.round(speedToLeadMinutes * 10) / 10,
    setRate: Math.round(setRate * 10) / 10,
    totalLeads,
    todaysFollowUps: metricsRow?.todaysFollowUps ?? 0,
    disqualifiedCount,
  };
}

export async function getMetricsAggregates(contractorId: string, periodStart: Date): Promise<MetricsAggregates> {
  // Run all three aggregate queries in parallel — they touch independent tables
  // and have no data dependency between them, so parallel execution reduces
  // wall-clock latency from ~3× to ~1× a single query round-trip.
  const [
    [leadRow],
    [estimateRow],
    [jobRow],
  ] = await Promise.all([
    db.select({
      totalLeads: sql<number>`COUNT(*)::int`,
      contactedLeads: sql<number>`COUNT(${leads.contactedAt})::int`,
      avgSpeedToLeadHours: sql<number>`COALESCE(
        AVG(EXTRACT(EPOCH FROM (${leads.contactedAt} - ${leads.createdAt})) / 3600.0)
          FILTER (WHERE ${leads.contactedAt} IS NOT NULL), 0
      )::float`,
      // "Set" leads (converted to an estimate) — feeds the Set Rate consumer.
      scheduledLeads: sql<number>`COUNT(*) FILTER (WHERE ${leads.convertedToEstimateId} IS NOT NULL)::int`,
    })
      .from(leads)
      .where(and(
        eq(leads.contractorId, contractorId),
        eq(leads.archived, false),
        gte(leads.createdAt, periodStart)
      )),
    db.select({
      totalEstimates: sql<number>`COUNT(*)::int`,
    })
      .from(estimates)
      .where(and(
        eq(estimates.contractorId, contractorId),
        gte(estimates.createdAt, periodStart)
      )),
    db.select({
      completedJobs: sql<number>`COUNT(*)::int`,
      revenue: sql<number>`COALESCE(SUM(${jobs.value}::numeric), 0)::float`,
    })
      .from(jobs)
      .where(and(
        eq(jobs.contractorId, contractorId),
        eq(jobs.status, 'completed'),
        gte(jobs.createdAt, periodStart)
      )),
  ]);

  return {
    totalLeads: leadRow?.totalLeads ?? 0,
    contactedLeads: leadRow?.contactedLeads ?? 0,
    avgSpeedToLeadHours: leadRow?.avgSpeedToLeadHours ?? 0,
    scheduledLeads: leadRow?.scheduledLeads ?? 0,
    totalEstimates: estimateRow?.totalEstimates ?? 0,
    completedJobs: jobRow?.completedJobs ?? 0,
    revenue: jobRow?.revenue ?? 0,
  };
}
