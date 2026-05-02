import {
  type MediaSpend, type InsertMediaSpend,
  mediaSpend,
} from "@shared/schema";
import { db } from "../db";
import { eq, and, asc, desc } from "drizzle-orm";
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

export const mediaSpendMethods = {
  listMediaSpend,
  getMediaSpend,
  createMediaSpend,
  updateMediaSpend,
  deleteMediaSpend,
};
