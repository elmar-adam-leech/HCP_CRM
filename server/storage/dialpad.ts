import {
  type DialpadPhoneNumber, type InsertDialpadPhoneNumber,
  type UserPhoneNumberPermission, type InsertUserPhoneNumberPermission,
  type DialpadUser, type InsertDialpadUser,
  type DialpadDepartment, type InsertDialpadDepartment,
  type DialpadSyncJob, type InsertDialpadSyncJob,
  type SyncSchedule, type InsertSyncSchedule,
  dialpadPhoneNumbers, userPhoneNumberPermissions, dialpadUsers, dialpadDepartments,
  dialpadSyncJobs, syncSchedules,
} from "@shared/schema";
import { db } from "../db";
import { eq, and, asc, desc, lte, inArray } from "drizzle-orm";
import { normalizePhoneNumber } from "../utils/phone-normalizer";
import type {
  UpdateDialpadPhoneNumber,
  UpdateUserPhoneNumberPermission,
  UpdateDialpadUser,
  UpdateDialpadDepartment,
  UpdateDialpadSyncJob,
  UpdateSyncSchedule,
} from "../storage-types";

// Dialpad phone number operations
async function getDialpadPhoneNumbers(contractorId: string): Promise<DialpadPhoneNumber[]> {
  return await db.select().from(dialpadPhoneNumbers).where(eq(dialpadPhoneNumbers.contractorId, contractorId)).orderBy(asc(dialpadPhoneNumbers.phoneNumber)).limit(200);
}

async function getDialpadPhoneNumber(id: string, contractorId: string): Promise<DialpadPhoneNumber | undefined> {
  const result = await db.select().from(dialpadPhoneNumbers).where(and(eq(dialpadPhoneNumbers.id, id), eq(dialpadPhoneNumbers.contractorId, contractorId))).limit(1);
  return result[0];
}

async function getDialpadPhoneNumberByNumber(contractorId: string, phoneNumber: string): Promise<DialpadPhoneNumber | undefined> {
  // Fast path: exact match on the stored value.
  const direct = await db.select().from(dialpadPhoneNumbers)
    .where(and(eq(dialpadPhoneNumbers.contractorId, contractorId), eq(dialpadPhoneNumbers.phoneNumber, phoneNumber)))
    .limit(1);
  if (direct[0]) return direct[0];

  // Fallback: numbers may be stored in different formats (E.164 from Dialpad
  // sync vs. display format like "(443) 247-5467" from older inserts). Compare
  // normalized values so the lookup is format-agnostic.
  const target = normalizePhoneNumber(phoneNumber);
  if (!target) return undefined;
  const all = await db.select().from(dialpadPhoneNumbers)
    .where(eq(dialpadPhoneNumbers.contractorId, contractorId));
  return all.find((row) => normalizePhoneNumber(row.phoneNumber) === target);
}

async function getDialpadPhoneNumbersByIds(ids: string[]): Promise<DialpadPhoneNumber[]> {
  if (ids.length === 0) return [];
  return await db.select().from(dialpadPhoneNumbers).where(inArray(dialpadPhoneNumbers.id, ids));
}

async function createDialpadPhoneNumber(phoneNumber: InsertDialpadPhoneNumber): Promise<DialpadPhoneNumber> {
  const result = await db.insert(dialpadPhoneNumbers).values(phoneNumber).returning();
  return result[0];
}

async function updateDialpadPhoneNumber(id: string, phoneNumber: UpdateDialpadPhoneNumber): Promise<DialpadPhoneNumber> {
  const result = await db.update(dialpadPhoneNumbers).set({ ...phoneNumber, updatedAt: new Date() }).where(eq(dialpadPhoneNumbers.id, id)).returning();
  return result[0];
}

// User phone number permission operations
async function getUserPhoneNumberPermissions(userId: string): Promise<UserPhoneNumberPermission[]> {
  return await db.select().from(userPhoneNumberPermissions).where(eq(userPhoneNumberPermissions.userId, userId));
}

async function getUserPhoneNumberPermission(userId: string, phoneNumberId: string): Promise<UserPhoneNumberPermission | undefined> {
  const result = await db.select().from(userPhoneNumberPermissions).where(and(eq(userPhoneNumberPermissions.userId, userId), eq(userPhoneNumberPermissions.phoneNumberId, phoneNumberId))).limit(1);
  return result[0];
}

async function createUserPhoneNumberPermission(permission: InsertUserPhoneNumberPermission): Promise<UserPhoneNumberPermission> {
  const result = await db.insert(userPhoneNumberPermissions).values(permission).returning();
  return result[0];
}

async function updateUserPhoneNumberPermission(id: string, permission: UpdateUserPhoneNumberPermission): Promise<UserPhoneNumberPermission> {
  const result = await db.update(userPhoneNumberPermissions).set({ ...permission, updatedAt: new Date() }).where(eq(userPhoneNumberPermissions.id, id)).returning();
  return result[0];
}

async function deleteUserPhoneNumberPermission(id: string): Promise<boolean> {
  const result = await db.delete(userPhoneNumberPermissions).where(eq(userPhoneNumberPermissions.id, id));
  return (result.rowCount ?? 0) > 0;
}

// Dialpad caching operations
async function getDialpadUsers(contractorId: string): Promise<DialpadUser[]> {
  return await db.select().from(dialpadUsers).where(eq(dialpadUsers.contractorId, contractorId)).orderBy(asc(dialpadUsers.fullName)).limit(500);
}

async function getDialpadUser(id: string, contractorId: string): Promise<DialpadUser | undefined> {
  const result = await db.select().from(dialpadUsers).where(and(eq(dialpadUsers.id, id), eq(dialpadUsers.contractorId, contractorId))).limit(1);
  return result[0];
}

async function getDialpadUserByDialpadId(dialpadUserId: string, contractorId: string): Promise<DialpadUser | undefined> {
  const result = await db.select().from(dialpadUsers).where(and(eq(dialpadUsers.dialpadUserId, dialpadUserId), eq(dialpadUsers.contractorId, contractorId))).limit(1);
  return result[0];
}

async function createDialpadUser(user: InsertDialpadUser): Promise<DialpadUser> {
  const result = await db.insert(dialpadUsers).values(user).returning();
  return result[0];
}

async function updateDialpadUser(id: string, user: UpdateDialpadUser): Promise<DialpadUser> {
  const result = await db.update(dialpadUsers).set({ ...user, updatedAt: new Date() }).where(eq(dialpadUsers.id, id)).returning();
  return result[0];
}

async function deleteDialpadUser(id: string): Promise<boolean> {
  const result = await db.delete(dialpadUsers).where(eq(dialpadUsers.id, id));
  return (result.rowCount ?? 0) > 0;
}

async function getDialpadDepartments(contractorId: string): Promise<DialpadDepartment[]> {
  return await db.select().from(dialpadDepartments).where(eq(dialpadDepartments.contractorId, contractorId)).orderBy(asc(dialpadDepartments.name)).limit(200);
}

async function getDialpadDepartment(id: string, contractorId: string): Promise<DialpadDepartment | undefined> {
  const result = await db.select().from(dialpadDepartments).where(and(eq(dialpadDepartments.id, id), eq(dialpadDepartments.contractorId, contractorId))).limit(1);
  return result[0];
}

async function getDialpadDepartmentByDialpadId(dialpadDepartmentId: string, contractorId: string): Promise<DialpadDepartment | undefined> {
  const result = await db.select().from(dialpadDepartments).where(and(eq(dialpadDepartments.dialpadDepartmentId, dialpadDepartmentId), eq(dialpadDepartments.contractorId, contractorId))).limit(1);
  return result[0];
}

async function createDialpadDepartment(department: InsertDialpadDepartment): Promise<DialpadDepartment> {
  const result = await db.insert(dialpadDepartments).values(department).returning();
  return result[0];
}

async function updateDialpadDepartment(id: string, department: UpdateDialpadDepartment): Promise<DialpadDepartment> {
  const result = await db.update(dialpadDepartments).set({ ...department, updatedAt: new Date() }).where(eq(dialpadDepartments.id, id)).returning();
  return result[0];
}

async function deleteDialpadDepartment(id: string): Promise<boolean> {
  const result = await db.delete(dialpadDepartments).where(eq(dialpadDepartments.id, id));
  return (result.rowCount ?? 0) > 0;
}

async function getDialpadSyncJobs(contractorId: string, limit = 10): Promise<DialpadSyncJob[]> {
  return await db.select().from(dialpadSyncJobs).where(eq(dialpadSyncJobs.contractorId, contractorId)).orderBy(desc(dialpadSyncJobs.createdAt)).limit(limit);
}

async function getDialpadSyncJob(id: string, contractorId: string): Promise<DialpadSyncJob | undefined> {
  const result = await db.select().from(dialpadSyncJobs).where(and(eq(dialpadSyncJobs.id, id), eq(dialpadSyncJobs.contractorId, contractorId))).limit(1);
  return result[0];
}

async function getLatestDialpadSyncJob(contractorId: string, syncType?: string): Promise<DialpadSyncJob | undefined> {
  const conditions = [eq(dialpadSyncJobs.contractorId, contractorId)];
  if (syncType) {
    conditions.push(eq(dialpadSyncJobs.syncType, syncType));
  }
  const result = await db.select().from(dialpadSyncJobs).where(and(...conditions)).orderBy(desc(dialpadSyncJobs.createdAt)).limit(1);
  return result[0];
}

async function createDialpadSyncJob(syncJob: InsertDialpadSyncJob): Promise<DialpadSyncJob> {
  const result = await db.insert(dialpadSyncJobs).values(syncJob).returning();
  return result[0];
}

async function updateDialpadSyncJob(id: string, syncJob: UpdateDialpadSyncJob): Promise<DialpadSyncJob> {
  const result = await db.update(dialpadSyncJobs).set({ ...syncJob, updatedAt: new Date() }).where(eq(dialpadSyncJobs.id, id)).returning();
  return result[0];
}

// Sync schedule operations
async function getSyncSchedules(contractorId: string): Promise<SyncSchedule[]> {
  return await db.select().from(syncSchedules).where(eq(syncSchedules.contractorId, contractorId)).orderBy(asc(syncSchedules.nextSyncAt));
}

async function getSyncSchedule(contractorId: string, integrationName: string): Promise<SyncSchedule | undefined> {
  const result = await db.select().from(syncSchedules).where(and(eq(syncSchedules.contractorId, contractorId), eq(syncSchedules.integrationName, integrationName))).limit(1);
  return result[0];
}

async function getDueSyncSchedules(): Promise<SyncSchedule[]> {
  // Cap at 100: one sync schedule per integration per contractor; this table will never
  // legitimately exceed a few hundred rows even at full scale.
  return await db.select().from(syncSchedules).where(and(eq(syncSchedules.isEnabled, true), lte(syncSchedules.nextSyncAt, new Date()))).orderBy(asc(syncSchedules.nextSyncAt)).limit(100);
}

/**
 * Return the earliest upcoming next_sync_at timestamp across all enabled schedules.
 * Returns null if there are no enabled schedules. Used by the adaptive scheduler
 * to sleep precisely until the next sync is due instead of polling on a fixed timer.
 */
async function getNextDueSyncAt(): Promise<Date | null> {
  const result = await db
    .select({ nextSyncAt: syncSchedules.nextSyncAt })
    .from(syncSchedules)
    .where(eq(syncSchedules.isEnabled, true))
    .orderBy(asc(syncSchedules.nextSyncAt))
    .limit(1);
  return result[0]?.nextSyncAt ?? null;
}

async function createSyncSchedule(schedule: InsertSyncSchedule): Promise<SyncSchedule> {
  const result = await db.insert(syncSchedules).values(schedule).returning();
  return result[0];
}

async function updateSyncSchedule(contractorId: string, integrationName: string, schedule: UpdateSyncSchedule): Promise<SyncSchedule | undefined> {
  const result = await db.update(syncSchedules).set({ ...schedule, updatedAt: new Date() }).where(and(eq(syncSchedules.contractorId, contractorId), eq(syncSchedules.integrationName, integrationName))).returning();
  return result[0];
}

async function deleteSyncSchedule(contractorId: string, integrationName: string): Promise<boolean> {
  const result = await db.delete(syncSchedules).where(and(eq(syncSchedules.contractorId, contractorId), eq(syncSchedules.integrationName, integrationName))).returning();
  return result.length > 0;
}

export const dialpadMethods = {
  getDialpadPhoneNumbers,
  getDialpadPhoneNumber,
  getDialpadPhoneNumberByNumber,
  getDialpadPhoneNumbersByIds,
  createDialpadPhoneNumber,
  updateDialpadPhoneNumber,
  getUserPhoneNumberPermissions,
  getUserPhoneNumberPermission,
  createUserPhoneNumberPermission,
  updateUserPhoneNumberPermission,
  deleteUserPhoneNumberPermission,
  getDialpadUsers,
  getDialpadUser,
  getDialpadUserByDialpadId,
  createDialpadUser,
  updateDialpadUser,
  deleteDialpadUser,
  getDialpadDepartments,
  getDialpadDepartment,
  getDialpadDepartmentByDialpadId,
  createDialpadDepartment,
  updateDialpadDepartment,
  deleteDialpadDepartment,
  getDialpadSyncJobs,
  getDialpadSyncJob,
  getLatestDialpadSyncJob,
  createDialpadSyncJob,
  updateDialpadSyncJob,
  getSyncSchedules,
  getSyncSchedule,
  getDueSyncSchedules,
  getNextDueSyncAt,
  createSyncSchedule,
  updateSyncSchedule,
  deleteSyncSchedule,
};
