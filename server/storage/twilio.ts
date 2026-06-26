import {
  type TwilioPhoneNumber, type InsertTwilioPhoneNumber,
  type TwilioUserPhonePermission, type InsertTwilioUserPhonePermission,
  type TwilioWebhookState, type InsertTwilioWebhookState,
  twilioPhoneNumbers, twilioUserPhonePermissions, twilioWebhookState,
} from "@shared/schema";
import { db } from "../db";
import { eq, and, asc } from "drizzle-orm";
import { normalizePhoneNumber } from "../utils/phone-normalizer";

// Twilio phone number operations (mirror dialpad)
async function getTwilioPhoneNumbers(contractorId: string): Promise<TwilioPhoneNumber[]> {
  return await db.select().from(twilioPhoneNumbers)
    .where(eq(twilioPhoneNumbers.contractorId, contractorId))
    .orderBy(asc(twilioPhoneNumbers.phoneNumber)).limit(200);
}

async function getTwilioPhoneNumber(id: string, contractorId: string): Promise<TwilioPhoneNumber | undefined> {
  const result = await db.select().from(twilioPhoneNumbers)
    .where(and(eq(twilioPhoneNumbers.id, id), eq(twilioPhoneNumbers.contractorId, contractorId))).limit(1);
  return result[0];
}

async function getTwilioPhoneNumberByNumber(contractorId: string, phoneNumber: string): Promise<TwilioPhoneNumber | undefined> {
  const direct = await db.select().from(twilioPhoneNumbers)
    .where(and(eq(twilioPhoneNumbers.contractorId, contractorId), eq(twilioPhoneNumbers.phoneNumber, phoneNumber)))
    .limit(1);
  if (direct[0]) return direct[0];

  const target = normalizePhoneNumber(phoneNumber);
  if (!target) return undefined;
  const all = await db.select().from(twilioPhoneNumbers)
    .where(eq(twilioPhoneNumbers.contractorId, contractorId));
  return all.find((row) => normalizePhoneNumber(row.phoneNumber) === target);
}

async function createTwilioPhoneNumber(phoneNumber: InsertTwilioPhoneNumber): Promise<TwilioPhoneNumber> {
  const result = await db.insert(twilioPhoneNumbers).values(phoneNumber).returning();
  return result[0];
}

async function updateTwilioPhoneNumber(id: string, phoneNumber: Partial<InsertTwilioPhoneNumber>): Promise<TwilioPhoneNumber> {
  const result = await db.update(twilioPhoneNumbers)
    .set({ ...phoneNumber, updatedAt: new Date() })
    .where(eq(twilioPhoneNumbers.id, id)).returning();
  return result[0];
}

async function deleteTwilioPhoneNumber(id: string): Promise<boolean> {
  const result = await db.delete(twilioPhoneNumbers).where(eq(twilioPhoneNumbers.id, id));
  return (result.rowCount ?? 0) > 0;
}

// Per-user Twilio number permission operations
async function getTwilioUserPhonePermissions(userId: string): Promise<TwilioUserPhonePermission[]> {
  return await db.select().from(twilioUserPhonePermissions).where(eq(twilioUserPhonePermissions.userId, userId));
}

async function createTwilioUserPhonePermission(permission: InsertTwilioUserPhonePermission): Promise<TwilioUserPhonePermission> {
  const result = await db.insert(twilioUserPhonePermissions).values(permission).returning();
  return result[0];
}

async function deleteTwilioUserPhonePermission(id: string): Promise<boolean> {
  const result = await db.delete(twilioUserPhonePermissions).where(eq(twilioUserPhonePermissions.id, id));
  return (result.rowCount ?? 0) > 0;
}

// Twilio webhook state (one row per contractor)
async function getTwilioWebhookState(contractorId: string): Promise<TwilioWebhookState | undefined> {
  const result = await db.select().from(twilioWebhookState)
    .where(eq(twilioWebhookState.contractorId, contractorId)).limit(1);
  return result[0];
}

async function upsertTwilioWebhookState(state: InsertTwilioWebhookState): Promise<TwilioWebhookState> {
  const existing = await getTwilioWebhookState(state.contractorId);
  if (existing) {
    const result = await db.update(twilioWebhookState)
      .set({ ...state, updatedAt: new Date() })
      .where(eq(twilioWebhookState.contractorId, state.contractorId)).returning();
    return result[0];
  }
  const result = await db.insert(twilioWebhookState).values(state).returning();
  return result[0];
}

export const twilioMethods = {
  getTwilioPhoneNumbers,
  getTwilioPhoneNumber,
  getTwilioPhoneNumberByNumber,
  createTwilioPhoneNumber,
  updateTwilioPhoneNumber,
  deleteTwilioPhoneNumber,
  getTwilioUserPhonePermissions,
  createTwilioUserPhonePermission,
  deleteTwilioUserPhonePermission,
  getTwilioWebhookState,
  upsertTwilioWebhookState,
};
