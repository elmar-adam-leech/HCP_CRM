import {
  type MediaSpend, type InsertMediaSpend,
  mediaSpend,
} from "@shared/schema";
import { db } from "../db";
import { eq, and, asc, desc, sql, isNotNull } from "drizzle-orm";
import type { UpdateMediaSpend } from "../storage-types";
import { invalidateReportsCache } from "../services/report-cache";

async function listMediaSpend(contractorId: string): Promise<MediaSpend[]> {
  return await db
    .select()
    .from(mediaSpend)
    .where(eq(mediaSpend.contractorId, contractorId))
    .orderBy(desc(mediaSpend.month), asc(mediaSpend.platform));
}

async function getMediaSpend(id: string, contractorId: string): Promise<MediaSpend | undefined> {
  const result = await db
    .select()
    .from(mediaSpend)
    .where(and(eq(mediaSpend.id, id), eq(mediaSpend.contractorId, contractorId)))
    .limit(1);
  return result[0];
}

async function createMediaSpend(
  entry: Omit<InsertMediaSpend, "contractorId">,
  contractorId: string,
  userId?: string,
): Promise<MediaSpend> {
  const result = await db
    .insert(mediaSpend)
    .values({
      ...entry,
      contractorId,
      createdByUserId: userId,
      updatedByUserId: userId,
    })
    .returning();
  invalidateReportsCache(contractorId);
  return result[0];
}

async function updateMediaSpend(
  id: string,
  contractorId: string,
  patch: UpdateMediaSpend,
  userId?: string,
): Promise<MediaSpend | undefined> {
  const result = await db
    .update(mediaSpend)
    .set({
      ...patch,
      updatedByUserId: userId,
      updatedAt: new Date(),
    })
    .where(and(eq(mediaSpend.id, id), eq(mediaSpend.contractorId, contractorId)))
    .returning();
  if (result[0]) invalidateReportsCache(contractorId);
  return result[0];
}

async function deleteMediaSpend(id: string, contractorId: string): Promise<boolean> {
  const result = await db
    .delete(mediaSpend)
    .where(and(eq(mediaSpend.id, id), eq(mediaSpend.contractorId, contractorId)))
    .returning();
  if (result.length > 0) invalidateReportsCache(contractorId);
  return result.length > 0;
}

async function upsertAutoSyncedSpend(params: {
  contractorId: string;
  platform: string;
  month: string; // YYYY-MM-DD
  amount: string;
  source: "facebook_ads" | "google_ads";
  externalAccountId: string;
}): Promise<MediaSpend | null> {
  const { contractorId, platform, month, amount, source, externalAccountId } = params;
  const now = new Date();
  const result = await db
    .insert(mediaSpend)
    .values({
      contractorId,
      platform,
      month,
      amount,
      source,
      externalAccountId,
      lastSyncedAt: now,
    })
    .onConflictDoUpdate({
      target: [mediaSpend.contractorId, mediaSpend.platform, mediaSpend.month],
      set: {
        amount,
        externalAccountId,
        lastSyncedAt: now,
        updatedAt: now,
      },
      setWhere: sql`${mediaSpend.source} = ${source}`,
    })
    .returning();
  if (result[0]) {
    invalidateReportsCache(contractorId);
    return result[0];
  }
  return null;
}

async function listContractorsWithAutoSpend(source: "facebook_ads" | "google_ads"): Promise<string[]> {
  const rows = await db
    .selectDistinct({ contractorId: mediaSpend.contractorId })
    .from(mediaSpend)
    .where(eq(mediaSpend.source, source));
  return rows.map((r) => r.contractorId);
}

async function getLastSyncedAt(
  contractorId: string,
  source: "facebook_ads" | "google_ads",
): Promise<Date | null> {
  const rows = await db
    .select({ lastSyncedAt: mediaSpend.lastSyncedAt })
    .from(mediaSpend)
    .where(and(
      eq(mediaSpend.contractorId, contractorId),
      eq(mediaSpend.source, source),
      isNotNull(mediaSpend.lastSyncedAt),
    ))
    .orderBy(desc(mediaSpend.lastSyncedAt))
    .limit(1);
  return rows[0]?.lastSyncedAt ?? null;
}

export const mediaSpendMethods = {
  listMediaSpend,
  getMediaSpend,
  createMediaSpend,
  updateMediaSpend,
  deleteMediaSpend,
  upsertAutoSyncedSpend,
  listContractorsWithAutoSpend,
  getLastSyncedAt,
};
