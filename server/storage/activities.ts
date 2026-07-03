import {
  type Activity, type InsertActivity,
  activities, users, estimates, jobs, contacts,
} from "@shared/schema";
import { db } from "../db";
import { eq, and, or, desc, sql, isNotNull, inArray } from "drizzle-orm";
import type { UpdateActivity } from "../storage-types";

/**
 * Encode/decode a (createdAt, id) composite cursor for stable keyset pagination.
 *
 * Using a composite cursor avoids the skip/duplicate problem that occurs when
 * multiple activities share the same createdAt timestamp (e.g. bulk-inserted
 * rows with the same `now()` value). The keyset predicate is:
 *   (created_at, id) < (cursor_ts, cursor_id)  [for DESC ordering]
 * which Postgres evaluates as a row-value comparison, fully stable regardless of
 * timestamp collisions.
 */
function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ ts: createdAt.toISOString(), id })).toString('base64');
}

function decodeCursor(cursor: string): { ts: string; id: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8'));
    if (typeof parsed.ts !== 'string' || typeof parsed.id !== 'string') return null;
    // Reject cursors with an invalid timestamp to prevent runtime 500s from
    // new Date(invalidString) producing an Invalid Date that Drizzle cannot bind.
    if (isNaN(new Date(parsed.ts).getTime())) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function getActivities(contractorId: string, options: {
  contactId?: string;
  estimateId?: string;
  jobId?: string;
  type?: 'note' | 'call' | 'email' | 'sms' | 'meeting' | 'follow_up' | 'status_change';
  limit?: number;
  /**
   * Cursor-based pagination: opaque base64 token encoding (createdAt, id) keyset.
   * Replaces OFFSET pagination — keyset seeks are O(1) regardless of page depth.
   * Pass the `nextCursor` returned by the previous page to fetch the next page.
   * Encoded via encodeCursor(); decoded via decodeCursor().
   */
  cursor?: string;
} = {}): Promise<Activity[]> {
  const conditions = [
    eq(activities.contractorId, contractorId),
    // SAFE: `or(...)` with three non-null arguments always returns a non-null SQL
    // expression; the `!` only suppresses Drizzle's overly-conservative `undefined`
    // return type that arises when all arguments could theoretically be undefined.
    or(isNotNull(activities.contactId), isNotNull(activities.estimateId), isNotNull(activities.jobId))!
  ];

  if (options.contactId) conditions.push(eq(activities.contactId, options.contactId));
  if (options.estimateId) conditions.push(eq(activities.estimateId, options.estimateId));
  if (options.jobId) conditions.push(eq(activities.jobId, options.jobId));
  if (options.type) conditions.push(eq(activities.type, options.type));

  if (options.cursor) {
    const decoded = decodeCursor(options.cursor);
    if (decoded) {
      // Row-value keyset predicate: (created_at, id) < (cursor_ts, cursor_id)
      // This is fully stable even when multiple rows share the same created_at.
      conditions.push(sql`(${activities.createdAt}, ${activities.id}) < (${new Date(decoded.ts)}, ${decoded.id})`);
    }
  }

  const result = await db.select({
    id: activities.id, type: activities.type, title: activities.title, content: activities.content,
    metadata: activities.metadata,
    contactId: activities.contactId, estimateId: activities.estimateId, jobId: activities.jobId,
    userId: activities.userId, contractorId: activities.contractorId,
    externalId: activities.externalId, externalSource: activities.externalSource,
    createdAt: activities.createdAt, updatedAt: activities.updatedAt, userName: users.name,
    // Linked-entity context — used by the Recent Activity timeline / detail-page
    // timelines to render "who is this call/email about?". The priority for
    // picking which entity to display is job → estimate → contact.
    contactName: contacts.name,
    contactType: contacts.type,
    estimateTitle: estimates.title,
    jobTitle: jobs.title,
  }).from(activities)
    .leftJoin(users, eq(activities.userId, users.id))
    .leftJoin(contacts, eq(activities.contactId, contacts.id))
    .leftJoin(estimates, eq(activities.estimateId, estimates.id))
    .leftJoin(jobs, eq(activities.jobId, jobs.id))
    .where(and(...conditions))
    .orderBy(desc(activities.createdAt), desc(activities.id))
    .limit(options.limit || 50);

  // Resolve the friendly entity-name + kind for each row. Job > estimate > contact;
  // for Dialpad calls without a matched contact we fall back to the contact name
  // Dialpad itself supplied so reps still see *who* a call is about.
  const enriched = result.map((row) => {
    let entityName: string | null = null;
    let entityType: 'job' | 'estimate' | 'lead' | 'customer' | null = null;
    if (row.jobTitle) {
      entityName = row.jobTitle;
      entityType = 'job';
    } else if (row.estimateTitle) {
      entityName = row.estimateTitle;
      entityType = 'estimate';
    } else if (row.contactName) {
      entityName = row.contactName;
      entityType = row.contactType === 'customer' ? 'customer' : 'lead';
    } else if (row.type === 'call' && row.externalSource === 'dialpad') {
      const meta = (row.metadata ?? {}) as Record<string, unknown>;
      const fallback = typeof meta.contactName === 'string' ? meta.contactName : null;
      if (fallback) entityName = fallback;
    }
    return { ...row, entityName, entityType };
  });

  // Drizzle infers the select result as a structural type that matches Activity but
  // does not unify with the generated Activity type when extra columns (userName,
  // entityName, entityType) are joined / computed. The cast is safe — every
  // Activity field is present in the projection above.
  return enriched as unknown as Activity[];
}

/**
 * Tenant-wide call history for the Calls page.
 *
 * Unlike getActivities(), this does NOT require a linked contact/estimate/job —
 * it intentionally includes UNASSIGNED calls (contactId IS NULL), which are the
 * inbound calls from numbers that matched no contact. Results are call-only,
 * newest first, with the same (createdAt, id) keyset cursor pagination.
 *
 * `otherPartyNumber` is derived server-side from the call metadata:
 *   - inbound  → the customer is the `from_number`
 *   - outbound → the customer is the `to_number` (Twilio stores the true
 *     customer here even for bridged calls; the rep's leg is never persisted)
 * with fallbacks for provider-specific field names, and finally the linked
 * contact's first phone. This is the number pre-filled into the
 * create-contact-from-call flow.
 */
async function getCallActivities(contractorId: string, options: {
  direction?: 'inbound' | 'outbound';
  assignment?: 'assigned' | 'unassigned';
  limit?: number;
  cursor?: string;
} = {}): Promise<Array<Activity & { otherPartyNumber: string | null }>> {
  const conditions = [
    eq(activities.contractorId, contractorId),
    eq(activities.type, 'call'),
  ];

  if (options.direction) {
    conditions.push(sql`(${activities.metadata}::jsonb)->>'direction' = ${options.direction}`);
  }
  if (options.assignment === 'assigned') {
    conditions.push(isNotNull(activities.contactId));
  } else if (options.assignment === 'unassigned') {
    conditions.push(sql`${activities.contactId} IS NULL`);
  }

  if (options.cursor) {
    const decoded = decodeCursor(options.cursor);
    if (decoded) {
      conditions.push(sql`(${activities.createdAt}, ${activities.id}) < (${new Date(decoded.ts)}, ${decoded.id})`);
    }
  }

  const result = await db.select({
    id: activities.id, type: activities.type, title: activities.title, content: activities.content,
    metadata: activities.metadata,
    contactId: activities.contactId, estimateId: activities.estimateId, jobId: activities.jobId,
    userId: activities.userId, contractorId: activities.contractorId,
    externalId: activities.externalId, externalSource: activities.externalSource,
    createdAt: activities.createdAt, updatedAt: activities.updatedAt, userName: users.name,
    contactName: contacts.name,
    contactType: contacts.type,
    contactPhones: contacts.phones,
  }).from(activities)
    .leftJoin(users, eq(activities.userId, users.id))
    .leftJoin(contacts, eq(activities.contactId, contacts.id))
    .where(and(...conditions))
    .orderBy(desc(activities.createdAt), desc(activities.id))
    .limit(options.limit || 50);

  const enriched = result.map((row) => {
    // activities.metadata is a text column that holds JSON; depending on the
    // ingestion path it may arrive already parsed (jsonb-style object) or as a
    // raw JSON string. Normalize before deriving otherPartyNumber, or unassigned
    // calls (no linked-contact phone fallback) would lose their number entirely.
    let meta: Record<string, unknown> = {};
    if (row.metadata && typeof row.metadata === 'object') {
      meta = row.metadata as Record<string, unknown>;
    } else if (typeof row.metadata === 'string') {
      try {
        const parsed = JSON.parse(row.metadata);
        if (parsed && typeof parsed === 'object') meta = parsed as Record<string, unknown>;
      } catch {
        meta = {};
      }
    }
    const str = (v: unknown): string | null =>
      typeof v === 'string' && v.trim().length > 0 ? v : null;
    const direction = str(meta.direction);
    // Prefer the direction-appropriate leg, then provider-specific fallbacks,
    // then the linked contact's first phone.
    const otherPartyNumber =
      (direction === 'outbound' ? str(meta.to_number) : str(meta.from_number)) ||
      str(meta.customerNumber) ||
      str(meta.contactPhone) ||
      str(meta.external_number) ||
      (Array.isArray(row.contactPhones) ? str(row.contactPhones[0]) : null);

    let entityName: string | null = row.contactName ?? null;
    if (!entityName && row.externalSource === 'dialpad') {
      const fallback = typeof meta.contactName === 'string' ? meta.contactName : null;
      if (fallback) entityName = fallback;
    }
    const entityType: 'lead' | 'customer' | null = row.contactId
      ? (row.contactType === 'customer' ? 'customer' : 'lead')
      : null;

    return { ...row, otherPartyNumber, entityName, entityType };
  });

  return enriched as unknown as Array<Activity & { otherPartyNumber: string | null }>;
}

async function getActivity(id: string, contractorId: string): Promise<Activity | undefined> {
  const result = await db.select().from(activities).where(and(
    eq(activities.id, id),
    eq(activities.contractorId, contractorId)
  )).limit(1);
  return result[0];
}

async function resolveContactId(activity: Omit<InsertActivity, 'contractorId'>): Promise<string | null | undefined> {
  if (activity.contactId) return activity.contactId;
  if (activity.estimateId) {
    const row = await db.select({ contactId: estimates.contactId }).from(estimates)
      .where(eq(estimates.id, activity.estimateId)).limit(1);
    if (row[0]?.contactId) return row[0].contactId;
  }
  if (activity.jobId) {
    const row = await db.select({ contactId: jobs.contactId }).from(jobs)
      .where(eq(jobs.id, activity.jobId)).limit(1);
    if (row[0]?.contactId) return row[0].contactId;
  }
  return activity.contactId;
}

/**
 * Compute the initial `readAt` value for an inserted activity row.
 *
 * Email activities use `read_at` for unread-badge parity with SMS:
 *   - Outbound emails (metadata.direction === 'outbound') are inserted with
 *     `read_at = NOW()` so they NEVER appear unread.
 *   - Inbound emails leave `read_at` NULL (the unread state).
 *   - Non-email activities preserve any caller-supplied value (typically NULL).
 *
 * Caller-supplied `readAt` always wins, so a callsite can opt out by passing
 * an explicit value.
 */
export function deriveInitialReadAt(activity: Omit<InsertActivity, 'contractorId'>): Date | null | undefined {
  if (activity.readAt !== undefined) return activity.readAt;
  if (activity.type !== 'email') return undefined;
  const metadata = activity.metadata && typeof activity.metadata === 'object'
    ? (activity.metadata as Record<string, unknown>)
    : {};
  if (metadata.direction === 'outbound') return new Date();
  return undefined;
}

async function createActivity(activity: Omit<InsertActivity, 'contractorId'>, contractorId: string): Promise<Activity> {
  const contactId = await resolveContactId(activity);
  const readAt = deriveInitialReadAt(activity);
  const result = await db.insert(activities).values({ ...activity, contactId, contractorId, readAt }).returning();
  if (contactId && result[0]) {
    const activityTs = result[0].createdAt ?? new Date();
    await db.update(contacts)
      .set({ lastActivityAt: activityTs })
      .where(and(
        eq(contacts.id, contactId),
        eq(contacts.contractorId, contractorId),
        sql`(${contacts.lastActivityAt} IS NULL OR ${contacts.lastActivityAt} < ${activityTs})`,
      ));
  }
  // Sales-process auto-completion hook (task #506). Awaited but wrapped in
  // try/catch so a hook failure cannot break the primary activity-creation
  // write path. The result (if any) is attached to the returned activity as
  // a non-persisted side-channel field so the POST /api/activities route can
  // surface a subtle confirmation to the rep ("cleared Day-1 call from your
  // cadence"). Other callers of createActivity simply ignore the field.
  if (result[0]) {
    try {
      const { onActivityCreated } = await import("../services/sales-process");
      const completed = await onActivityCreated(result[0]);
      if (completed) {
        (result[0] as Activity & { autoCompletedCadenceTask?: unknown }).autoCompletedCadenceTask = {
          id: completed.id,
          stepId: completed.stepId,
          actionType: completed.actionType,
          dueAt: completed.dueAt,
        };
      }
    } catch (err) {
      console.warn('[sales-process] onActivityCreated hook failed:', err);
    }
  }
  return result[0];
}

/**
 * Bulk-insert multiple activity records in a single SQL INSERT statement.
 *
 * Use this instead of looping over `createActivity()` when you have several
 * activities to persist at once (e.g., the Gmail sync loop). Reduces DB
 * round-trips from O(n) to O(1) for the batch.
 *
 * Returns the inserted rows in insertion order.
 */
async function bulkCreateActivities(
  activityList: Array<Omit<InsertActivity, 'contractorId'>>,
  contractorId: string,
): Promise<Activity[]> {
  if (activityList.length === 0) return [];

  // Collect estimate/job IDs for rows that are missing a contactId
  const missingContact = activityList.filter(a => !a.contactId);
  const estimateIds = Array.from(new Set(missingContact.map(a => a.estimateId).filter(Boolean))) as string[];
  const jobIds = Array.from(new Set(missingContact.map(a => a.jobId).filter(Boolean))) as string[];

  // Batch lookups — one query per entity type
  const estimateContactMap = new Map<string, string>();
  const jobContactMap = new Map<string, string>();

  if (estimateIds.length > 0) {
    const rows = await db.select({ id: estimates.id, contactId: estimates.contactId })
      .from(estimates).where(inArray(estimates.id, estimateIds));
    for (const r of rows) if (r.contactId) estimateContactMap.set(r.id, r.contactId);
  }
  if (jobIds.length > 0) {
    const rows = await db.select({ id: jobs.id, contactId: jobs.contactId })
      .from(jobs).where(inArray(jobs.id, jobIds));
    for (const r of rows) if (r.contactId) jobContactMap.set(r.id, r.contactId);
  }

  const rows = activityList.map(a => {
    let contactId = a.contactId;
    if (!contactId && a.estimateId) contactId = estimateContactMap.get(a.estimateId) ?? undefined;
    if (!contactId && a.jobId) contactId = jobContactMap.get(a.jobId) ?? undefined;
    const readAt = deriveInitialReadAt(a);
    return { ...a, contactId, contractorId, readAt };
  });

  const result = await db.insert(activities).values(rows).onConflictDoNothing().returning();

  const contactMaxTs = new Map<string, Date>();
  for (const r of result) {
    if (r.contactId) {
      const ts = r.createdAt ?? new Date();
      const existing = contactMaxTs.get(r.contactId);
      if (!existing || ts > existing) {
        contactMaxTs.set(r.contactId, ts);
      }
    }
  }
  for (const [cid, maxTs] of contactMaxTs) {
    await db.update(contacts)
      .set({ lastActivityAt: maxTs })
      .where(and(
        eq(contacts.id, cid),
        eq(contacts.contractorId, contractorId),
        sql`(${contacts.lastActivityAt} IS NULL OR ${contacts.lastActivityAt} < ${maxTs})`,
      ));
  }

  return result;
}

async function updateActivity(id: string, activity: UpdateActivity, contractorId: string): Promise<Activity | undefined> {
  const result = await db.update(activities)
    .set({ ...activity, updatedAt: new Date() })
    .where(and(eq(activities.id, id), eq(activities.contractorId, contractorId)))
    .returning();
  return result[0];
}

/**
 * Look up activities (typically outbound emails) whose stored
 * `metadata.rfc822MessageId` matches any of the supplied RFC822 Message-Id
 * header values. Used to thread inbound replies back to the original
 * outbound email's contact even when the reply comes from an unknown
 * sender address.
 *
 * Results are ordered most-recent first so callers can prefer the latest
 * matching activity when multiple distinct contacts match.
 */
async function findActivitiesByRfc822MessageIds(
  contractorId: string,
  rfc822MessageIds: string[],
): Promise<Array<{
  activityId: string;
  contactId: string | null;
  estimateId: string | null;
  jobId: string | null;
  rfc822MessageId: string;
  createdAt: Date;
}>> {
  const cleaned = Array.from(new Set(
    rfc822MessageIds.map(s => (s || '').trim()).filter(Boolean)
  ));
  if (cleaned.length === 0) return [];

  const result = await db.select({
    activityId: activities.id,
    contactId: activities.contactId,
    estimateId: activities.estimateId,
    jobId: activities.jobId,
    // The metadata column is stored as text holding a JSON-serialized object
    // (drift between the Drizzle declaration and the actual column type).
    // Cast to jsonb explicitly so the index expression matches and the
    // ->> operator can be applied.
    rfc822MessageId: sql<string>`(${activities.metadata}::jsonb)->>'rfc822MessageId'`,
    createdAt: activities.createdAt,
  })
    .from(activities)
    .where(and(
      eq(activities.contractorId, contractorId),
      sql`(${activities.metadata}::jsonb)->>'rfc822MessageId' IS NOT NULL`,
      sql`(${activities.metadata}::jsonb)->>'rfc822MessageId' = ANY(ARRAY[${sql.join(cleaned.map(id => sql`${id}`), sql`, `)}]::text[])`,
    ))
    .orderBy(desc(activities.createdAt))
    .limit(50);

  return result;
}

async function deleteActivity(id: string, contractorId: string): Promise<boolean> {
  const result = await db.delete(activities).where(and(eq(activities.id, id), eq(activities.contractorId, contractorId))).returning();
  return result.length > 0;
}

export const activityMethods = {
  getActivities,
  getCallActivities,
  getActivity,
  createActivity,
  bulkCreateActivities,
  findActivitiesByRfc822MessageIds,
  updateActivity,
  deleteActivity,
};

export { encodeCursor as encodeActivityCursor };
