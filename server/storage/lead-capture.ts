import {
  type LeadCaptureInbox, type InsertLeadCaptureInbox,
  type SenderRule,
  type SpamAuditLog, type InsertSpamAuditLog,
  leadCaptureInboxes,
  spamAuditLog,
} from "@shared/schema";
import { db } from "../db";
import { eq, and, desc, count, lt, isNull, or, isNotNull, inArray } from "drizzle-orm";
import { normalizeSenderRules } from "../utils/normalize-sender-rules";

async function getLeadCaptureInbox(contractorId: string): Promise<LeadCaptureInbox | undefined> {
  const result = await db.select().from(leadCaptureInboxes)
    .where(eq(leadCaptureInboxes.contractorId, contractorId))
    .limit(1);
  return result[0];
}

async function getAllActiveLeadCaptureInboxes(): Promise<LeadCaptureInbox[]> {
  return db.select().from(leadCaptureInboxes)
    .where(eq(leadCaptureInboxes.isActive, true));
}

async function upsertLeadCaptureInbox(inbox: InsertLeadCaptureInbox): Promise<LeadCaptureInbox> {
  // SAFE: `inbox` is a validated InsertLeadCaptureInbox. The destructuring strips
  // auto-generated columns (id, contractorId, createdAt) so they are not included in
  // the conflict-update set. Drizzle's `.onConflictDoUpdate` set type is stricter than
  // the spread shape, so `as any` silences the mismatch; the runtime object is correct.
  const { contractorId: _cid, id: _id, createdAt: _ca, ...updateFields } = inbox as any;
  const result = await db.insert(leadCaptureInboxes)
    .values(inbox as any)
    .onConflictDoUpdate({
      target: leadCaptureInboxes.contractorId,
      set: { ...updateFields, updatedAt: new Date() } as any,
    })
    .returning();
  // SAFE: `.returning()` always yields exactly one row for a successful upsert.
  return result[0]!;
}

async function deleteLeadCaptureInbox(contractorId: string): Promise<boolean> {
  const result = await db.delete(leadCaptureInboxes)
    .where(eq(leadCaptureInboxes.contractorId, contractorId));
  return (result.rowCount ?? 0) > 0;
}

async function updateLeadCaptureInboxSyncTime(contractorId: string): Promise<void> {
  await db.update(leadCaptureInboxes)
    .set({ lastSyncAt: new Date(), updatedAt: new Date() })
    .where(eq(leadCaptureInboxes.contractorId, contractorId));
}

async function updateLeadCaptureInboxSpamFilter(contractorId: string, enabled: boolean): Promise<LeadCaptureInbox | undefined> {
  const result = await db.update(leadCaptureInboxes)
    .set({ spamFilterEnabled: enabled, updatedAt: new Date() })
    .where(eq(leadCaptureInboxes.contractorId, contractorId))
    .returning();
  return result[0];
}

async function getSenderRules(contractorId: string): Promise<SenderRule[]> {
  const inbox = await getLeadCaptureInbox(contractorId);
  if (!inbox) return [];
  // SAFE: `senderRules` is stored as a JSONB column typed as `unknown` by Drizzle.
  // `normalizeSenderRules` defensively handles any shape (null, [], legacy objects)
  // so the cast is safe — incorrect data is normalized rather than crashing.
  return normalizeSenderRules(inbox.senderRules as any[]);
}

async function addSenderRule(contractorId: string, rule: SenderRule): Promise<SenderRule[]> {
  const inbox = await getLeadCaptureInbox(contractorId);
  if (!inbox) throw new Error('No lead capture inbox configured');
  // SAFE: same JSONB cast rationale as getSenderRules above.
  const existing = normalizeSenderRules(inbox.senderRules as any[]);
  const filtered = existing.filter(r => r.senderEmail.toLowerCase() !== rule.senderEmail.toLowerCase());
  const normalized = { ...rule, senderEmail: rule.senderEmail.toLowerCase(), action: undefined };
  const updated = [...filtered, normalized];
  await db.update(leadCaptureInboxes)
    .set({ senderRules: updated, updatedAt: new Date() })
    .where(eq(leadCaptureInboxes.contractorId, contractorId));
  return updated;
}

async function deleteSenderRule(contractorId: string, senderEmail: string): Promise<SenderRule[]> {
  const inbox = await getLeadCaptureInbox(contractorId);
  if (!inbox) throw new Error('No lead capture inbox configured');
  // SAFE: same JSONB cast rationale as getSenderRules above.
  const existing = normalizeSenderRules(inbox.senderRules as any[]);
  const updated = existing.filter(r => r.senderEmail.toLowerCase() !== senderEmail.toLowerCase());
  await db.update(leadCaptureInboxes)
    .set({ senderRules: updated, updatedAt: new Date() })
    .where(eq(leadCaptureInboxes.contractorId, contractorId));
  return updated;
}

async function updateSpamConfidenceThreshold(contractorId: string, threshold: number): Promise<LeadCaptureInbox | undefined> {
  const result = await db.update(leadCaptureInboxes)
    .set({ spamConfidenceThreshold: threshold, updatedAt: new Date() })
    .where(eq(leadCaptureInboxes.contractorId, contractorId))
    .returning();
  return result[0];
}

async function createSpamAuditEntry(entry: InsertSpamAuditLog): Promise<SpamAuditLog> {
  const result = await db.insert(spamAuditLog)
    .values(entry)
    .returning();
  return result[0]!;
}

async function getSpamAuditLog(contractorId: string, limit = 50, offset = 0): Promise<{ entries: SpamAuditLog[]; total: number }> {
  const entries = await db.select().from(spamAuditLog)
    .where(eq(spamAuditLog.contractorId, contractorId))
    .orderBy(desc(spamAuditLog.flaggedAt))
    .limit(limit)
    .offset(offset);

  const countResult = await db.select({ total: count() }).from(spamAuditLog)
    .where(eq(spamAuditLog.contractorId, contractorId));
  const total = Number(countResult[0]?.total ?? 0);

  return { entries, total };
}

async function getSpamAuditEntry(id: string, contractorId: string): Promise<SpamAuditLog | undefined> {
  const result = await db.select().from(spamAuditLog)
    .where(and(eq(spamAuditLog.id, id), eq(spamAuditLog.contractorId, contractorId)))
    .limit(1);
  return result[0];
}

async function markSpamAuditRecovered(id: string, contractorId: string, leadId: string): Promise<SpamAuditLog | undefined> {
  const result = await db.update(spamAuditLog)
    .set({ recoveredAt: new Date(), recoveredLeadId: leadId })
    .where(and(eq(spamAuditLog.id, id), eq(spamAuditLog.contractorId, contractorId)))
    .returning();
  return result[0];
}

const PRUNE_BATCH_SIZE = 500;

async function pruneSpamAuditLog(contractorId: string, cutoff: Date): Promise<number> {
  let totalDeleted = 0;
  while (true) {
    const batch = await db.select({ id: spamAuditLog.id })
      .from(spamAuditLog)
      .where(
        and(
          eq(spamAuditLog.contractorId, contractorId),
          or(
            and(isNull(spamAuditLog.recoveredAt), lt(spamAuditLog.flaggedAt, cutoff)),
            and(isNotNull(spamAuditLog.recoveredAt), lt(spamAuditLog.recoveredAt, cutoff))
          )
        )
      )
      .limit(PRUNE_BATCH_SIZE);

    if (batch.length === 0) break;

    const ids = batch.map(r => r.id);
    await db.delete(spamAuditLog).where(
      and(eq(spamAuditLog.contractorId, contractorId), inArray(spamAuditLog.id, ids))
    );
    totalDeleted += ids.length;
    if (ids.length < PRUNE_BATCH_SIZE) break;
  }
  return totalDeleted;
}

async function deleteSpamAuditLogEntry(contractorId: string, entryId: string): Promise<number> {
  const result = await db.delete(spamAuditLog).where(
    and(eq(spamAuditLog.id, entryId), eq(spamAuditLog.contractorId, contractorId))
  );
  return result.rowCount ?? 0;
}

async function deleteAllUnrecoveredSpamAuditLog(contractorId: string): Promise<number> {
  let totalDeleted = 0;
  while (true) {
    const batch = await db.select({ id: spamAuditLog.id })
      .from(spamAuditLog)
      .where(
        and(
          eq(spamAuditLog.contractorId, contractorId),
          isNull(spamAuditLog.recoveredAt)
        )
      )
      .limit(PRUNE_BATCH_SIZE);

    if (batch.length === 0) break;

    const ids = batch.map(r => r.id);
    await db.delete(spamAuditLog).where(
      and(eq(spamAuditLog.contractorId, contractorId), inArray(spamAuditLog.id, ids))
    );
    totalDeleted += ids.length;
    if (ids.length < PRUNE_BATCH_SIZE) break;
  }
  return totalDeleted;
}

export const leadCaptureMethods = {
  getLeadCaptureInbox,
  getAllActiveLeadCaptureInboxes,
  upsertLeadCaptureInbox,
  deleteLeadCaptureInbox,
  updateLeadCaptureInboxSyncTime,
  updateLeadCaptureInboxSpamFilter,
  updateSpamConfidenceThreshold,
  getSenderRules,
  addSenderRule,
  deleteSenderRule,
  createSpamAuditEntry,
  getSpamAuditLog,
  getSpamAuditEntry,
  markSpamAuditRecovered,
  pruneSpamAuditLog,
  deleteSpamAuditLogEntry,
  deleteAllUnrecoveredSpamAuditLog,
};
