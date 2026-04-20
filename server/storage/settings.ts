import {
  type TerminologySettings, type InsertTerminologySettings,
  terminologySettings,
  hcpExcludedCustomers,
} from "@shared/schema";
import { db } from "../db";
import { eq, and } from "drizzle-orm";
import type { UpdateTerminologySettings } from "../storage-types";

async function getTerminologySettings(contractorId: string): Promise<TerminologySettings | undefined> {
  const result = await db.select().from(terminologySettings).where(eq(terminologySettings.contractorId, contractorId)).limit(1);
  return result[0];
}

async function createTerminologySettings(settings: Omit<InsertTerminologySettings, 'contractorId'>, contractorId: string): Promise<TerminologySettings> {
  const result = await db.insert(terminologySettings).values({ ...settings, contractorId }).returning();
  return result[0]!;
}

async function updateTerminologySettings(settings: UpdateTerminologySettings, contractorId: string): Promise<TerminologySettings | undefined> {
  const result = await db.update(terminologySettings).set({ ...settings, updatedAt: new Date() }).where(eq(terminologySettings.contractorId, contractorId)).returning();
  return result[0];
}

async function addHcpExcludedCustomer(contractorId: string, hcpCustomerId: string): Promise<void> {
  await db.insert(hcpExcludedCustomers)
    .values({ contractorId, hcpCustomerId })
    .onConflictDoNothing();
}

async function isHcpCustomerExcluded(contractorId: string, hcpCustomerId: string): Promise<boolean> {
  const result = await db.select({ id: hcpExcludedCustomers.id })
    .from(hcpExcludedCustomers)
    .where(and(
      eq(hcpExcludedCustomers.contractorId, contractorId),
      eq(hcpExcludedCustomers.hcpCustomerId, hcpCustomerId),
    ))
    .limit(1);
  return result.length > 0;
}

export const settingsMethods = {
  getTerminologySettings,
  createTerminologySettings,
  updateTerminologySettings,
  addHcpExcludedCustomer,
  isHcpCustomerExcluded,
};
