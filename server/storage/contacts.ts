import {
  type Contact, type InsertContact,
  type Lead, type InsertLead,
  type PaginatedContacts,
  type ContactFilterOptions,
  contacts, leads, messages, activities, estimates, jobs,
  contactStatusEnum,
  hcpExcludedCustomers,
} from "@shared/schema";
import { generateBookingCode } from "../utils/booking-token";
import { db } from "../db";
import { deduplicateContacts } from "../services/contact-deduper";
import { getDashboardMetrics, getMetricsAggregates } from "../services/dashboard-metrics";
import { eq, and, or, asc, desc, ne, lt, lte, gte, ilike, isNotNull, notInArray, inArray, sql, count } from "drizzle-orm";
import { normalizePhoneArrayForStorage } from "../utils/phone-normalizer";
import type { UpdateContact } from "../storage-types";
import { cacheInvalidation } from "../services/cache";

function encodeContactCursor(activityAt: Date, createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({
    activityTs: activityAt.toISOString(),
    createdTs: createdAt.toISOString(),
    id,
  })).toString('base64');
}

function decodeContactCursor(cursor: string): { activityTs: string; createdTs: string; id: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8'));
    if (typeof parsed.activityTs === 'string' && typeof parsed.createdTs === 'string' && typeof parsed.id === 'string') {
      if (isNaN(new Date(parsed.activityTs).getTime()) || isNaN(new Date(parsed.createdTs).getTime())) return null;
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Shared SQL projection for the Contact read model.
 * Used by getContactsPaginated and getContact to avoid copy-paste drift.
 * Dynamic per-query fields (assignedToUserId, assignedToUserName) are added
 * by callers that need them, since they reference a runtime contractorId value.
 */
const CONTACT_FIELDS = {
  id: contacts.id,
  name: contacts.name,
  emails: sql<string[]>`COALESCE(${contacts.emails}, '{}')`,
  phones: sql<string[]>`COALESCE(${contacts.phones}, '{}')`,
  address: contacts.address,
  street: contacts.street,
  city: contacts.city,
  state: contacts.state,
  zip: contacts.zip,
  type: contacts.type,
  status: contacts.status,
  source: contacts.source,
  notes: contacts.notes,
  tags: sql<string[]>`COALESCE(${contacts.tags}, '{}')`,
  followUpDate: contacts.followUpDate,
  pageUrl: contacts.pageUrl,
  utmSource: contacts.utmSource,
  utmMedium: contacts.utmMedium,
  utmCampaign: contacts.utmCampaign,
  utmTerm: contacts.utmTerm,
  utmContent: contacts.utmContent,
  isScheduled: contacts.isScheduled,
  contactedAt: contacts.contactedAt,
  housecallProCustomerId: contacts.housecallProCustomerId,
  housecallProEstimateId: contacts.housecallProEstimateId,
  scheduledAt: contacts.scheduledAt,
  scheduledEmployeeId: contacts.scheduledEmployeeId,
  normalizedPhone: contacts.normalizedPhone,
  bookingCode: contacts.bookingCode,
  contractorId: contacts.contractorId,
  createdAt: contacts.createdAt,
  updatedAt: contacts.updatedAt,
  lastActivityAt: contacts.lastActivityAt,
  hasJobs: sql<boolean>`EXISTS(SELECT 1 FROM ${jobs} WHERE ${jobs.contactId} = "contacts"."id")`,
  // State-summary booleans used by header search to render Disqualified
  // / Archived / Aged badges. Inline correlated subqueries — they reuse
  // the same indexes as the lead-board archived/aged predicates and add
  // no per-row N+1 lookups.
  allLeadsArchived: sql<boolean>`COALESCE((SELECT BOOL_AND(archived) FROM leads WHERE leads.contact_id = "contacts"."id"), false)`,
  anyLeadAged: sql<boolean>`EXISTS (SELECT 1 FROM leads WHERE leads.contact_id = "contacts"."id" AND leads.aged = true)`,
} as const;

/** Derive the 10-digit normalized phone stored in contacts.normalizedPhone from a phones array. */
function computeNormalizedPhone(phones: string[] | null | undefined): string | null {
  const first = phones?.[0];
  if (!first) return null;
  const digits = first.replace(/\D/g, '');
  return digits.length > 0 ? digits.slice(-10) : null;
}

/**
 * Escape LIKE/ILIKE metacharacters in a user-supplied search string.
 * Without escaping, a `%` in the query matches every row and `_` matches any
 * single character — both cause unexpectedly broad result sets.
 * The backslash is escaped first so that the replacements for `%` and `_`
 * are not double-escaped.
 */
function escapeLike(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/**
 * Build the Drizzle `conditions` array that is shared by all three contact
 * list queries: `getContactsPaginated`, `getContactsCount`, and
 * `getContactsStatusCounts`.
 *
 * Centralising this logic ensures that any new filter field is added once and
 * immediately applies to every caller, preventing the filter-drift bugs that
 * motivated this helper (e.g. the archived filter previously missing from
 * `getContactsCount`).
 *
 * NOTE: The cursor condition is intentionally excluded here because it is only
 * meaningful for `getContactsPaginated`; callers that need it push it
 * themselves after calling this helper.
 *
 * @param skipStatusFilter - When true, the status/includeAll filtering block is
 *   omitted entirely. Pass `true` for `getContactsStatusCounts`, which counts
 *   contacts broken down *by* status (including disqualified) in the SELECT,
 *   so pre-filtering by status would zero-out those CASE counts.
 */
export function buildContactConditions(contractorId: string, options: ContactFilterOptions, skipStatusFilter = false) {
  const conditions = [eq(contacts.contractorId, contractorId)];

  // GDPR-anonymized contacts are never surfaced — not in lists, not in
  // search. This is a hard guard that applies regardless of includeAll
  // or search-mode bypasses below.
  conditions.push(eq(contacts.anonymized, false));

  // A non-empty text search means the user is asking "does this record
  // exist anywhere?" — never silently drop matches based on pipeline
  // state (disqualified / archived / aged). Treat search-mode as if
  // includeAll were set, but ONLY for the disqualified / archived /
  // aged gates. type / date / assignedTo filters still apply if
  // explicitly set, and an explicit `status` filter is still honored.
  const isTextSearch = !!options.search?.trim();
  const bypassPipelineGates = options.includeAll || isTextSearch;

  if (options.type) {
    conditions.push(eq(contacts.type, options.type));
  }

  if (!skipStatusFilter && !bypassPipelineGates) {
    if (options.status && options.status !== 'all') {
      conditions.push(eq(contacts.status, options.status as typeof contactStatusEnum.enumValues[number]));
    } else if (!options.status || options.status === 'all') {
      if (!options.type || options.type === 'lead') {
        conditions.push(ne(contacts.status, 'disqualified'));
      }
    }
  } else if (!skipStatusFilter && bypassPipelineGates && options.status && options.status !== 'all') {
    // An explicit status filter must always pin results to that status,
    // even when pipeline-gate bypass is active for search mode.
    conditions.push(eq(contacts.status, options.status as typeof contactStatusEnum.enumValues[number]));
  }

  if (options.search) {
    const safe = escapeLike(options.search);
    // SAFE: `or()` with non-null ilike arguments always returns a non-null SQL
    // expression; `!` silences Drizzle's overly-conservative `undefined` return type.
    // The ESCAPE clause tells Postgres that `\` is our escape character, matching
    // the metacharacter-escaping applied by escapeLike().
    conditions.push(or(
      ilike(contacts.name, `%${safe}%`),
      ilike(contacts.address, `%${safe}%`),
      ilike(contacts.source, `%${safe}%`),
      sql`array_to_string(${contacts.emails}, ' ') ILIKE ${'%' + safe + '%'} ESCAPE '\\'`,
      sql`array_to_string(${contacts.phones}, ' ') ILIKE ${'%' + safe + '%'} ESCAPE '\\'`,
    )!);
  }

  if (options.assignedTo) {
    conditions.push(sql`EXISTS (SELECT 1 FROM leads WHERE leads.contact_id = "contacts"."id" AND leads.contractor_id = ${contractorId} AND leads.assigned_to_user_id = ${options.assignedTo})`);
  }

  if (options.dateFrom) {
    conditions.push(gte(contacts.lastActivityAt, new Date(options.dateFrom)));
  }

  if (options.dateTo) {
    const endOfDay = new Date(options.dateTo);
    endOfDay.setHours(23, 59, 59, 999);
    conditions.push(lte(contacts.lastActivityAt, endOfDay));
  }

  if (options.retentionFlagged) {
    conditions.push(isNotNull(contacts.retentionFlaggedAt));
    conditions.push(eq(contacts.anonymized, false));
  }

  // archived/aged filter: when archived=true, show only contacts whose leads are all archived;
  // when aged=true, show only contacts with aged leads; when both are false (default),
  // exclude contacts with only archived or aged leads.
  // This gating applies whenever aged or archived are explicitly set, or when in lead scope
  // (even with includeAll, which only skips status filtering, not archived/aged gating).
  const isLeadScope = (options.type === 'lead' || !options.type);
  const hasExplicitAgedOrArchived = options.aged !== undefined || options.archived !== undefined;
  const gateArchived = isLeadScope && (hasExplicitAgedOrArchived || !bypassPipelineGates);
  if (gateArchived) {
    if (options.aged === true) {
      conditions.push(sql`EXISTS (SELECT 1 FROM leads WHERE leads.contact_id = "contacts"."id" AND leads.contractor_id = ${contractorId} AND leads.aged = true)`);
      conditions.push(sql`NOT EXISTS (SELECT 1 FROM leads WHERE leads.contact_id = "contacts"."id" AND leads.contractor_id = ${contractorId} AND leads.aged = false AND leads.archived = false)`);
    } else if (options.archived === true) {
      conditions.push(sql`EXISTS (SELECT 1 FROM leads WHERE leads.contact_id = "contacts"."id" AND leads.contractor_id = ${contractorId} AND leads.archived = true)`);
      conditions.push(sql`NOT EXISTS (SELECT 1 FROM leads WHERE leads.contact_id = "contacts"."id" AND leads.contractor_id = ${contractorId} AND leads.archived = false)`);
    } else {
      conditions.push(sql`(NOT EXISTS (SELECT 1 FROM leads WHERE leads.contact_id = "contacts"."id" AND leads.contractor_id = ${contractorId}) OR EXISTS (SELECT 1 FROM leads WHERE leads.contact_id = "contacts"."id" AND leads.contractor_id = ${contractorId} AND leads.archived = false AND leads.aged = false))`);
    }
  }

  return conditions;
}

// Safety cap for the non-paginated getContacts call.
// This prevents runaway memory usage for large tenants.
const GET_CONTACTS_LIMIT = 2000;

/**
 * @deprecated Use {@link getContactsPaginated} for any UI or API endpoint that
 * renders contact lists. The 2,000-row hard cap ({@link GET_CONTACTS_LIMIT})
 * makes this function unsafe for large tenants.
 *
 * **Remaining callers that need all rows** (e.g. the contact deduplication service
 * in `server/services/contact-deduper.ts`) must stay on this function until the
 * dedup algorithm is migrated to a SQL-side MERGE / temp-table approach — see the
 * `DEDUP_BATCH_SIZE` comment in that file for the migration path.
 *
 * **Removal milestone**: remove this function (and its entry in {@link IStorage})
 * once `contact-deduper.ts` is rewritten to use SQL-side deduplication (planned
 * alongside the "Full SQL-side contact deduplication" work item).
 */
async function getContacts(contractorId: string, type?: 'lead' | 'customer' | 'inactive'): Promise<Contact[]> {
  const conditions = [eq(contacts.contractorId, contractorId)];
  if (type) conditions.push(eq(contacts.type, type));
  return await db.select().from(contacts).where(and(...conditions)).orderBy(desc(contacts.createdAt)).limit(GET_CONTACTS_LIMIT);
}

async function getLeadTrend(contractorId: string, since: Date): Promise<{ date: string; count: number }[]> {
  const result = await db.execute(sql`
    WITH date_series AS (
      SELECT generate_series(
        ${since.toISOString()}::timestamp::date,
        CURRENT_DATE,
        '1 day'::interval
      )::date AS day
    )
    SELECT
      TO_CHAR(d.day, 'YYYY-MM-DD') AS date,
      COALESCE(COUNT(c.id), 0)::int AS count
    FROM date_series d
    LEFT JOIN contacts c ON
      DATE(c.created_at) = d.day
      AND c.contractor_id = ${contractorId}
      AND c.type = 'lead'
    GROUP BY d.day
    ORDER BY d.day
  `);
  return result.rows as { date: string; count: number }[];
}

/**
 * Fetch contacts for a contractor using cursor-based pagination.
 *
 * Prefer this over getContacts() for any UI that renders large lists. The
 * cursor is the ISO timestamp of the last-seen record's lastActivityAt field.
 * Results are capped at 100 per page regardless of the `limit` option.
 *
 * FILTER MODES
 * ------------
 * The filter logic has four modes, applied in priority order:
 *
 *  1. includeAll: true — bypasses ALL status filtering entirely.
 *     Used by admin views (Settings, employee management) that need every
 *     contact regardless of pipeline state, including archived/disqualified.
 *
 *  2. Explicit status (status !== 'all') — shows only contacts with that
 *     exact status value. Used by status-specific tabs on the Leads page.
 *
 *  3. status === 'all' or status is omitted, WITH type === 'lead' (or no type)
 *     — excludes 'disqualified' contacts. Disqualified leads are excluded by
 *     default to keep the main lead board uncluttered; they can be surfaced
 *     explicitly via status='disqualified'.
 *
 *  4. type === 'customer' or 'inactive' with no status filter — no status
 *     exclusion is applied, since customers and inactive contacts don't have
 *     a meaningful "disqualified" state.
 *
 * CURSOR DESIGN
 * -------------
 * Pagination uses a composite cursor (lastActivityAt, createdAt) encoded as
 * base64 JSON. The keyset predicate is a Postgres row-value comparison:
 *   (last_activity_at, created_at) < (cursor_activity_ts, cursor_created_ts)
 * which is fully stable even when multiple contacts share the same
 * lastActivityAt timestamp (e.g. after bulk activity creation). Falls back
 * to a simple lastActivityAt < cursor if an old-format ISO cursor is received.
 * Backed by the contacts_contractor_activity_idx composite index on
 * (contractor_id, last_activity_at).
 */
async function getContactsPaginated(contractorId: string, options: ContactFilterOptions = {}): Promise<PaginatedContacts> {
  const limit = Math.min(options.limit || 50, 100);
  // Build shared filter conditions then append the cursor condition, which is
  // exclusive to paginated queries (not needed by count or status-counts).
  const conditions = buildContactConditions(contractorId, options);
  if (options.cursor) {
    const decoded = decodeContactCursor(options.cursor);
    if (decoded) {
      conditions.push(
        sql`(${contacts.lastActivityAt}, ${contacts.createdAt}, ${contacts.id}) < (${new Date(decoded.activityTs)}, ${new Date(decoded.createdTs)}, ${decoded.id})`
      );
    } else {
      conditions.push(lt(contacts.lastActivityAt, new Date(options.cursor)));
    }
  }

  const [contactsData, total] = await Promise.all([
    db.select({
      ...CONTACT_FIELDS,
      assignedToUserId: sql<string | null>`(SELECT l.assigned_to_user_id FROM leads l WHERE l.contact_id = "contacts"."id" AND l.contractor_id = ${contractorId} ORDER BY l.created_at DESC LIMIT 1)`,
      assignedToUserName: sql<string | null>`(SELECT u.name FROM leads l JOIN users u ON l.assigned_to_user_id = u.id WHERE l.contact_id = "contacts"."id" AND l.contractor_id = ${contractorId} ORDER BY l.created_at DESC LIMIT 1)`,
    })
    .from(contacts)
    .where(and(...conditions))
    .orderBy(
      ...(options.sortField === 'createdDate'
        ? (options.sortOrder === 'asc'
          ? [asc(contacts.createdAt), asc(contacts.id)]
          : [desc(contacts.createdAt), desc(contacts.id)])
        : (options.sortOrder === 'asc'
          ? [asc(contacts.lastActivityAt), asc(contacts.createdAt), asc(contacts.id)]
          : [desc(contacts.lastActivityAt), desc(contacts.createdAt), desc(contacts.id)]))
    )
    .limit(limit + 1)
    .offset(options.offset ?? 0),
    getContactsCount(contractorId, options),
  ]);

  const hasMore = contactsData.length > limit;
  if (hasMore) contactsData.pop();

  const lastRow = contactsData[contactsData.length - 1];
  const nextCursor = hasMore && lastRow
    ? encodeContactCursor(
        lastRow.lastActivityAt ?? lastRow.createdAt,
        lastRow.createdAt,
        lastRow.id,
      )
    : null;

  return { data: contactsData, pagination: { total, hasMore, nextCursor } };
}

async function getContactsCount(contractorId: string, options: ContactFilterOptions = {}): Promise<number> {
  const conditions = buildContactConditions(contractorId, options);
  const result = await db.select({ count: sql`count(*)` }).from(contacts).where(and(...conditions));
  return Number(result[0]?.count || 0);
}

async function getContactsStatusCounts(contractorId: string, options: Pick<ContactFilterOptions, 'search' | 'type' | 'assignedTo' | 'dateFrom' | 'dateTo' | 'archived' | 'aged'> = {}): Promise<{ all: number; new: number; contacted: number; scheduled: number; disqualified: number }> {
  // skipStatusFilter=true: status counts query enumerates ALL statuses in its
  // SELECT (including disqualified), so pre-filtering by status would zero-out
  // the disqualified CASE count and make the "all" total inconsistent.
  const baseConditions = buildContactConditions(contractorId, options, true);

  const isLeadType = !options.type || options.type === 'lead';
  const result = await db.select({
    all: isLeadType
      ? sql<number>`COUNT(CASE WHEN ${contacts.status} != 'disqualified' THEN 1 END)`
      : count(),
    new: sql<number>`COUNT(CASE WHEN ${contacts.status} = 'new' THEN 1 END)`,
    contacted: sql<number>`COUNT(CASE WHEN ${contacts.status} = 'contacted' THEN 1 END)`,
    scheduled: sql<number>`COUNT(CASE WHEN ${contacts.status} = 'scheduled' THEN 1 END)`,
    disqualified: sql<number>`COUNT(CASE WHEN ${contacts.status} = 'disqualified' THEN 1 END)`,
  }).from(contacts).where(and(...baseConditions));

  const counts = result[0];
  return {
    all: Number(counts.all),
    new: Number(counts.new),
    contacted: Number(counts.contacted),
    scheduled: Number(counts.scheduled),
    disqualified: Number(counts.disqualified),
  };
}

async function getContact(id: string, contractorId: string): Promise<Contact | undefined> {
  const result = await db.select(CONTACT_FIELDS)
    .from(contacts)
    .where(and(eq(contacts.id, id), eq(contacts.contractorId, contractorId)))
    .limit(1);
  // Drizzle infers the select result as a structural type that does not unify with the
  // generated Contact type when a computed SQL column (hasJobs) is added to the projection.
  // The cast is safe — every Contact field plus hasJobs is present in the projection above.
  return result[0] as unknown as Contact;
}

async function getContactByExternalId(externalId: string, externalSource: string, contractorId: string): Promise<Contact | undefined> {
  const result = await db.select(CONTACT_FIELDS).from(contacts).where(and(
    eq(contacts.externalId, externalId),
    eq(contacts.externalSource, externalSource),
    eq(contacts.contractorId, contractorId)
  )).limit(1);
  return result[0] as unknown as Contact;
}

async function getContactByPhone(phone: string, contractorId: string): Promise<Contact | undefined> {
  const digits = phone.replace(/\D/g, '');
  const normalized = digits.length > 0 ? digits.slice(-10) : digits;
  // Fast indexed lookup on the pre-computed normalizedPhone column.
  // Avoids the REGEXP_REPLACE full-table-scan that this query previously used.
  // normalizedPhone is populated on every createContact/updateContact call.
  const result = await db.select(CONTACT_FIELDS).from(contacts)
    .where(and(
      eq(contacts.contractorId, contractorId),
      eq(contacts.normalizedPhone, normalized),
    ))
    .limit(1);
  return result[0] as unknown as Contact;
}

async function getContactByHousecallProCustomerId(housecallProCustomerId: string, contractorId: string): Promise<Contact | undefined> {
  const result = await db.select().from(contacts).where(and(
    eq(contacts.housecallProCustomerId, housecallProCustomerId),
    eq(contacts.contractorId, contractorId)
  )).limit(1);
  return result[0];
}

async function getContactsByHousecallProCustomerIds(
  housecallProCustomerIds: string[],
  contractorId: string,
): Promise<Map<string, Contact>> {
  if (housecallProCustomerIds.length === 0) return new Map();
  const rows = await db.select().from(contacts).where(and(
    inArray(contacts.housecallProCustomerId, housecallProCustomerIds),
    eq(contacts.contractorId, contractorId)
  ));
  const result = new Map<string, Contact>();
  for (const row of rows) {
    if (row.housecallProCustomerId) result.set(row.housecallProCustomerId, row);
  }
  return result;
}

async function getContactByBookingCode(bookingCode: string, contractorId: string): Promise<Contact | undefined> {
  const result = await db.select(CONTACT_FIELDS)
    .from(contacts)
    .where(and(eq(contacts.bookingCode, bookingCode), eq(contacts.contractorId, contractorId)))
    .limit(1);
  return result[0] as unknown as Contact;
}

async function createContact(contact: Omit<InsertContact, 'contractorId'>, contractorId: string): Promise<Contact> {
  const normalizedPhones = contact.phones ? normalizePhoneArrayForStorage(contact.phones) : [];
  const bookingCode = contact.bookingCode ?? generateBookingCode();
  const now = new Date();
  const normalizedContact = {
    ...contact,
    phones: normalizedPhones,
    normalizedPhone: computeNormalizedPhone(normalizedPhones),
    bookingCode,
    lastActivityAt: now,
  };
  const result = await db.insert(contacts).values({ ...normalizedContact, contractorId }).returning();
  return result[0];
}

async function updateContact(id: string, contact: UpdateContact, contractorId: string): Promise<Contact | undefined> {
  const normalizedPhones = contact.phones ? normalizePhoneArrayForStorage(contact.phones) : undefined;
  const normalizedContact = {
    ...contact,
    ...(normalizedPhones !== undefined && {
      phones: normalizedPhones,
      normalizedPhone: computeNormalizedPhone(normalizedPhones),
    }),
  };
  const result = await db.update(contacts)
    .set({ ...normalizedContact, updatedAt: new Date() })
    .where(and(eq(contacts.id, id), eq(contacts.contractorId, contractorId)))
    .returning();
  cacheInvalidation.invalidateContact(id, contractorId);
  return result[0];
}

async function markContactContacted(contactId: string, contractorId: string, userId: string, contactedAt: Date = new Date()): Promise<Contact | undefined> {
  const result = await db.transaction(async (tx) => {
    await tx.update(contacts)
      .set({
        contactedAt,
        contactedByUserId: userId,
        updatedAt: new Date()
      })
      .where(and(
        eq(contacts.id, contactId),
        eq(contacts.contractorId, contractorId),
        sql`contacted_at IS NULL`
      ));

    const updated = await tx.update(contacts)
      .set({
        status: sql`CASE WHEN ${contacts.status} = 'new' THEN 'contacted' ELSE ${contacts.status} END`,
        updatedAt: new Date()
      })
      .where(and(
        eq(contacts.id, contactId),
        eq(contacts.contractorId, contractorId)
      ))
      .returning();

    return updated[0];
  });

  cacheInvalidation.invalidateContact(contactId, contractorId);
  return result;
}

async function deleteContact(id: string, contractorId: string): Promise<boolean> {
  const deleted = await db.transaction(async (tx) => {
    const existing = await tx.select({ id: contacts.id, housecallProCustomerId: contacts.housecallProCustomerId }).from(contacts).where(and(
      eq(contacts.id, id), eq(contacts.contractorId, contractorId)
    )).limit(1);
    if (existing.length === 0) return false;

    const hcpCustomerId = existing[0].housecallProCustomerId;

    // Delete all records associated with this contact
    await tx.delete(messages).where(and(
      eq(messages.contactId, id), eq(messages.contractorId, contractorId)
    ));
    await tx.delete(estimates).where(and(eq(estimates.contactId, id), eq(estimates.contractorId, contractorId)));
    await tx.delete(jobs).where(and(eq(jobs.contactId, id), eq(jobs.contractorId, contractorId)));
    // activities and leads cascade via FK onDelete: cascade
    const result = await tx.delete(contacts).where(and(eq(contacts.id, id), eq(contacts.contractorId, contractorId)));
    const wasDeleted = (result.rowCount ?? 0) > 0;

    if (wasDeleted && hcpCustomerId) {
      await tx.insert(hcpExcludedCustomers)
        .values({ contractorId, hcpCustomerId })
        .onConflictDoNothing();
    }

    return wasDeleted;
  });
  if (deleted) cacheInvalidation.invalidateContact(id, contractorId);
  return deleted;
}

async function unlinkOrphanedEmailActivities(contactId: string, currentEmails: string[], contractorId: string): Promise<void> {
  const emailActivities = await db.select({ id: activities.id, metadata: activities.metadata })
    .from(activities)
    .where(and(
      eq(activities.contactId, contactId),
      eq(activities.contractorId, contractorId),
      eq(activities.externalSource, 'gmail')
    ));

  if (emailActivities.length === 0) return;

  const lowerCurrentEmails = currentEmails.map(e => e.toLowerCase());
  const keepIds: string[] = [];
  for (const activity of emailActivities) {
    if (!activity.metadata) continue;
    try {
      const meta = (typeof activity.metadata === 'object' ? activity.metadata : JSON.parse(activity.metadata as string)) as Record<string, unknown>;
      const fromEmail = ((meta.from as string) || '').toLowerCase();
      const toEmails: string[] = ((meta.to as string[]) || []).map((e: string) => e.toLowerCase());
      const allEmails = [fromEmail, ...toEmails];
      if (allEmails.some(e => lowerCurrentEmails.includes(e))) {
        keepIds.push(activity.id);
      }
    } catch {
      // Skip unparseable metadata
    }
  }

  // Single bulk update instead of one per activity
  await db.update(activities)
    .set({ contactId: null })
    .where(and(
      eq(activities.contactId, contactId),
      eq(activities.contractorId, contractorId),
      eq(activities.externalSource, 'gmail'),
      keepIds.length > 0 ? notInArray(activities.id, keepIds) : sql`true`
    ));
}

async function findMatchingContact(contractorId: string, emails?: string[], phones?: string[]): Promise<string | null> {
  if (emails && emails.length > 0) {
    const lowerEmails = emails.map(e => e.toLowerCase());
    const emailResult = await db.select({ id: contacts.id }).from(contacts).where(and(
      eq(contacts.contractorId, contractorId),
      sql`EXISTS (
        SELECT 1 FROM unnest(${contacts.emails}) AS contact_email
        WHERE LOWER(contact_email) = ANY(ARRAY[${sql.join(lowerEmails.map(e => sql`${e}`), sql`, `)}]::text[])
      )`
    )).limit(1);
    if (emailResult.length > 0) return emailResult[0].id;
  }

  if (phones && phones.length > 0) {
    // Normalize the input phones to 10-digit format and query the indexed normalizedPhone
    // column directly — avoids the prior REGEXP_REPLACE full-table scan.
    const normalizedPhones = phones.map(phone => {
      const digits = phone.replace(/\D/g, '');
      return digits.length > 10 ? digits.slice(-10) : digits;
    }).filter(p => p.length > 0);

    if (normalizedPhones.length > 0) {
      const phoneResult = await db.select({ id: contacts.id }).from(contacts).where(and(
        eq(contacts.contractorId, contractorId),
        inArray(contacts.normalizedPhone, normalizedPhones)
      )).limit(1);
      if (phoneResult.length > 0) return phoneResult[0].id;
    }
  }

  return null;
}

async function getLeads(contractorId: string, includeArchived = false): Promise<Lead[]> {
  const conditions = [eq(leads.contractorId, contractorId)];
  if (!includeArchived) conditions.push(eq(leads.archived, false));
  return await db.select().from(leads).where(and(...conditions)).orderBy(desc(leads.createdAt)).limit(1000);
}

async function getLeadsByContact(contactId: string, contractorId: string): Promise<Lead[]> {
  return await db.select().from(leads).where(and(
    eq(leads.contactId, contactId),
    eq(leads.contractorId, contractorId)
  )).orderBy(desc(leads.createdAt)).limit(200);
}

async function getLead(id: string, contractorId: string): Promise<Lead | undefined> {
  const result = await db.select().from(leads).where(and(eq(leads.id, id), eq(leads.contractorId, contractorId)));
  return result[0];
}

async function getLeadByHousecallProLeadId(housecallProLeadId: string, contractorId: string): Promise<Lead | undefined> {
  const result = await db.select().from(leads).where(and(
    eq(leads.housecallProLeadId, housecallProLeadId),
    eq(leads.contractorId, contractorId)
  )).limit(1);
  return result[0];
}

async function createLead(lead: Omit<InsertLead, 'contractorId'>, contractorId: string): Promise<Lead> {
  const result = await db.insert(leads).values({ ...lead, contractorId }).returning();
  return result[0];
}

async function updateLead(id: string, lead: Partial<InsertLead>, contractorId: string): Promise<Lead | undefined> {
  const result = await db.update(leads)
    .set({ ...lead, updatedAt: new Date() })
    .where(and(eq(leads.id, id), eq(leads.contractorId, contractorId)))
    .returning();
  return result[0];
}

async function deleteLead(id: string, contractorId: string): Promise<boolean> {
  const lead = await db.select({ contactId: leads.contactId })
    .from(leads)
    .where(and(eq(leads.id, id), eq(leads.contractorId, contractorId)))
    .limit(1);

  if (lead.length === 0) return false;

  const contactId = lead[0].contactId;

  // Delete the lead row first
  const result = await db.delete(leads).where(and(eq(leads.id, id), eq(leads.contractorId, contractorId)));
  if ((result.rowCount ?? 0) === 0) return false;

  if (contactId) {
    // SINGLE-ITEM SAFE: this is called once per individual lead delete.
    // Do NOT move this call inside a loop — see maybeDeleteOrphanContact JSDoc
    // for the bulk-safe alternative.
    await maybeDeleteOrphanContact(contactId, contractorId);
  }

  return true;
}

async function archiveLead(id: string, contractorId: string): Promise<Lead | undefined> {
  const result = await db.update(leads)
    .set({ archived: true, updatedAt: new Date() })
    .where(and(eq(leads.contactId, id), eq(leads.contractorId, contractorId)))
    .returning();
  return result[0];
}

async function restoreLead(id: string, contractorId: string): Promise<Lead | undefined> {
  const result = await db.update(leads)
    .set({ archived: false, updatedAt: new Date() })
    .where(and(eq(leads.contactId, id), eq(leads.contractorId, contractorId)))
    .returning();
  return result[0];
}

async function ageLead(id: string, contractorId: string): Promise<Lead | undefined> {
  const result = await db.update(leads)
    .set({ aged: true, updatedAt: new Date() })
    .where(and(eq(leads.contactId, id), eq(leads.contractorId, contractorId)))
    .returning();
  return result[0];
}

async function unageLead(id: string, contractorId: string): Promise<Lead | undefined> {
  const result = await db.update(leads)
    .set({ aged: false, updatedAt: new Date() })
    .where(and(eq(leads.contactId, id), eq(leads.contractorId, contractorId)))
    .returning();
  return result[0];
}

// deduplicateContacts — moved to server/services/contact-deduper.ts
// Imported above and re-exported via contactMethods.deduplicateContacts below.

// getDashboardMetrics / getMetricsAggregates / MetricsAggregates — moved to
// server/services/dashboard-metrics.ts and re-imported above.
// Re-exported via contactMethods below for backward-compatibility with callers
// that access them through the storage interface.

async function getContactsWithFollowUp(contractorId: string, limit = 200): Promise<Contact[]> {
  return db.select()
    .from(contacts)
    .where(and(
      eq(contacts.contractorId, contractorId),
      isNotNull(contacts.followUpDate)
    ))
    .orderBy(contacts.followUpDate)
    // Same Drizzle inference gap as getContactWithDetails — cast is safe (all Contact fields present).
    .limit(limit) as unknown as Contact[];
}

async function bulkCreateContacts(contactList: Array<Omit<InsertContact, 'contractorId'>>, contractorId: string): Promise<{ inserted: number }> {
  if (contactList.length === 0) return { inserted: 0 };
  const now = new Date();
  const prepared = contactList.map(c => ({
    ...c,
    phones: c.phones ? normalizePhoneArrayForStorage(c.phones) : [],
    lastActivityAt: now,
    contractorId,
  }));
  const result = await db.insert(contacts).values(prepared).onConflictDoNothing().returning({ id: contacts.id });
  return { inserted: result.length };
}

async function getContactsWithCounts(contractorId: string, options: {
  search?: string;
  cursor?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<{
  data: Array<Contact & { leadCount: number; estimateCount: number; jobCount: number }>;
  pagination: { total: number; hasMore: boolean; nextCursor: string | null };
}> {
  const limit = Math.min(options.limit || 50, 100);
  const useOffset = options.offset !== undefined;
  const conditions = [eq(contacts.contractorId, contractorId)];

  if (!useOffset && options.cursor) conditions.push(lte(contacts.createdAt, new Date(options.cursor)));
  if (options.search) {
    // SAFE: `or()` with two non-null arguments always returns a non-null SQL
    // expression; `!` silences Drizzle's overly-conservative `undefined` return type.
    conditions.push(or(
      ilike(contacts.name, `%${options.search}%`),
      sql`EXISTS (SELECT 1 FROM unnest(${contacts.emails}) e WHERE e ILIKE ${`%${options.search}%`})`
    )!);
  }

  const [rows, totalResult] = await Promise.all([
    db.select({
      id: contacts.id,
      name: contacts.name,
      emails: contacts.emails,
      phones: contacts.phones,
      address: contacts.address,
      type: contacts.type,
      status: contacts.status,
      source: contacts.source,
      notes: contacts.notes,
      tags: contacts.tags,
      followUpDate: contacts.followUpDate,
      housecallProCustomerId: contacts.housecallProCustomerId,
      externalId: contacts.externalId,
      externalSource: contacts.externalSource,
      contractorId: contacts.contractorId,
      createdAt: contacts.createdAt,
      updatedAt: contacts.updatedAt,
      leadCount: sql<number>`(SELECT COUNT(*) FROM leads WHERE leads.contact_id = "contacts"."id" AND leads.contractor_id = ${contractorId})::int`,
      estimateCount: sql<number>`(SELECT COUNT(*) FROM estimates WHERE estimates.contact_id = "contacts"."id" AND estimates.contractor_id = ${contractorId})::int`,
      jobCount: sql<number>`(SELECT COUNT(*) FROM jobs WHERE jobs.contact_id = "contacts"."id" AND jobs.contractor_id = ${contractorId})::int`,
    })
    .from(contacts)
    .where(and(...conditions))
    .orderBy(desc(contacts.createdAt))
    .limit(useOffset ? limit : limit + 1)
    .offset(useOffset ? (options.offset ?? 0) : 0),

    db.select({ count: count() }).from(contacts).where(and(
      eq(contacts.contractorId, contractorId),
      // SAFE: `or()` with two non-null arguments returns a non-null SQL expression;
      // `!` silences Drizzle's overly-conservative `undefined` return type.
      options.search ? or(
        ilike(contacts.name, `%${options.search}%`),
        sql`EXISTS (SELECT 1 FROM unnest(${contacts.emails}) e WHERE e ILIKE ${`%${options.search}%`})`
      )! : sql`true`
    )),
  ]);

  const total = totalResult[0]?.count ?? 0;

  if (useOffset) {
    const currentOffset = options.offset ?? 0;
    const hasMore = currentOffset + rows.length < total;
    return {
      data: rows as Array<Contact & { leadCount: number; estimateCount: number; jobCount: number }>,
      pagination: { total, hasMore, nextCursor: null },
    };
  }

  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? data[data.length - 1].createdAt?.toISOString() ?? null : null;

  return {
    data: data as Array<Contact & { leadCount: number; estimateCount: number; jobCount: number }>,
    pagination: { total, hasMore, nextCursor },
  };
}

/**
 * Checks whether a contact has any remaining linked entities (leads, estimates, jobs).
 * If none remain, hard-deletes the contact and all its associated records.
 *
 * This is a shared helper used by deleteLead, deleteJob, and deleteEstimate to avoid
 * duplicating the three-query orphan check across all three delete paths.
 * Previously each delete path ran 3 separate EXISTS queries independently.
 *
 * Exported so jobs.ts and estimates.ts can call it after their own delete operations.
 *
 * ⚠ SINGLE-ITEM SAFETY NOTE ⚠
 * This function is designed to be called ONCE per individual delete operation
 * (one call per deleted lead/job/estimate). Each invocation issues 3 EXISTS queries
 * to the database before potentially deleting a contact.
 *
 * DO NOT call this function inside a loop over a collection of deleted items.
 * Doing so causes an N×3 query storm (N = number of items) which will be slow
 * and may trigger connection-pool exhaustion for large bulk deletions.
 *
 * BULK-SAFE ALTERNATIVE: For bulk delete operations, collect the distinct set of
 * affected contactIds FIRST, then run a single SQL query that finds which of those
 * contacts have no remaining linked entities, and finally delete them in one batch.
 * See deleteContactFull() in jobs.ts for the low-level primitive you can reuse.
 */
export async function maybeDeleteOrphanContact(contactId: string, contractorId: string): Promise<void> {
  const [remainingLeads, remainingEstimates, remainingJobs] = await Promise.all([
    db.select({ id: leads.id }).from(leads).where(and(eq(leads.contactId, contactId), eq(leads.contractorId, contractorId))).limit(1),
    db.select({ id: estimates.id }).from(estimates).where(and(eq(estimates.contactId, contactId), eq(estimates.contractorId, contractorId))).limit(1),
    db.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.contactId, contactId), eq(jobs.contractorId, contractorId))).limit(1),
  ]);
  if (remainingLeads.length === 0 && remainingEstimates.length === 0 && remainingJobs.length === 0) {
    await deleteContact(contactId, contractorId);
  }
}

/**
 * Transaction-aware variant of `maybeDeleteOrphanContact`.
 *
 * Accepts an in-progress Drizzle transaction client (`tx`) and performs the
 * orphan check and contact deletion within that transaction, avoiding a nested
 * `db.transaction()` call. Use this inside an existing `db.transaction()` block
 * (e.g. `deleteEstimate`, `deleteJob`) so that the entire deletion is atomic.
 *
 * The contact is considered an orphan when it has no remaining leads, estimates,
 * or jobs under `contractorId`. If it still has linked entities, nothing is deleted.
 *
 * Deletion order follows FK constraints: messages → estimates → jobs →
 * contact. Activities and leads cascade via `onDelete: cascade` on their FKs.
 *
 * @param tx - The active Drizzle transaction client.
 */
export async function maybeDeleteOrphanContactTx(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  contactId: string,
  contractorId: string,
): Promise<void> {
  const [remainingLeads, remainingEstimates, remainingJobs] = await Promise.all([
    tx.select({ id: leads.id }).from(leads).where(and(eq(leads.contactId, contactId), eq(leads.contractorId, contractorId))).limit(1),
    tx.select({ id: estimates.id }).from(estimates).where(and(eq(estimates.contactId, contactId), eq(estimates.contractorId, contractorId))).limit(1),
    tx.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.contactId, contactId), eq(jobs.contractorId, contractorId))).limit(1),
  ]);
  if (remainingLeads.length > 0 || remainingEstimates.length > 0 || remainingJobs.length > 0) return;

  const existing = await tx.select({ id: contacts.id, housecallProCustomerId: contacts.housecallProCustomerId })
    .from(contacts)
    .where(and(eq(contacts.id, contactId), eq(contacts.contractorId, contractorId)))
    .limit(1);
  if (existing.length === 0) return;

  const hcpCustomerId = existing[0].housecallProCustomerId;

  await tx.delete(messages).where(and(eq(messages.contactId, contactId), eq(messages.contractorId, contractorId)));
  // estimates and jobs were already deleted by the caller before reaching this point,
  // but an explicit delete is safe (idempotent) and guards against future call-site drift.
  await tx.delete(estimates).where(and(eq(estimates.contactId, contactId), eq(estimates.contractorId, contractorId)));
  await tx.delete(jobs).where(and(eq(jobs.contactId, contactId), eq(jobs.contractorId, contractorId)));
  // activities and leads cascade via FK onDelete: cascade
  await tx.delete(contacts).where(and(eq(contacts.id, contactId), eq(contacts.contractorId, contractorId)));

  if (hcpCustomerId) {
    await tx.insert(hcpExcludedCustomers)
      .values({ contractorId, hcpCustomerId })
      .onConflictDoNothing();
  }

  cacheInvalidation.invalidateContact(contactId, contractorId);
}

async function mergeContacts(
  primaryId: string,
  secondaryId: string,
  contractorId: string
): Promise<Contact> {
  const [primary, secondary] = await Promise.all([
    db.select().from(contacts).where(and(eq(contacts.id, primaryId), eq(contacts.contractorId, contractorId))).then(r => r[0]),
    db.select().from(contacts).where(and(eq(contacts.id, secondaryId), eq(contacts.contractorId, contractorId))).then(r => r[0]),
  ]);

  if (!primary || !secondary) {
    throw new Error("One or both contacts not found");
  }

  const allEmails = new Set<string>();
  const allPhones = new Set<string>();
  const allTags = new Set<string>();

  primary.emails?.forEach(e => allEmails.add(e.toLowerCase()));
  secondary.emails?.forEach(e => allEmails.add(e.toLowerCase()));
  primary.phones?.forEach(p => allPhones.add(p));
  secondary.phones?.forEach(p => allPhones.add(p));
  (primary.tags as string[] | null)?.forEach(t => allTags.add(t));
  (secondary.tags as string[] | null)?.forEach(t => allTags.add(t));

  const mergedEmails = Array.from(allEmails);
  const mergedPhones = Array.from(allPhones);
  const mergedTags = Array.from(allTags);

  return await db.transaction(async (tx) => {
    await Promise.all([
      tx.update(contacts).set({
        emails: mergedEmails,
        phones: mergedPhones,
        tags: mergedTags,
        updatedAt: new Date(),
      }).where(and(eq(contacts.id, primaryId), eq(contacts.contractorId, contractorId))),
      tx.update(leads).set({ contactId: primaryId }).where(and(eq(leads.contactId, secondaryId), eq(leads.contractorId, contractorId))),
      tx.update(messages).set({ contactId: primaryId }).where(and(eq(messages.contactId, secondaryId), eq(messages.contractorId, contractorId))),
      tx.update(activities).set({ contactId: primaryId }).where(and(eq(activities.contactId, secondaryId), eq(activities.contractorId, contractorId))),
      tx.update(estimates).set({ contactId: primaryId }).where(and(eq(estimates.contactId, secondaryId), eq(estimates.contractorId, contractorId))),
      tx.update(jobs).set({ contactId: primaryId }).where(and(eq(jobs.contactId, secondaryId), eq(jobs.contractorId, contractorId))),
    ]);

    await tx.delete(contacts).where(and(eq(contacts.id, secondaryId), eq(contacts.contractorId, contractorId)));

    const [updated] = await tx.select().from(contacts).where(eq(contacts.id, primaryId));
    return updated;
  });
}

export const contactMethods = {
  getContacts,
  getLeadTrend,
  getContactsPaginated,
  getContactsCount,
  getContactsStatusCounts,
  getContact,
  getContactByExternalId,
  getContactByPhone,
  getContactByBookingCode,
  getContactByHousecallProCustomerId,
  getContactsByHousecallProCustomerIds,
  createContact,
  bulkCreateContacts,
  updateContact,
  markContactContacted,
  deleteContact,
  unlinkOrphanedEmailActivities,
  findMatchingContact,
  getLeads,
  getLeadsByContact,
  getLead,
  getLeadByHousecallProLeadId,
  createLead,
  updateLead,
  deleteLead,
  archiveLead,
  restoreLead,
  ageLead,
  unageLead,
  deduplicateContacts,
  mergeContacts,
  getDashboardMetrics,
  getMetricsAggregates,
  getContactsWithFollowUp,
  getContactsWithCounts,
};
