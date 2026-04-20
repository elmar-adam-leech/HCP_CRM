import {
  type User, type InsertUser,
  type UserContractor, type InsertUserContractor,
  type Contractor, type InsertContractor,
  users, userContractors, contractors,
} from "@shared/schema";
import { db } from "../db";
import { eq, and, desc, sql, inArray } from "drizzle-orm";
import bcrypt from "bcrypt";
import type { UpdateUser, UpdateContractor } from "../storage-types";
import { cacheInvalidation } from "../services/cache";

async function getUser(id: string): Promise<User | undefined> {
  const result = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return result[0];
}

async function getUserByUsername(username: string): Promise<User | undefined> {
  const result = await db.select().from(users).where(eq(users.username, username)).limit(1);
  return result[0];
}

async function getUserByEmail(email: string): Promise<User | undefined> {
  const result = await db
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = lower(${email})`)
    .orderBy(desc(users.createdAt))
    .limit(1);
  return result[0];
}

async function getUserByEmailAndContractor(email: string, contractorId: string): Promise<User | undefined> {
  const result = await db
    .select()
    .from(users)
    .innerJoin(userContractors, eq(users.id, userContractors.userId))
    .where(and(sql`lower(${users.email}) = lower(${email})`, eq(userContractors.contractorId, contractorId)))
    .orderBy(desc(users.createdAt))
    .limit(1);
  return result[0]?.users;
}

async function createUser(user: InsertUser): Promise<User> {
  const hashedPassword = await bcrypt.hash(user.password, 12);
  const userWithHashedPassword = { ...user, password: hashedPassword };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await db.insert(users).values(userWithHashedPassword as any).returning();
  return result[0];
}

async function verifyPassword(username: string, password: string): Promise<User | null> {
  const user = await getUserByUsername(username);
  if (!user) return null;
  const isValid = await bcrypt.compare(password, user.password);
  return isValid ? user : null;
}

async function verifyPasswordByEmail(email: string, password: string): Promise<User | null> {
  const user = await getUserByEmail(email);
  if (!user) return null;
  const isValid = await bcrypt.compare(password, user.password);
  return isValid ? user : null;
}

async function updateUser(id: string, user: UpdateUser): Promise<User | undefined> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await db.update(users).set(user as any).where(eq(users.id, id)).returning();
  cacheInvalidation.invalidateUser(id);
  return result[0];
}

async function switchContractor(userId: string, contractorId: string): Promise<User | undefined> {
  const uc = await getUserContractor(userId, contractorId);
  if (!uc) {
    throw new Error('User does not have access to this contractor');
  }
  const result = await db
    .update(users)
    .set({ contractorId })
    .where(eq(users.id, userId))
    .returning();
  cacheInvalidation.invalidateUser(userId);
  return result[0];
}

async function getUserContractors(userId: string): Promise<UserContractor[]> {
  return await db.select().from(userContractors).where(eq(userContractors.userId, userId)).limit(50);
}

async function getContractorUsers(contractorId: string): Promise<UserContractor[]> {
  return await db.select().from(userContractors).where(eq(userContractors.contractorId, contractorId)).limit(500);
}

async function getUserContractor(userId: string, contractorId: string): Promise<UserContractor | undefined> {
  const result = await db
    .select()
    .from(userContractors)
    .where(and(eq(userContractors.userId, userId), eq(userContractors.contractorId, contractorId)))
    .limit(1);
  return result[0];
}

async function addUserToContractor(userContractor: InsertUserContractor): Promise<UserContractor> {
  const result = await db.insert(userContractors).values(userContractor).returning();
  return result[0];
}

async function removeUserFromContractor(userId: string, contractorId: string): Promise<boolean> {
  const result = await db
    .delete(userContractors)
    .where(and(eq(userContractors.userId, userId), eq(userContractors.contractorId, contractorId)))
    .returning();
  return result.length > 0;
}

async function updateUserContractor(userId: string, contractorId: string, updates: Partial<InsertUserContractor>): Promise<UserContractor | undefined> {
  const result = await db
    .update(userContractors)
    .set(updates)
    .where(and(eq(userContractors.userId, userId), eq(userContractors.contractorId, contractorId)))
    .returning();
  return result[0];
}

async function ensureUserContractorEntry(userId: string, contractorId: string, role: 'super_admin' | 'admin' | 'manager' | 'user', canManageIntegrations: boolean = false): Promise<UserContractor> {
  const result = await db
    .insert(userContractors)
    .values({ userId, contractorId, role, canManageIntegrations })
    .onConflictDoNothing()
    .returning();

  if (result.length > 0) {
    return result[0];
  }

  const existing = await getUserContractor(userId, contractorId);
  if (!existing) {
    throw new Error('Failed to ensure user contractor entry');
  }
  return existing;
}

async function getContractor(id: string): Promise<Contractor | undefined> {
  const result = await db.select().from(contractors).where(eq(contractors.id, id)).limit(1);
  return result[0];
}

// Batch fetch for multiple contractors in a single query (avoids N+1 in getUserContractors route)
async function getContractorsByIds(ids: string[]): Promise<Contractor[]> {
  if (ids.length === 0) return [];
  return await db.select().from(contractors).where(inArray(contractors.id, ids));
}

async function getContractorByDomain(domain: string): Promise<Contractor | undefined> {
  const result = await db.select().from(contractors).where(eq(contractors.domain, domain)).limit(1);
  return result[0];
}

async function getContractorBySlug(slug: string): Promise<Contractor | undefined> {
  const result = await db.select().from(contractors).where(eq(contractors.bookingSlug, slug)).limit(1);
  return result[0];
}

async function createContractor(contractor: InsertContractor): Promise<Contractor> {
  const result = await db.insert(contractors).values(contractor).returning();
  return result[0];
}

async function updateContractor(id: string, contractor: UpdateContractor): Promise<Contractor | undefined> {
  const result = await db.update(contractors)
    .set({ ...contractor, createdAt: undefined })
    .where(eq(contractors.id, id))
    .returning();
  return result[0];
}

export const userMethods = {
  getUser,
  getUserByUsername,
  getUserByEmail,
  getUserByEmailAndContractor,
  createUser,
  verifyPassword,
  verifyPasswordByEmail,
  updateUser,
  switchContractor,
  getUserContractors,
  getContractorUsers,
  getUserContractor,
  addUserToContractor,
  removeUserFromContractor,
  updateUserContractor,
  ensureUserContractorEntry,
  getContractor,
  getContractorsByIds,
  getContractorByDomain,
  getContractorBySlug,
  createContractor,
  updateContractor,
};
