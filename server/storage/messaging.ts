import {
  type Message, type InsertMessage,
  messages, activities, contacts, users,
} from "@shared/schema";
import { db } from "../db";
import { eq, and, ne, desc, inArray, like, sql } from "drizzle-orm";
import { emailActivityToMessage } from "../utils/message-transform";

// Row limits for non-paginated queries. These prevent runaway memory usage on
// large tenants and act as a safety valve. Each is accompanied by a note on
// where to add cursor-based pagination if the limit becomes a bottleneck.
//
// TODO: Replace conversation queries with cursor-based pagination when
// individual tenant message volumes reliably exceed these thresholds.
const CONVERSATION_MESSAGE_LIMIT = 500;  // per conversation view
const CONVERSATIONS_PAGE_LIMIT = 50;     // max conversations shown on the list page

async function getMessages(contractorId: string, contactId?: string, estimateId?: string): Promise<Message[]> {
  const conditions = [eq(messages.contractorId, contractorId), ne(messages.status, 'failed')];
  if (contactId) conditions.push(eq(messages.contactId, contactId));
  if (estimateId) conditions.push(eq(messages.estimateId, estimateId));
  return await db.select().from(messages)
    .where(and(...conditions))
    .orderBy(desc(messages.createdAt))
    .limit(200);
}

async function getMessage(id: string, contractorId: string): Promise<Message | undefined> {
  const result = await db.select().from(messages).where(and(
    eq(messages.id, id),
    eq(messages.contractorId, contractorId)
  )).limit(1);
  return result[0];
}

async function createMessage(message: Omit<InsertMessage, 'contractorId'>, contractorId: string): Promise<Message> {
  const result = await db.insert(messages).values({ ...message, contractorId }).returning();
  return result[0];
}

async function getAllMessages(contractorId: string, options: {
  type?: 'text' | 'email';
  status?: 'sent' | 'delivered' | 'failed';
  search?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<Message[]> {
  const conditions = [eq(messages.contractorId, contractorId)];
  if (options.type) conditions.push(eq(messages.type, options.type));
  if (options.status) conditions.push(eq(messages.status, options.status));
  if (options.search) {
    conditions.push(like(sql`lower(${messages.content})`, `%${options.search.toLowerCase()}%`));
  }
  return await db.select().from(messages).where(and(...conditions))
    .orderBy(desc(messages.createdAt))
    .limit(options.limit || 50)
    .offset(options.offset || 0);
}

// DONE (scale refactored 2026): getConversations now uses a single DB-side UNION ALL
// query to discover the top N conversations, replacing the old approach of fetching up
// to 2000 rows (500 SMS + 500 email × 2 code paths) and merging them in-memory.
//
// Architecture:
//   1. UNION ALL SQL — groups messages + email-activities by contact_id, returning
//      MAX(created_at) per contact. Postgres returns at most CONVERSATIONS_PAGE_LIMIT
//      rows over the wire. The existing contractor_contact_created index covers both branches.
//   2. Two Drizzle ORM batch queries (inArray on the ≤50 contact_ids) fetch the recent
//      messages for last-message preview. Results are already ordered DESC, so Node just
//      picks the first occurrence per contactId in a single O(n) pass.
//   3. One contact info lookup (inArray).
//   = 4 DB round-trips total, O(CONVERSATIONS_PAGE_LIMIT) rows over the wire for step 1.
//
// LONG TERM: Introduce a denormalized `conversations` table (one row per contractor_id +
// contact_id with last_message_at and unread_count) updated by triggers or background
// jobs. The list page then reads only that table (tiny scan). See SendBird / Twilio
// Conversations for reference implementations.
async function getConversations(contractorId: string, options: {
  search?: string;
  type?: 'text' | 'email';
  status?: 'sent' | 'delivered' | 'failed';
  dateFrom?: Date;
  dateTo?: Date;
  unreadOnly?: boolean;
} = {}): Promise<Array<{
  contactId: string;
  contactName: string;
  contactPhone?: string;
  contactEmail?: string;
  lastMessage: Message;
  unreadCount: number;
  totalMessages: number;
}>> {
  const { search, type, status, dateFrom, dateTo, unreadOnly } = options;

  // Compute inclusive upper bound: end of the dateTo day (23:59:59.999)
  const dateToInclusive = dateTo
    ? new Date(dateTo.getTime() + 24 * 60 * 60 * 1000 - 1)
    : undefined;

  // Build each UNION branch with its WHERE conditions. Skip a branch entirely
  // when the type filter makes it irrelevant (emit a no-row placeholder).
  // NOTE: date filters are NOT applied here — they are applied in the outer query
  // on the computed per-contact MAX(last_ts) so that we filter by "lastMessageAt",
  // not by whether any individual message falls in the range.
  const smsBranch = type === 'email'
    ? sql`SELECT NULL::varchar AS contact_id, NULL::timestamptz AS last_ts WHERE FALSE`
    : sql`SELECT contact_id, MAX(created_at) AS last_ts FROM messages WHERE contractor_id = ${contractorId} AND contact_id IS NOT NULL ${status ? sql`AND status = ${status}` : sql``} ${search ? sql`AND lower(content) LIKE ${`%${search.toLowerCase()}%`}` : sql``} GROUP BY contact_id`;

  const emailBranch = type === 'text'
    ? sql`SELECT NULL::varchar AS contact_id, NULL::timestamptz AS last_ts WHERE FALSE`
    : sql`SELECT contact_id, MAX(created_at) AS last_ts FROM activities WHERE contractor_id = ${contractorId} AND type = 'email' AND contact_id IS NOT NULL ${search ? sql`AND lower(content) LIKE ${`%${search.toLowerCase()}%`}` : sql``} GROUP BY contact_id`;

  // When unreadOnly is true, restrict to contacts that have unread inbound messages
  const unreadFilter = unreadOnly
    ? sql`AND contact_id IN (
        SELECT contact_id FROM messages
          WHERE contractor_id = ${contractorId}
            AND direction = 'inbound'
            AND read_at IS NULL
            AND contact_id IS NOT NULL
        UNION
        SELECT contact_id FROM activities
          WHERE contractor_id = ${contractorId}
            AND type = 'email'
            AND read_at IS NULL
            AND contact_id IS NOT NULL
            AND (metadata::jsonb)->>'direction' = 'inbound'
      )`
    : sql``;

  // Single DB round-trip: find the top N contacts by most recent activity.
  // Date range predicates are applied on the outer MAX(last_ts) so that we only
  // return conversations whose *latest* message falls within the selected range.
  // For the "All" view, exclude contacts where every lead is archived AND the
  // contact has no estimates or jobs. The Unread view skips this exclusion so
  // inbound messages from archived/lead-less contacts still surface.
  const archivedExclusion = unreadOnly
    ? sql``
    : sql`AND NOT (
        EXISTS (SELECT 1 FROM leads WHERE leads.contact_id = combined.contact_id AND leads.contractor_id = ${contractorId} AND leads.archived = true)
        AND NOT EXISTS (SELECT 1 FROM leads WHERE leads.contact_id = combined.contact_id AND leads.contractor_id = ${contractorId} AND leads.archived = false)
        AND NOT EXISTS (SELECT 1 FROM estimates WHERE estimates.contact_id = combined.contact_id AND estimates.contractor_id = ${contractorId})
        AND NOT EXISTS (SELECT 1 FROM jobs WHERE jobs.contact_id = combined.contact_id AND jobs.contractor_id = ${contractorId})
      )`;
  type TopConvRow = { contact_id: string; last_ts: string };
  const topConvResult = await db.execute<TopConvRow>(sql`
    SELECT contact_id, MAX(last_ts) AS last_ts
    FROM (${smsBranch} UNION ALL ${emailBranch}) combined
    WHERE contact_id IS NOT NULL
      ${unreadFilter}
      ${archivedExclusion}
    GROUP BY contact_id
    HAVING TRUE ${dateFrom ? sql`AND MAX(last_ts) >= ${dateFrom.toISOString()}` : sql``} ${dateToInclusive ? sql`AND MAX(last_ts) <= ${dateToInclusive.toISOString()}` : sql``}
    ORDER BY last_ts DESC
    ${unreadOnly ? sql`` : sql`LIMIT ${CONVERSATIONS_PAGE_LIMIT}`}
  `);

  const topContactIds = topConvResult.rows.map((r) => r.contact_id);
  if (topContactIds.length === 0) return [];

  // Batch-fetch recent messages for the top contacts. Rows are already sorted
  // DESC so the first row per contactId is the most recent message.
  // Bounded by inArray(≤50 contactIds) × CONVERSATION_MESSAGE_LIMIT.
  const [smsRows, emailActivityRows, contactRows] = await Promise.all([
    type === 'email' ? Promise.resolve([]) :
      db.select({
        id: messages.id, type: messages.type, status: messages.status,
        direction: messages.direction, content: messages.content,
        toNumber: messages.toNumber, fromNumber: messages.fromNumber,
        contactId: messages.contactId, estimateId: messages.estimateId,
        userId: messages.userId, externalMessageId: messages.externalMessageId,
        contractorId: messages.contractorId, createdAt: messages.createdAt,
        readAt: messages.readAt,
        userName: users.name,
      })
      .from(messages)
      .leftJoin(users, eq(messages.userId, users.id))
      .where(and(eq(messages.contractorId, contractorId), inArray(messages.contactId, topContactIds)))
      .orderBy(desc(messages.createdAt))
      .limit(CONVERSATION_MESSAGE_LIMIT),

    type === 'text' ? Promise.resolve([]) :
      db.select({
        id: activities.id, content: activities.content,
        contactId: activities.contactId, estimateId: activities.estimateId,
        userId: activities.userId, contractorId: activities.contractorId,
        createdAt: activities.createdAt, metadata: activities.metadata,
        title: activities.title, userName: users.name,
      })
      .from(activities)
      .leftJoin(users, eq(activities.userId, users.id))
      .where(and(
        eq(activities.contractorId, contractorId),
        eq(activities.type, 'email'),
        inArray(activities.contactId, topContactIds),
      ))
      .orderBy(desc(activities.createdAt))
      .limit(CONVERSATION_MESSAGE_LIMIT),

    db.select({ id: contacts.id, name: contacts.name, phones: contacts.phones, emails: contacts.emails })
      .from(contacts)
      .where(and(inArray(contacts.id, topContactIds), eq(contacts.contractorId, contractorId))),
  ]);

  // O(n) pass: pick the first (most recent) message per contactId.
  const lastSmsPerContact = new Map<string, Message>();
  for (const row of smsRows) {
    if (row.contactId && !lastSmsPerContact.has(row.contactId)) {
      lastSmsPerContact.set(row.contactId, row as Message);
    }
  }

  const lastEmailPerContact = new Map<string, Message>();
  for (const row of emailActivityRows) {
    if (row.contactId && !lastEmailPerContact.has(row.contactId)) {
      lastEmailPerContact.set(row.contactId, emailActivityToMessage(row as Parameters<typeof emailActivityToMessage>[0]));
    }
  }

  const contactLookup = new Map(contactRows.map((c) => [c.id, c]));

  // Build result in the sort order determined by the UNION query (most recent first).
  const conversations: Array<{
    contactId: string; contactName: string; contactPhone?: string;
    contactEmail?: string; lastMessage: Message; unreadCount: number; totalMessages: number;
  }> = [];

  for (const { contact_id } of topConvResult.rows) {
    const contact = contactLookup.get(contact_id);
    const lastSms = lastSmsPerContact.get(contact_id);
    const lastEmail = lastEmailPerContact.get(contact_id);

    const candidates = [lastSms, lastEmail].filter((m): m is Message => m !== undefined);
    if (candidates.length === 0) continue;

    const lastMessage = candidates.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    )[0];

    conversations.push({
      contactId: contact_id,
      contactName: contact?.name ?? 'Unknown',
      contactPhone: contact?.phones?.[0] ?? undefined,
      contactEmail: contact?.emails?.[0] ?? undefined,
      lastMessage,
      unreadCount: 0,
      totalMessages: (lastSms ? 1 : 0) + (lastEmail ? 1 : 0),
    });
  }

  if (conversations.length > 0) {
    const contactIdsForUnread = conversations.map(c => c.contactId);
    type UnreadRow = { contact_id: string; unread_count: string };
    const idList = sql`(${sql.join(contactIdsForUnread.map(id => sql`${id}`), sql`, `)})`;
    const unreadResult = await db.execute<UnreadRow>(sql`
      SELECT contact_id, SUM(cnt)::text AS unread_count FROM (
        SELECT contact_id, COUNT(*)::int AS cnt
        FROM messages
        WHERE contractor_id = ${contractorId}
          AND contact_id IN ${idList}
          AND direction = 'inbound'
          AND read_at IS NULL
        GROUP BY contact_id
        UNION ALL
        SELECT contact_id, COUNT(*)::int AS cnt
        FROM activities
        WHERE contractor_id = ${contractorId}
          AND contact_id IN ${idList}
          AND type = 'email'
          AND read_at IS NULL
          AND (metadata::jsonb)->>'direction' = 'inbound'
        GROUP BY contact_id
      ) combined
      GROUP BY contact_id
    `);
    const unreadMap = new Map(unreadResult.rows.map(r => [r.contact_id, parseInt(r.unread_count, 10)]));
    for (const conv of conversations) {
      conv.unreadCount = unreadMap.get(conv.contactId) || 0;
    }
  }

  return conversations;
}

async function markConversationRead(contractorId: string, contactId: string, messageType?: 'text' | 'email'): Promise<number> {
  let total = 0;

  // SMS unread state lives in messages.read_at.
  if (!messageType || messageType === 'text') {
    const smsResult = await db.execute<{ id: string }>(sql`
      UPDATE messages SET read_at = NOW()
      WHERE contractor_id = ${contractorId}
        AND contact_id = ${contactId}
        AND direction = 'inbound'
        AND read_at IS NULL
        ${messageType === 'text' ? sql`AND type = 'text'` : sql``}
      RETURNING id
    `);
    total += smsResult.rows.length;
  }

  // Email unread state lives in activities.read_at (inbound emails only).
  if (!messageType || messageType === 'email') {
    const emailResult = await db.execute<{ id: string }>(sql`
      UPDATE activities SET read_at = NOW()
      WHERE contractor_id = ${contractorId}
        AND contact_id = ${contactId}
        AND type = 'email'
        AND read_at IS NULL
        AND (metadata::jsonb)->>'direction' = 'inbound'
      RETURNING id
    `);
    total += emailResult.rows.length;
  }

  return total;
}

async function getUnreadMessageCount(contractorId: string): Promise<number> {
  // Distinct contacts with at least one unread inbound SMS or email.
  // No archived-lead exclusion here: an unread inbound message should always
  // count, regardless of whether the sender's only lead is archived.
  const result = await db.execute<{ count: string }>(sql`
    WITH unread_contacts AS (
      SELECT contact_id FROM messages
      WHERE contractor_id = ${contractorId}
        AND direction = 'inbound'
        AND read_at IS NULL
        AND contact_id IS NOT NULL
      UNION
      SELECT contact_id FROM activities
      WHERE contractor_id = ${contractorId}
        AND type = 'email'
        AND read_at IS NULL
        AND contact_id IS NOT NULL
        AND (metadata::jsonb)->>'direction' = 'inbound'
    )
    SELECT COUNT(*)::text AS count FROM unread_contacts
  `);
  return parseInt(result.rows[0]?.count || '0', 10);
}

async function getConversationMessages(contractorId: string, contactId: string): Promise<Message[]> {
  const contact = await db.select({ phones: contacts.phones, emails: contacts.emails })
    .from(contacts).where(and(eq(contacts.id, contactId), eq(contacts.contractorId, contractorId))).limit(1);

  const _contactPhones: string[] = contact[0]?.phones || [];
  void _contactPhones;
  const _contactEmails: string[] = contact[0]?.emails || [];
  void _contactEmails;

  const [smsMessages, emailActivities] = await Promise.all([
    db.select({
      id: messages.id, type: messages.type, status: messages.status, direction: messages.direction,
      content: messages.content, toNumber: messages.toNumber, fromNumber: messages.fromNumber,
      contactId: messages.contactId, estimateId: messages.estimateId, userId: messages.userId,
      externalMessageId: messages.externalMessageId, contractorId: messages.contractorId,
      createdAt: messages.createdAt, readAt: messages.readAt, userName: users.name,
    }).from(messages).leftJoin(users, eq(messages.userId, users.id))
      .where(and(eq(messages.contractorId, contractorId), eq(messages.contactId, contactId), ne(messages.status, 'failed')))
      .orderBy(desc(messages.createdAt))
      .limit(CONVERSATION_MESSAGE_LIMIT),
    db.select({
      id: activities.id, content: activities.content, contactId: activities.contactId,
      estimateId: activities.estimateId, userId: activities.userId, contractorId: activities.contractorId,
      createdAt: activities.createdAt, metadata: activities.metadata, title: activities.title, userName: users.name,
    }).from(activities).leftJoin(users, eq(activities.userId, users.id))
      .where(and(eq(activities.contractorId, contractorId), eq(activities.type, 'email'), eq(activities.contactId, contactId)))
      .orderBy(desc(activities.createdAt))
      .limit(CONVERSATION_MESSAGE_LIMIT),
  ]);

  const emailMessages = emailActivities.map(emailActivityToMessage);

  const allMessages = [...smsMessages, ...emailMessages as Message[]];
  allMessages.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  return allMessages;
}

async function getConversationMessageCount(contractorId: string, contactId: string): Promise<number> {
  const [smsResult, emailResult] = await Promise.all([
    db.select({ count: sql<number>`count(*)::int` }).from(messages)
      .where(and(eq(messages.contractorId, contractorId), eq(messages.contactId, contactId))),
    db.select({ count: sql<number>`count(*)::int` }).from(activities)
      .where(and(eq(activities.contractorId, contractorId), eq(activities.type, 'email'), eq(activities.contactId, contactId))),
  ]);
  return (smsResult[0]?.count || 0) + (emailResult[0]?.count || 0);
}

async function getUnreadMessageSummary(contractorId: string): Promise<{ messages: boolean; leads: boolean; estimates: boolean }> {
  // UNION the SMS unread source (messages) with the email unread source
  // (activities) so the sidebar dot lights up for either channel.
  const result = await db.execute<{ has_lead: boolean; has_estimate: boolean }>(sql`
    WITH unread_contacts AS (
      SELECT contact_id FROM messages
      WHERE contractor_id = ${contractorId}
        AND direction = 'inbound'
        AND read_at IS NULL
        AND contact_id IS NOT NULL
      UNION
      SELECT contact_id FROM activities
      WHERE contractor_id = ${contractorId}
        AND type = 'email'
        AND read_at IS NULL
        AND contact_id IS NOT NULL
        AND (metadata::jsonb)->>'direction' = 'inbound'
    )
    SELECT
      EXISTS (SELECT 1 FROM leads WHERE leads.contact_id = u.contact_id AND leads.contractor_id = ${contractorId} AND leads.archived = false) AS has_lead,
      EXISTS (SELECT 1 FROM estimates WHERE estimates.contact_id = u.contact_id AND estimates.contractor_id = ${contractorId}) AS has_estimate
    FROM unread_contacts u
  `);

  let messages = false;
  let leads = false;
  let estimates = false;
  for (const row of result.rows) {
    messages = true;
    if (row.has_lead) leads = true;
    if (row.has_estimate) estimates = true;
    if (leads && estimates) break;
  }
  return { messages, leads, estimates };
}

async function getUnreadCountsByContactIds(
  contractorId: string,
  contactIds: string[]
): Promise<Record<string, { text: number; email: number }>> {
  if (contactIds.length === 0) return {};

  // UNION inbound-unread SMS (messages.read_at) with inbound-unread emails
  // (activities.read_at). The 'type' column is the channel label expected by
  // the frontend ({text, email}).
  const idList = sql`(${sql.join(contactIds.map(id => sql`${id}`), sql`, `)})`;
  type UnreadRow = { contact_id: string; type: string; cnt: string };
  const result = await db.execute<UnreadRow>(sql`
    SELECT contact_id, type, SUM(cnt)::text AS cnt FROM (
      SELECT contact_id, type::text AS type, COUNT(*)::int AS cnt
      FROM messages
      WHERE contractor_id = ${contractorId}
        AND contact_id IN ${idList}
        AND direction = 'inbound'
        AND read_at IS NULL
      GROUP BY contact_id, type
      UNION ALL
      SELECT contact_id, 'email' AS type, COUNT(*)::int AS cnt
      FROM activities
      WHERE contractor_id = ${contractorId}
        AND contact_id IN ${idList}
        AND type = 'email'
        AND read_at IS NULL
        AND (metadata::jsonb)->>'direction' = 'inbound'
      GROUP BY contact_id
    ) combined
    GROUP BY contact_id, type
  `);

  const counts: Record<string, { text: number; email: number }> = {};
  for (const row of result.rows) {
    if (!counts[row.contact_id]) {
      counts[row.contact_id] = { text: 0, email: 0 };
    }
    if (row.type === 'text') {
      counts[row.contact_id].text = parseInt(row.cnt, 10);
    } else if (row.type === 'email') {
      counts[row.contact_id].email = parseInt(row.cnt, 10);
    }
  }
  return counts;
}

export const messagingMethods = {
  getMessages,
  getMessage,
  createMessage,
  getAllMessages,
  getConversations,
  getConversationMessages,
  getConversationMessageCount,
  markConversationRead,
  getUnreadMessageCount,
  getUnreadMessageSummary,
  getUnreadCountsByContactIds,
};
