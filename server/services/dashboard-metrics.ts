/**
 * Aggregate query service for contractor dashboard KPIs
 * (Speed-to-Lead, Set Rate, Close Rate, Follow-ups).
 *
 * These queries are cross-domain (contacts + estimates + jobs) and are
 * intentionally separate from single-entity storage modules.
 *
 * SCALE NOTE: At significant load (many concurrent dashboard loads) these
 * aggregate COUNT queries can create meaningful DB pressure. Consider caching
 * results for 60s in Redis or a lightweight in-process LRU cache to reduce
 * the number of full-table scans per minute.
 */

import { contacts, estimates, jobs } from "@shared/schema";
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

  const baseConditions = [eq(contacts.contractorId, contractorId), eq(contacts.type, 'lead')];
  if (startDate) baseConditions.push(gte(contacts.createdAt, startDate));
  if (endDate) baseConditions.push(lte(contacts.createdAt, endDate));

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const [metricsRow] = await db.select({
    totalLeads: sql<number>`COUNT(*)::int`,
    scheduledAll: sql<number>`COUNT(*) FILTER (WHERE ${contacts.status} = 'scheduled')::int`,
    scheduledByUser: sql<number>`COUNT(*) FILTER (WHERE ${contacts.status} = 'scheduled' AND ${contacts.scheduledByUserId} = ${userId})::int`,
    touchedByUser: sql<number>`COUNT(*) FILTER (WHERE ${contacts.contactedByUserId} = ${userId} OR ${contacts.scheduledByUserId} = ${userId})::int`,
    speedToLeadAll: sql<number>`COALESCE(AVG(EXTRACT(EPOCH FROM (${contacts.contactedAt} - ${contacts.createdAt})) / 60.0) FILTER (WHERE ${contacts.contactedAt} IS NOT NULL), 0)::float`,
    speedToLeadUser: sql<number>`COALESCE(AVG(EXTRACT(EPOCH FROM (${contacts.contactedAt} - ${contacts.createdAt})) / 60.0) FILTER (WHERE ${contacts.contactedAt} IS NOT NULL AND ${contacts.contactedByUserId} = ${userId}), 0)::float`,
    todaysFollowUps: sql<number>`COUNT(*) FILTER (WHERE ${contacts.followUpDate} >= ${today} AND ${contacts.followUpDate} < ${tomorrow})::int`,
    disqualifiedAll: sql<number>`COUNT(*) FILTER (WHERE ${contacts.status} = 'disqualified')::int`,
    disqualifiedTouchedByUser: sql<number>`COUNT(*) FILTER (WHERE ${contacts.status} = 'disqualified' AND (${contacts.contactedByUserId} = ${userId} OR ${contacts.scheduledByUserId} = ${userId}))::int`,
  }).from(contacts).where(and(...baseConditions));

  const totalLeads = metricsRow?.totalLeads ?? 0;
  const speedToLeadMinutes = isAdmin
    ? (metricsRow?.speedToLeadAll ?? 0)
    : (metricsRow?.speedToLeadUser ?? 0);

  const scheduledCount = isAdmin
    ? (metricsRow?.scheduledAll ?? 0)
    : (metricsRow?.scheduledByUser ?? 0);
  // disqualifiedCount mirrors the scoping of totalLeads (org-wide for both
  // roles, since totalLeads above is COUNT(*) without a user filter), so the
  // "* N disqualified" subtitle on the Total Leads card stays consistent with
  // its headline number.
  const disqualifiedCount = metricsRow?.disqualifiedAll ?? 0;
  const rawDenominator = isAdmin
    ? totalLeads - (metricsRow?.disqualifiedAll ?? 0)
    : (metricsRow?.touchedByUser ?? 0) - (metricsRow?.disqualifiedTouchedByUser ?? 0);
  const denominatorCount = Math.max(rawDenominator, 0);
  const setRate = denominatorCount > 0 ? (scheduledCount / denominatorCount) * 100 : 0;

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
      contactedLeads: sql<number>`COUNT(${contacts.contactedAt})::int`,
      avgSpeedToLeadHours: sql<number>`COALESCE(
        AVG(EXTRACT(EPOCH FROM (${contacts.contactedAt} - ${contacts.createdAt})) / 3600.0)
          FILTER (WHERE ${contacts.contactedAt} IS NOT NULL), 0
      )::float`,
      scheduledLeads: sql<number>`COUNT(*) FILTER (WHERE ${contacts.isScheduled} = true)::int`,
    })
      .from(contacts)
      .where(and(
        eq(contacts.contractorId, contractorId),
        eq(contacts.type, 'lead'),
        gte(contacts.createdAt, periodStart)
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
