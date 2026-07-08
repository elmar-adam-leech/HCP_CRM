import {
  type Estimate, type InsertEstimate,
  type PaginatedEstimates,
  estimates, contacts, activities, jobs,
  estimateStatusEnum,
} from "@shared/schema";
import { db } from "../db";
import { eq, and, or, desc, gt, gte, lte, ilike, sql, count } from "drizzle-orm";
import type { UpdateEstimate } from "../storage-types";
import { maybeDeleteOrphanContactTx } from "./contacts";
import { invalidateReportsCache } from "../services/report-cache";

// Build the SQL filter for a given UI status tab. Sent uses the document-sent
// predicate (independent of visit/work status), while scheduled/in_progress
// additionally require documentSentAt IS NULL so estimates that have been sent
// don't double-count in the visit-status tabs. Approved/rejected unchanged.
export function statusTabFilter(status: string) {
  if (status === 'sent') {
    // An estimate counts as "sent" when either the document-sent timestamp is
    // set (HCP webhook/sync) OR its status was set to 'sent' (manual change
    // where documentSentAt may still be NULL — task #898).
    return and(
      sql`(${estimates.documentSentAt} IS NOT NULL OR ${estimates.status} = 'sent')`,
      sql`${estimates.status} NOT IN ('approved', 'rejected')`,
    )!;
  }
  if (status === 'scheduled' || status === 'in_progress') {
    return and(
      eq(estimates.status, status as typeof estimateStatusEnum.enumValues[number]),
      sql`${estimates.documentSentAt} IS NULL`,
    )!;
  }
  return eq(estimates.status, status as typeof estimateStatusEnum.enumValues[number]);
}

type EstimateStatusCounts = {
  all: number;
  sent: number;
  scheduled: number;
  in_progress: number;
  approved: number;
  rejected: number;
};

async function getEstimates(contractorId: string): Promise<Estimate[]> {
  return await db.select({
    id: estimates.id,
    title: estimates.title,
    description: estimates.description,
    amount: estimates.amount,
    status: estimates.status,
    validUntil: estimates.validUntil,
    followUpDate: estimates.followUpDate,
    contactId: estimates.contactId,
    contractorId: estimates.contractorId,
    scheduledStart: estimates.scheduledStart,
    scheduledEnd: estimates.scheduledEnd,
    scheduledEmployeeId: estimates.scheduledEmployeeId,
    housecallProCustomerId: estimates.housecallProCustomerId,
    housecallProEstimateId: estimates.housecallProEstimateId,
    externalId: estimates.externalId,
    externalSource: estimates.externalSource,
    syncedAt: estimates.syncedAt,
    documentSentAt: estimates.documentSentAt,
    createdAt: estimates.createdAt,
    updatedAt: estimates.updatedAt,
    contact: {
      id: contacts.id,
      name: contacts.name,
      emails: contacts.emails,
      phones: contacts.phones,
      address: contacts.address,
    }
  })
  .from(estimates)
  .leftJoin(contacts, eq(estimates.contactId, contacts.id))
  .where(eq(estimates.contractorId, contractorId))
  .orderBy(desc(estimates.createdAt))
  // Drizzle infers the select result as a structural type that does not unify with the
  // generated Estimate type when a joined contact sub-object is included in the projection.
  // The cast is safe — every Estimate field and the contact sub-object are present above.
  .limit(500) as unknown as Estimate[];
}

async function getEstimatesPaginated(contractorId: string, options: {
  cursor?: string;
  offset?: number;
  limit?: number;
  status?: string;
  search?: string;
  dateFrom?: string;
  dateTo?: string;
  archiveDays?: number;
} = {}): Promise<PaginatedEstimates> {
  const limit = Math.min(options.limit || 50, 100);
  const conditions = [eq(estimates.contractorId, contractorId)];

  if (options.archiveDays) {
    const cutoffDate = new Date(Date.now() - options.archiveDays * 86_400_000);
    conditions.push(gte(estimates.createdAt, cutoffDate));
  }
  if (options.cursor) {
    conditions.push(gt(estimates.createdAt, new Date(options.cursor)));
  }
  if (options.status) {
    conditions.push(statusTabFilter(options.status));
  }
  if (options.search) {
    // SAFE: `or()` with non-null ilike arguments always returns a non-null SQL
    // expression; `!` silences Drizzle's overly-conservative `undefined` return type.
    conditions.push(or(
      ilike(estimates.title, `%${options.search}%`),
      ilike(contacts.name, `%${options.search}%`),
      sql`array_to_string(${contacts.emails}, ' ') ILIKE ${'%' + options.search + '%'}`,
      sql`array_to_string(${contacts.phones}, ' ') ILIKE ${'%' + options.search + '%'}`,
    )!);
  }
  if (options.dateFrom) {
    conditions.push(gte(estimates.createdAt, new Date(options.dateFrom)));
  }
  if (options.dateTo) {
    conditions.push(lte(estimates.createdAt, new Date(options.dateTo)));
  }

  const [estimatesData, total, statusCounts] = await Promise.all([
    db.select({
      id: estimates.id,
      title: estimates.title,
      description: estimates.description,
      amount: estimates.amount,
      status: estimates.status,
      validUntil: estimates.validUntil,
      contactId: estimates.contactId,
      contactName: sql<string>`COALESCE(${contacts.name}, 'Unknown Contact')`,
      contactEmails: contacts.emails,
      contactPhones: contacts.phones,
      contactTags: contacts.tags,
      contactHasJobs: sql<boolean>`EXISTS(SELECT 1 FROM ${jobs} WHERE ${jobs.contactId} = ${contacts.id})`,
      externalSource: estimates.externalSource,
      externalId: estimates.externalId,
      housecallProEstimateId: estimates.housecallProEstimateId,
      hcpOptions: estimates.hcpOptions,
      documentSentAt: estimates.documentSentAt,
      createdAt: estimates.createdAt,
      updatedAt: estimates.updatedAt,
    })
    .from(estimates)
    .leftJoin(contacts, eq(estimates.contactId, contacts.id))
    .where(and(...conditions))
    .orderBy(desc(estimates.createdAt))
    .limit(limit + 1)
    .offset(options.offset ?? 0),
    getEstimatesCount(contractorId, { status: options.status, search: options.search, dateFrom: options.dateFrom, dateTo: options.dateTo, archiveDays: options.archiveDays }),
    getEstimatesStatusCounts(contractorId, { search: options.search, dateFrom: options.dateFrom, dateTo: options.dateTo, archiveDays: options.archiveDays }),
  ]);

  const hasMore = estimatesData.length > limit;
  if (estimatesData.length > limit) estimatesData.pop();

  const nextCursor = hasMore && estimatesData.length > 0
    ? estimatesData[estimatesData.length - 1].createdAt.toISOString()
    : null;

  return { data: estimatesData, pagination: { total, hasMore, nextCursor }, statusCounts };
}

async function getEstimatesCount(contractorId: string, options: {
  status?: string;
  search?: string;
  dateFrom?: string;
  dateTo?: string;
  archiveDays?: number;
} = {}): Promise<number> {
  const conditions = [eq(estimates.contractorId, contractorId)];
  if (options.archiveDays) {
    const cutoffDate = new Date(Date.now() - options.archiveDays * 86_400_000);
    conditions.push(gte(estimates.createdAt, cutoffDate));
  }
  if (options.status) conditions.push(statusTabFilter(options.status));
  if (options.search) {
    // SAFE: `or()` with non-null ilike arguments always returns a non-null SQL
    // expression; `!` silences Drizzle's overly-conservative `undefined` return type.
    conditions.push(or(
      ilike(estimates.title, `%${options.search}%`),
      ilike(contacts.name, `%${options.search}%`),
      sql`array_to_string(${contacts.emails}, ' ') ILIKE ${'%' + options.search + '%'}`,
      sql`array_to_string(${contacts.phones}, ' ') ILIKE ${'%' + options.search + '%'}`,
    )!);
  }
  if (options.dateFrom) {
    conditions.push(gte(estimates.createdAt, new Date(options.dateFrom)));
  }
  if (options.dateTo) {
    conditions.push(lte(estimates.createdAt, new Date(options.dateTo)));
  }
  const result = await db.select({ count: count() })
    .from(estimates)
    .leftJoin(contacts, eq(estimates.contactId, contacts.id))
    .where(and(...conditions));
  return result[0].count;
}

async function getEstimatesStatusCounts(contractorId: string, options: {
  search?: string;
  dateFrom?: string;
  dateTo?: string;
  archiveDays?: number;
} = {}): Promise<EstimateStatusCounts> {
  const baseConditions = [eq(estimates.contractorId, contractorId)];
  if (options.archiveDays) {
    const cutoffDate = new Date(Date.now() - options.archiveDays * 86_400_000);
    baseConditions.push(gte(estimates.createdAt, cutoffDate));
  }
  if (options.search) {
    // SAFE: `or()` with non-null ilike arguments always returns a non-null SQL
    // expression; `!` silences Drizzle's overly-conservative `undefined` return type.
    baseConditions.push(or(
      ilike(estimates.title, `%${options.search}%`),
      ilike(contacts.name, `%${options.search}%`),
      sql`array_to_string(${contacts.emails}, ' ') ILIKE ${'%' + options.search + '%'}`,
      sql`array_to_string(${contacts.phones}, ' ') ILIKE ${'%' + options.search + '%'}`,
    )!);
  }
  if (options.dateFrom) {
    baseConditions.push(gte(estimates.createdAt, new Date(options.dateFrom)));
  }
  if (options.dateTo) {
    baseConditions.push(lte(estimates.createdAt, new Date(options.dateTo)));
  }
  const result = await db.select({
    all: count(),
    sent: sql<number>`COUNT(CASE WHEN (${estimates.documentSentAt} IS NOT NULL OR ${estimates.status} = 'sent') AND ${estimates.status} NOT IN ('approved','rejected') THEN 1 END)`,
    scheduled: sql<number>`COUNT(CASE WHEN ${estimates.status} = 'scheduled' AND ${estimates.documentSentAt} IS NULL THEN 1 END)`,
    in_progress: sql<number>`COUNT(CASE WHEN ${estimates.status} = 'in_progress' AND ${estimates.documentSentAt} IS NULL THEN 1 END)`,
    approved: sql<number>`COUNT(CASE WHEN ${estimates.status} = 'approved' THEN 1 END)`,
    rejected: sql<number>`COUNT(CASE WHEN ${estimates.status} = 'rejected' THEN 1 END)`,
  })
  .from(estimates)
  .leftJoin(contacts, eq(estimates.contactId, contacts.id))
  .where(and(...baseConditions));

  const counts = result[0];
  return {
    all: Number(counts.all),
    sent: Number(counts.sent),
    scheduled: Number(counts.scheduled),
    in_progress: Number(counts.in_progress),
    approved: Number(counts.approved),
    rejected: Number(counts.rejected),
  };
}

async function getEstimate(id: string, contractorId: string): Promise<Estimate | undefined> {
  const result = await db.select().from(estimates)
    .where(and(eq(estimates.id, id), eq(estimates.contractorId, contractorId)))
    .limit(1);
  return result[0];
}

async function createEstimate(estimate: Omit<InsertEstimate, 'contractorId'>, contractorId: string): Promise<Estimate> {
  if (estimate.contactId) {
    const contact = await db.select({ id: contacts.id }).from(contacts).where(and(
      eq(contacts.id, estimate.contactId),
      eq(contacts.contractorId, contractorId)
    )).limit(1);
    if (!contact[0]) throw new Error('Contact not found or does not belong to this contractor');
  }
  // Stamp the status-transition timestamps if the estimate is being created
  // already in a terminal status (e.g. backfilled HCP rows that come in already
  // approved). Caller-provided values win.
  const stamped: Record<string, unknown> = { ...estimate };
  const now = new Date();
  if (estimate.status === 'approved' && stamped.approvedAt === undefined) {
    stamped.approvedAt = now;
  }
  if (estimate.status === 'rejected' && stamped.rejectedAt === undefined) {
    stamped.rejectedAt = now;
  }
  // SAFE: `estimate` is Omit<InsertEstimate, 'contractorId'>; spreading with contractorId
  // produces the correct shape at runtime. Drizzle's insert type is slightly stricter
  // than the inferred spread, so `as any` silences the structural mismatch.
  const result = await db.insert(estimates).values({ ...stamped, contractorId } as any).returning();
  invalidateReportsCache(contractorId);
  return result[0];
}

async function updateEstimate(id: string, estimate: UpdateEstimate, contractorId: string): Promise<Estimate | undefined> {
  const cleanEstimate: Record<string, unknown> = Object.fromEntries(
    Object.entries(estimate).filter(([, v]) => v !== undefined)
  );

  // Capture prior status to detect transitions for the sales-process
  // estimate-status-changed cadences (task #567). We only need this when
  // the caller is actually changing the status field — otherwise the hook
  // is a no-op.
  let priorStatus: string | undefined;
  if (cleanEstimate.status !== undefined) {
    const before = await db.select({ status: estimates.status })
      .from(estimates)
      .where(and(eq(estimates.id, id), eq(estimates.contractorId, contractorId)))
      .limit(1);
    priorStatus = before[0]?.status;
  }

  // Task #762: auto-clear stale follow_up_date when an estimate transitions
  // into a closed state that the Follow-Ups page already excludes (task #761).
  // The excluded states are scheduled/approved/rejected. Without this,
  // reopening an estimate (back to in_progress/sent) would silently restore
  // a months-old follow-up date. We only clear if the caller didn't pass an
  // explicit followUpDate in this same update.
  if (
    cleanEstimate.followUpDate === undefined &&
    typeof cleanEstimate.status === 'string' &&
    ['scheduled', 'approved', 'rejected'].includes(cleanEstimate.status)
  ) {
    cleanEstimate.followUpDate = null;
  }

  // Stamp approved_at / rejected_at the first time an estimate enters that
  // status. We compare to the existing row so subsequent edits (notes, etc.)
  // and re-affirmations of the same status don't bump the timestamp. Callers
  // can still pass an explicit approvedAt/rejectedAt to override (e.g. backfill).
  // Task #898: manually marking an estimate as 'sent' also stamps the sticky
  // document-sent timestamp (if not already set) so the Sent tab, badge, and
  // count all agree. Never overwrites an existing value; callers may still
  // pass an explicit documentSentAt (e.g. HCP webhook/sync).
  // Task #900: the REVERSE (clearing documentSentAt when moving back to
  // scheduled/in_progress) is deliberately NOT done here — it happens at the
  // manual route level (routes/estimates.ts PATCH /:id/status and PUT /:id)
  // so HCP sync/webhook paths calling updateEstimate never clear the stamp.
  if (cleanEstimate.status === 'sent' && cleanEstimate.documentSentAt === undefined) {
    const existing = await db.select({ documentSentAt: estimates.documentSentAt })
      .from(estimates)
      .where(and(eq(estimates.id, id), eq(estimates.contractorId, contractorId)))
      .limit(1);
    if (existing[0] && !existing[0].documentSentAt) {
      cleanEstimate.documentSentAt = new Date();
    }
  }

  if (cleanEstimate.status === 'approved' || cleanEstimate.status === 'rejected') {
    const existing = await db.select({
      status: estimates.status,
      approvedAt: estimates.approvedAt,
      rejectedAt: estimates.rejectedAt,
    }).from(estimates)
      .where(and(eq(estimates.id, id), eq(estimates.contractorId, contractorId)))
      .limit(1);
    const prev = existing[0];
    if (prev) {
      const now = new Date();
      if (cleanEstimate.status === 'approved' && cleanEstimate.approvedAt === undefined && !prev.approvedAt) {
        cleanEstimate.approvedAt = now;
      }
      if (cleanEstimate.status === 'rejected' && cleanEstimate.rejectedAt === undefined && !prev.rejectedAt) {
        cleanEstimate.rejectedAt = now;
      }
    }
  }

  const result = await db.update(estimates)
    // SAFE: `cleanEstimate` is a filtered subset of UpdateEstimate; the spread is
    // structurally correct at runtime. Drizzle's `.set()` type doesn't accept a
    // `Record<string, unknown>` from Object.fromEntries, so `as any` is needed.
    .set({ ...cleanEstimate, updatedAt: new Date() } as any)
    .where(and(eq(estimates.id, id), eq(estimates.contractorId, contractorId)))
    .returning();
  if (result[0]) invalidateReportsCache(contractorId);
  if (result[0] && priorStatus !== undefined && priorStatus !== result[0].status) {
    const after = result[0];
    void (async () => {
      try {
        const { onEstimateStatusChanged } = await import("../services/sales-process");
        await onEstimateStatusChanged(after.id, contractorId, after.status, priorStatus);
      } catch (err) {
        console.warn('[sales-process] onEstimateStatusChanged hook failed:', err);
      }
    })();
  }
  return result[0];
}

async function deleteEstimate(id: string, contractorId: string): Promise<boolean> {
  const estimate = await db.select({ contactId: estimates.contactId })
    .from(estimates)
    .where(and(eq(estimates.id, id), eq(estimates.contractorId, contractorId)))
    .limit(1);

  if (estimate.length === 0) return false;
  const contactId = estimate[0].contactId;

  const deleted = await db.transaction(async (tx) => {
    await tx.delete(activities).where(and(
      eq(activities.estimateId, id),
      eq(activities.contractorId, contractorId)
    ));
    const result = await tx.delete(estimates)
      .where(and(eq(estimates.id, id), eq(estimates.contractorId, contractorId)))
      .returning();
    if (result.length === 0) return result;

    if (contactId) {
      // SINGLE-ITEM SAFE: called once per individual estimate delete.
      // Do NOT move this call inside a loop — see maybeDeleteOrphanContactTx JSDoc
      // for context. Runs inside the transaction so the entire deletion is atomic.
      await maybeDeleteOrphanContactTx(tx, contactId, contractorId);
    }

    return result;
  });

  if (deleted.length > 0) invalidateReportsCache(contractorId);
  return deleted.length > 0;
}

export type EstimateWithContactInfo = Estimate & {
  contactName: string | null;
  contactEmails: string[] | null;
  contactPhones: string[] | null;
  contactAddress: string | null;
};

async function getEstimatesWithFollowUp(contractorId: string, limit = 200): Promise<EstimateWithContactInfo[]> {
  const rows = await db.select({
    id: estimates.id,
    title: estimates.title,
    description: estimates.description,
    amount: estimates.amount,
    status: estimates.status,
    validUntil: estimates.validUntil,
    followUpDate: estimates.followUpDate,
    contactId: estimates.contactId,
    contractorId: estimates.contractorId,
    housecallProEstimateId: estimates.housecallProEstimateId,
    housecallProCustomerId: estimates.housecallProCustomerId,
    scheduledStart: estimates.scheduledStart,
    scheduledEnd: estimates.scheduledEnd,
    scheduledEmployeeId: estimates.scheduledEmployeeId,
    hcpOptions: estimates.hcpOptions,
    syncedAt: estimates.syncedAt,
    documentSentAt: estimates.documentSentAt,
    externalId: estimates.externalId,
    externalSource: estimates.externalSource,
    createdAt: estimates.createdAt,
    updatedAt: estimates.updatedAt,
    contactName: contacts.name,
    contactEmails: contacts.emails,
    contactPhones: contacts.phones,
    contactAddress: contacts.address,
  })
    .from(estimates)
    .leftJoin(contacts, eq(estimates.contactId, contacts.id))
    .where(and(
      eq(estimates.contractorId, contractorId),
      sql`${estimates.followUpDate} IS NOT NULL`
    ))
    .orderBy(estimates.followUpDate)
    .limit(limit);
  return rows as unknown as EstimateWithContactInfo[];
}

async function getEstimatesByStatus(contractorId: string, status: typeof estimateStatusEnum.enumValues[number]): Promise<Estimate[]> {
  return db.select()
    .from(estimates)
    .where(and(
      eq(estimates.contractorId, contractorId),
      eq(estimates.status, status)
    ))
    .orderBy(desc(estimates.createdAt)) as unknown as Estimate[];
}

export const estimateMethods = {
  getEstimates,
  getEstimatesPaginated,
  getEstimatesCount,
  getEstimatesStatusCounts,
  getEstimate,
  createEstimate,
  updateEstimate,
  deleteEstimate,
  getEstimatesWithFollowUp,
  getEstimatesByStatus,
};
