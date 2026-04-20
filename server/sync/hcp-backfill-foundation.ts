/**
 * server/sync/hcp-backfill-foundation.ts
 *
 * Idempotent backfill for Task #435 (HCP foundation data). Three passes:
 *
 *   1. employees.user_contractor_id
 *      Match each HCP-sourced employee row to a user_contractors row in the
 *      same tenant by lower(email). Only links rows where the email is
 *      unambiguous (exactly one matching user). Safe to re-run.
 *
 *   2. estimates.salesperson_user_id / jobs.salesperson_user_id
 *      For each row that has a scheduledEmployeeId/externalId-derived HCP
 *      employee but no salespersonUserId yet, follow the link populated in
 *      pass 1 and write users.id.
 *
 *   3. estimates.hcp_options[].approval_status_changed_at
 *      Stamps any non-pending option that is missing the timestamp with the
 *      estimate's syncedAt (best-effort) so historical data has a sortable
 *      "decided at" anchor for analytics. New webhook/sync writes overwrite
 *      this on the next status flip.
 *
 * Run on demand from a one-shot script or behind a feature flag — this is
 * intentionally a heavy backfill, not part of the per-sync hot path.
 */

import { db } from '../db';
import {
  contractors,
  employees,
  estimates,
  jobs,
  userContractors,
  users,
  type HcpOptionEntry,
} from '@shared/schema';
import { and, eq, isNull, isNotNull, sql } from 'drizzle-orm';
import { logger } from '../utils/logger';
import { housecallProService } from '../hcp/index';
import { resolveSalespersonForHcpEntity } from './hcp-mappers';

const log = logger('HcpBackfillFoundation');

export interface BackfillFoundationResult {
  employeesLinked: number;
  estimatesUpdated: number;
  jobsUpdated: number;
  optionsStamped: number;
}

/**
 * Links employees rows to user_contractors rows by email match within the
 * same tenant. Only links when there is exactly one match — ambiguous
 * matches are skipped to avoid wrong attributions.
 */
export async function backfillEmployeeUserLinks(tenantId: string): Promise<number> {
  const rows = await db
    .select({
      id: employees.id,
      email: employees.email,
    })
    .from(employees)
    .where(and(
      eq(employees.contractorId, tenantId),
      // Only HCP-sourced employee rows are in scope for this attribution
      // backfill — linking other source systems' employees to user_contractors
      // would contaminate salesperson reporting outside HCP's data.
      eq(employees.externalSource, 'housecall-pro'),
      isNull(employees.userContractorId),
      isNotNull(employees.email),
    ));

  // Pass A: bucket employees by lower(email) so we can detect HCP-side
  // duplicates (multiple HCP employees sharing a single email). Linking any
  // of them by email would attribute estimates/jobs to the wrong CRM user,
  // so per the task spec we skip the entire bucket and warn.
  const byEmail = new Map<string, string[]>();
  for (const row of rows) {
    const email = (row.email ?? '').trim().toLowerCase();
    if (!email) continue;
    const existing = byEmail.get(email) ?? [];
    existing.push(row.id);
    byEmail.set(email, existing);
  }

  let linked = 0;
  let skippedDuplicateEmployees = 0;
  let skippedAmbiguousUsers = 0;
  for (const [email, employeeIds] of Array.from(byEmail.entries())) {
    if (employeeIds.length > 1) {
      log.warn(`[backfill-foundation] tenant ${tenantId}: skipping ${employeeIds.length} HCP employees sharing email ${email} — would attribute work to the wrong CRM user`);
      skippedDuplicateEmployees += employeeIds.length;
      continue;
    }
    const matches = await db
      .select({ ucId: userContractors.id })
      .from(userContractors)
      .innerJoin(users, eq(userContractors.userId, users.id))
      .where(and(
        eq(userContractors.contractorId, tenantId),
        sql`lower(${users.email}) = ${email}`,
      ));

    if (matches.length === 0) continue;
    if (matches.length > 1) {
      log.warn(`[backfill-foundation] tenant ${tenantId}: skipping HCP employee with email ${email} — ${matches.length} CRM users match (ambiguous)`);
      skippedAmbiguousUsers++;
      continue;
    }
    const ucId = matches[0].ucId;
    await db
      .update(employees)
      .set({ userContractorId: ucId, updatedAt: new Date() })
      .where(and(eq(employees.id, employeeIds[0]), eq(employees.contractorId, tenantId)));
    linked++;
  }

  log.info(`[backfill-foundation] tenant ${tenantId}: linked ${linked}/${rows.length} employees to user_contractors (skipped ${skippedDuplicateEmployees} duplicate-email employees, ${skippedAmbiguousUsers} ambiguous CRM-user matches)`);
  return linked;
}

/**
 * Walks estimates with a scheduledEmployeeId but no salespersonUserId and
 * fills the latter via employees → user_contractors → users.
 */
export async function backfillEstimateSalespeople(tenantId: string): Promise<number> {
  const rows = await db
    .select({
      id: estimates.id,
      scheduledEmployeeId: estimates.scheduledEmployeeId,
    })
    .from(estimates)
    .where(and(
      eq(estimates.contractorId, tenantId),
      isNotNull(estimates.scheduledEmployeeId),
      isNull(estimates.salespersonUserId),
    ));

  let updated = 0;
  for (const row of rows) {
    const empId = row.scheduledEmployeeId;
    if (!empId) continue;
    const linked = await db
      .select({ userId: userContractors.userId })
      .from(employees)
      .innerJoin(userContractors, eq(employees.userContractorId, userContractors.id))
      .where(and(
        eq(employees.contractorId, tenantId),
        eq(employees.externalSource, 'housecall-pro'),
        eq(employees.externalId, empId),
      ))
      .limit(1);
    const userId = linked[0]?.userId;
    if (!userId) continue;
    await db
      .update(estimates)
      .set({ salespersonUserId: userId })
      .where(and(eq(estimates.id, row.id), eq(estimates.contractorId, tenantId)));
    updated++;
  }
  log.info(`[backfill-foundation] tenant ${tenantId}: stamped salespersonUserId on ${updated}/${rows.length} estimates`);
  return updated;
}

/**
 * Backfills jobs.salesperson_user_id using the same employee→user attribution
 * path as estimates. Jobs do not persist the HCP employee column locally, so
 * for each candidate job we fetch the live HCP job and route its
 * `assigned_employees[0]` (with legacy fallbacks) through
 * resolveSalespersonForHcpEntity. As a final fallback, when HCP fetch fails
 * or returns no employee, we propagate from a linked estimate's
 * salespersonUserId so jobs without HCP attribution still get filled.
 */
export async function backfillJobSalespeople(tenantId: string): Promise<number> {
  const rows = await db
    .select({
      id: jobs.id,
      externalId: jobs.externalId,
    })
    .from(jobs)
    .where(and(
      eq(jobs.contractorId, tenantId),
      isNotNull(jobs.externalId),
      isNull(jobs.salespersonUserId),
    ));

  let updated = 0;
  let viaHcp = 0;
  let viaEstimate = 0;
  for (const row of rows) {
    let userId: string | null = null;

    // Primary: resolve via HCP employee attribution.
    if (row.externalId) {
      try {
        const resp = await housecallProService.getJob(row.externalId, tenantId);
        if (resp.success && resp.data) {
          userId = await resolveSalespersonForHcpEntity(tenantId, resp.data);
          if (userId) viaHcp++;
        }
      } catch (err) {
        log.warn(`[backfill-foundation] tenant ${tenantId}: getJob(${row.externalId}) failed`, err as Error);
      }
    }

    // Fallback: propagate from linked estimate when HCP didn't yield one.
    if (!userId) {
      const linked = await db
        .select({ userId: estimates.salespersonUserId })
        .from(jobs)
        .innerJoin(estimates, eq(jobs.estimateId, estimates.id))
        .where(and(eq(jobs.id, row.id), eq(jobs.contractorId, tenantId)))
        .limit(1);
      userId = linked[0]?.userId ?? null;
      if (userId) viaEstimate++;
    }

    if (!userId) continue;
    await db
      .update(jobs)
      .set({ salespersonUserId: userId })
      .where(and(eq(jobs.id, row.id), eq(jobs.contractorId, tenantId)));
    updated++;
  }
  log.info(`[backfill-foundation] tenant ${tenantId}: stamped salespersonUserId on ${updated}/${rows.length} jobs (${viaHcp} via HCP attribution, ${viaEstimate} propagated from linked estimate)`);
  return updated;
}

/**
 * Stamps approval_status_changed_at for any non-pending options that are
 * missing a timestamp, using the estimate's syncedAt (else updatedAt) as the
 * best-available anchor for historical data.
 */
export async function backfillOptionApprovalTimestamps(tenantId: string): Promise<number> {
  const rows = await db
    .select({
      id: estimates.id,
      hcpOptions: estimates.hcpOptions,
      syncedAt: estimates.syncedAt,
      updatedAt: estimates.updatedAt,
    })
    .from(estimates)
    .where(and(
      eq(estimates.contractorId, tenantId),
      isNotNull(estimates.hcpOptions),
    ));

  let stamped = 0;
  for (const row of rows) {
    const opts = row.hcpOptions as HcpOptionEntry[] | null;
    if (!Array.isArray(opts) || opts.length === 0) continue;
    const anchor = (row.syncedAt ?? row.updatedAt ?? new Date()).toISOString();
    let dirty = false;
    const next = opts.map(o => {
      const status = o.approval_status;
      if (status && status !== 'pending' && !o.approval_status_changed_at) {
        dirty = true;
        return { ...o, approval_status_changed_at: anchor };
      }
      return o;
    });
    if (!dirty) continue;
    await db
      .update(estimates)
      .set({ hcpOptions: next })
      .where(and(eq(estimates.id, row.id), eq(estimates.contractorId, tenantId)));
    stamped++;
  }
  log.info(`[backfill-foundation] tenant ${tenantId}: stamped approval_status_changed_at on ${stamped} estimates`);
  return stamped;
}

/**
 * Runs all four backfill passes for a single tenant. Idempotent: re-running
 * makes no further changes once everything that can be linked has been linked.
 */
export async function backfillHcpFoundationForTenant(tenantId: string): Promise<BackfillFoundationResult> {
  const employeesLinked = await backfillEmployeeUserLinks(tenantId);
  const estimatesUpdated = await backfillEstimateSalespeople(tenantId);
  const jobsUpdated = await backfillJobSalespeople(tenantId);
  const optionsStamped = await backfillOptionApprovalTimestamps(tenantId);
  return { employeesLinked, estimatesUpdated, jobsUpdated, optionsStamped };
}

/**
 * Orchestration entry point. When tenantId is supplied, runs the four
 * backfill passes for just that tenant. When omitted, walks every contractor
 * row and runs them in series so a single failure in one tenant cannot abort
 * the rest. Returns a per-tenant breakdown plus an aggregate row.
 */
export async function runFoundationBackfill(tenantId?: string): Promise<{
  perTenant: Array<{ tenantId: string; result?: BackfillFoundationResult; error?: string }>;
  totals: BackfillFoundationResult;
}> {
  const tenants: string[] = [];
  if (tenantId) {
    tenants.push(tenantId);
  } else {
    const rows = await db.select({ id: contractors.id }).from(contractors);
    for (const r of rows) tenants.push(r.id);
  }

  const perTenant: Array<{ tenantId: string; result?: BackfillFoundationResult; error?: string }> = [];
  const totals: BackfillFoundationResult = {
    employeesLinked: 0,
    estimatesUpdated: 0,
    jobsUpdated: 0,
    optionsStamped: 0,
  };

  for (const t of tenants) {
    try {
      const result = await backfillHcpFoundationForTenant(t);
      perTenant.push({ tenantId: t, result });
      totals.employeesLinked += result.employeesLinked;
      totals.estimatesUpdated += result.estimatesUpdated;
      totals.jobsUpdated += result.jobsUpdated;
      totals.optionsStamped += result.optionsStamped;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`[backfill-foundation] tenant ${t}: failed — ${message}`);
      perTenant.push({ tenantId: t, error: message });
    }
  }

  log.info(`[backfill-foundation] aggregate across ${tenants.length} tenant(s): linked ${totals.employeesLinked} employees, ${totals.estimatesUpdated} estimates, ${totals.jobsUpdated} jobs, stamped ${totals.optionsStamped} estimate option sets`);
  return { perTenant, totals };
}
