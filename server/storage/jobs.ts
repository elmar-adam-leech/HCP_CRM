import {
  type Job, type InsertJob,
  type PaginatedJobs,
  jobs, estimates, contacts, messages,
  jobStatusEnum,
} from "@shared/schema";
import { db } from "../db";
import { eq, and, or, desc, lt, lte, gte, ilike, sql, count } from "drizzle-orm";
import type { UpdateJob } from "../storage-types";
import { maybeDeleteOrphanContactTx } from "./contacts";

type JobStatusCounts = {
  all: number;
  scheduled: number;
  in_progress: number;
  completed: number;
  cancelled: number;
};

const GET_JOBS_LIMIT = 500;

// Legacy bulk-list function capped at 500 rows. Exists only for backward
// compatibility (e.g. webhook idempotency checks). New features must use
// getJobsPaginated which supports cursor/offset pagination and bundled status counts.
async function getJobs(contractorId: string): Promise<Job[]> {
  return await db.select().from(jobs).where(eq(jobs.contractorId, contractorId)).orderBy(desc(jobs.createdAt)).limit(GET_JOBS_LIMIT);
}

async function getJobsPaginated(contractorId: string, options: {
  cursor?: string;
  offset?: number;
  limit?: number;
  status?: string;
  search?: string;
  dateFrom?: string;
  dateTo?: string;
} = {}): Promise<PaginatedJobs> {
  const limit = Math.min(options.limit || 50, 100);
  const conditions = [eq(jobs.contractorId, contractorId)];

  if (options.cursor) {
    conditions.push(lt(jobs.createdAt, new Date(options.cursor)));
  }
  if (options.status && options.status !== 'all') {
    conditions.push(eq(jobs.status, options.status as typeof jobStatusEnum.enumValues[number]));
  }
  if (options.search) {
    // SAFE: `or()` with non-null ilike arguments always returns a non-null SQL
    // expression; `!` silences Drizzle's overly-conservative `undefined` return type.
    conditions.push(or(
      ilike(jobs.title, `%${options.search}%`),
      ilike(contacts.name, `%${options.search}%`),
      sql`array_to_string(${contacts.emails}, ' ') ILIKE ${'%' + options.search + '%'}`,
      sql`array_to_string(${contacts.phones}, ' ') ILIKE ${'%' + options.search + '%'}`,
    )!);
  }
  if (options.dateFrom) {
    conditions.push(gte(jobs.scheduledDate, new Date(options.dateFrom)));
  }
  if (options.dateTo) {
    conditions.push(lte(jobs.scheduledDate, new Date(options.dateTo)));
  }

  const [jobsData, total, statusCounts] = await Promise.all([
    db.select({
      id: jobs.id,
      title: jobs.title,
      type: jobs.type,
      status: jobs.status,
      priority: jobs.priority,
      value: jobs.value,
      scheduledDate: jobs.scheduledDate,
      contactId: jobs.contactId,
      contactName: contacts.name,
      contactEmails: contacts.emails,
      contactPhones: contacts.phones,
      estimatedHours: jobs.estimatedHours,
      externalSource: jobs.externalSource,
      externalId: jobs.externalId,
      estimateId: jobs.estimateId,
      createdAt: jobs.createdAt,
      updatedAt: jobs.updatedAt,
    })
    .from(jobs)
    .leftJoin(contacts, eq(jobs.contactId, contacts.id))
    .where(and(...conditions))
    .orderBy(desc(jobs.createdAt))
    .limit(limit + 1)
    .offset(options.offset ?? 0),
    getJobsCount(contractorId, { status: options.status, search: options.search, dateFrom: options.dateFrom, dateTo: options.dateTo }),
    getJobsStatusCounts(contractorId, { search: options.search }),
  ]);

  const hasMore = jobsData.length > limit;
  if (hasMore) jobsData.pop();

  const nextCursor = hasMore && jobsData.length > 0
    ? jobsData[jobsData.length - 1].createdAt.toISOString()
    : null;

  return {
    data: jobsData.map(job => ({
      ...job,
      contactName: job.contactName || 'Unknown Contact',
      contactEmail: (job.contactEmails && job.contactEmails.length > 0) ? job.contactEmails[0] : null,
      contactPhone: (job.contactPhones && job.contactPhones.length > 0) ? job.contactPhones[0] : null,
    })),
    pagination: { total, hasMore, nextCursor },
    statusCounts,
  };
}

async function getJobsCount(contractorId: string, options: {
  status?: string;
  search?: string;
  dateFrom?: string;
  dateTo?: string;
} = {}): Promise<number> {
  const conditions = [eq(jobs.contractorId, contractorId)];
  if (options.status && options.status !== 'all') {
    conditions.push(eq(jobs.status, options.status as typeof jobStatusEnum.enumValues[number]));
  }
  if (options.search) {
    // SAFE: `or()` with non-null ilike arguments always returns a non-null SQL
    // expression; `!` silences Drizzle's overly-conservative `undefined` return type.
    conditions.push(or(
      ilike(jobs.title, `%${options.search}%`),
      ilike(contacts.name, `%${options.search}%`),
      sql`array_to_string(${contacts.emails}, ' ') ILIKE ${'%' + options.search + '%'}`,
      sql`array_to_string(${contacts.phones}, ' ') ILIKE ${'%' + options.search + '%'}`,
    )!);
  }
  if (options.dateFrom) {
    conditions.push(gte(jobs.scheduledDate, new Date(options.dateFrom)));
  }
  if (options.dateTo) {
    conditions.push(lte(jobs.scheduledDate, new Date(options.dateTo)));
  }
  const needsContactJoin = !!options.search;
  const baseQuery = db.select({ count: sql`count(*)` }).from(jobs);
  const joinedQuery = needsContactJoin
    ? baseQuery.leftJoin(contacts, eq(jobs.contactId, contacts.id))
    : baseQuery;
  const result = await joinedQuery.where(and(...conditions));
  return Number(result[0]?.count || 0);
}

// Status counts intentionally ignore dateFrom/dateTo so the tab badges
// show totals per status regardless of the active date filter.
async function getJobsStatusCounts(contractorId: string, options: {
  search?: string;
} = {}): Promise<JobStatusCounts> {
  const baseConditions = [eq(jobs.contractorId, contractorId)];
  if (options.search) {
    // SAFE: `or()` with non-null ilike arguments always returns a non-null SQL
    // expression; `!` silences Drizzle's overly-conservative `undefined` return type.
    baseConditions.push(or(
      ilike(jobs.title, `%${options.search}%`),
      ilike(contacts.name, `%${options.search}%`),
      sql`array_to_string(${contacts.emails}, ' ') ILIKE ${'%' + options.search + '%'}`,
      sql`array_to_string(${contacts.phones}, ' ') ILIKE ${'%' + options.search + '%'}`,
    )!);
  }
  const statusSelect = {
    all: count(),
    scheduled: sql<number>`COUNT(CASE WHEN ${jobs.status} = 'scheduled' THEN 1 END)`,
    in_progress: sql<number>`COUNT(CASE WHEN ${jobs.status} = 'in_progress' THEN 1 END)`,
    completed: sql<number>`COUNT(CASE WHEN ${jobs.status} = 'completed' THEN 1 END)`,
    cancelled: sql<number>`COUNT(CASE WHEN ${jobs.status} = 'cancelled' THEN 1 END)`,
  };
  const needsContactJoin = !!options.search;
  const baseQuery = db.select(statusSelect).from(jobs);
  const joinedQuery = needsContactJoin
    ? baseQuery.leftJoin(contacts, eq(jobs.contactId, contacts.id))
    : baseQuery;
  const result = await joinedQuery.where(and(...baseConditions));

  const counts = result[0];
  return {
    all: Number(counts.all),
    scheduled: Number(counts.scheduled),
    in_progress: Number(counts.in_progress),
    completed: Number(counts.completed),
    cancelled: Number(counts.cancelled),
  };
}

async function getJob(id: string, contractorId: string): Promise<Job | undefined> {
  const result = await db.select().from(jobs)
    .where(and(eq(jobs.id, id), eq(jobs.contractorId, contractorId)))
    .limit(1);
  return result[0];
}

async function createJob(job: Omit<InsertJob, 'contractorId'>, contractorId: string): Promise<Job> {
  if (job.contactId) {
    const contact = await db.select({ id: contacts.id }).from(contacts).where(and(
      eq(contacts.id, job.contactId),
      eq(contacts.contractorId, contractorId)
    )).limit(1);
    if (!contact[0]) throw new Error('Contact not found or does not belong to this contractor');
  }
  const result = await db.insert(jobs).values({ ...job, contractorId }).returning();
  return result[0];
}

async function updateJob(id: string, job: UpdateJob, contractorId: string): Promise<Job | undefined> {
  const result = await db.update(jobs)
    .set({ ...job, updatedAt: new Date() })
    .where(and(eq(jobs.id, id), eq(jobs.contractorId, contractorId)))
    .returning();
  return result[0];
}

async function deleteJob(id: string, contractorId: string): Promise<boolean> {
  const job = await db.select({ contactId: jobs.contactId })
    .from(jobs)
    .where(and(eq(jobs.id, id), eq(jobs.contractorId, contractorId)))
    .limit(1);

  if (job.length === 0) return false;
  const contactId = job[0].contactId;

  const deleted = await db.transaction(async (tx) => {
    const result = await tx.delete(jobs)
      .where(and(eq(jobs.id, id), eq(jobs.contractorId, contractorId)))
      .returning();
    if (result.length === 0) return result;

    if (contactId) {
      // SINGLE-ITEM SAFE: called once per individual job delete.
      // Do NOT move this call inside a loop — see maybeDeleteOrphanContactTx JSDoc
      // for context. Runs inside the transaction so the entire deletion is atomic.
      await maybeDeleteOrphanContactTx(tx, contactId, contractorId);
    }

    return result;
  });

  return deleted.length > 0;
}

/**
 * Hard-deletes a contact and all associated records. Only called when a contact
 * has no remaining leads, estimates, or jobs — i.e. the last linked entity was deleted.
 * Exported so `estimates.ts` can reuse the same cleanup logic.
 */
export async function deleteContactFull(id: string, contractorId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(messages).where(and(eq(messages.contactId, id), eq(messages.contractorId, contractorId)));
    await tx.delete(estimates).where(and(eq(estimates.contactId, id), eq(estimates.contractorId, contractorId)));
    await tx.delete(jobs).where(and(eq(jobs.contactId, id), eq(jobs.contractorId, contractorId)));
    await tx.delete(contacts).where(and(eq(contacts.id, id), eq(contacts.contractorId, contractorId)));
  });
}

async function getJobByEstimateId(estimateId: string, contractorId: string): Promise<Job | undefined> {
  const result = await db.select().from(jobs)
    .where(and(eq(jobs.estimateId, estimateId), eq(jobs.contractorId, contractorId)))
    .limit(1);
  return result[0];
}

async function getJobByHousecallProJobId(externalId: string, contractorId: string): Promise<Job | undefined> {
  const result = await db.select().from(jobs)
    .where(and(eq(jobs.externalId, externalId), eq(jobs.contractorId, contractorId)))
    .limit(1);
  return result[0];
}

export type JobWithContactInfo = Job & {
  contactName: string | null;
  contactEmails: string[] | null;
  contactPhones: string[] | null;
  contactAddress: string | null;
};

async function getJobsWithFollowUp(contractorId: string, limit = 200): Promise<JobWithContactInfo[]> {
  const rows = await db.select({
    id: jobs.id,
    title: jobs.title,
    type: jobs.type,
    status: jobs.status,
    priority: jobs.priority,
    value: jobs.value,
    estimatedHours: jobs.estimatedHours,
    scheduledDate: jobs.scheduledDate,
    contactId: jobs.contactId,
    estimateId: jobs.estimateId,
    notes: jobs.notes,
    externalId: jobs.externalId,
    externalSource: jobs.externalSource,
    contractorId: jobs.contractorId,
    followUpDate: jobs.followUpDate,
    createdAt: jobs.createdAt,
    updatedAt: jobs.updatedAt,
    contactName: contacts.name,
    contactEmails: contacts.emails,
    contactPhones: contacts.phones,
    contactAddress: contacts.address,
  })
    .from(jobs)
    .leftJoin(contacts, eq(jobs.contactId, contacts.id))
    .where(and(
      eq(jobs.contractorId, contractorId),
      sql`${jobs.followUpDate} IS NOT NULL`
    ))
    .orderBy(jobs.followUpDate)
    .limit(limit);
  return rows as unknown as JobWithContactInfo[];
}

export const jobMethods = {
  getJobs,
  getJobsPaginated,
  getJobsCount,
  getJobsStatusCounts,
  getJob,
  createJob,
  updateJob,
  deleteJob,
  getJobByEstimateId,
  getJobByHousecallProJobId,
  getJobsWithFollowUp,
};
