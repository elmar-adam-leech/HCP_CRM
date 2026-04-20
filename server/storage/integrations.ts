import {
  type Contact,
  type Estimate,
  type Job,
  type ContractorCredential,
  type ContractorProvider,
  type ContractorIntegration,
  type BusinessTargets, type InsertBusinessTargets,
  type SharedEmailAccount,
  contractorCredentials, contractorProviders, contractorIntegrations,
  contacts, estimates, jobs, businessTargets, contractors,
  sharedEmailAccounts,
} from "@shared/schema";
import { db } from "../db";
import { eq, and, asc, desc, inArray } from "drizzle-orm";
import type { UpdateBusinessTargets } from "../storage-types";

// Contractor credential operations
async function getContractorCredential(contractorId: string, service: string, credentialKey: string): Promise<ContractorCredential | undefined> {
  const result = await db.select().from(contractorCredentials).where(and(
    eq(contractorCredentials.contractorId, contractorId),
    eq(contractorCredentials.service, service),
    eq(contractorCredentials.credentialKey, credentialKey)
  )).limit(1);
  return result[0];
}

async function getContractorServiceCredentials(contractorId: string, service: string): Promise<ContractorCredential[]> {
  return await db.select().from(contractorCredentials).where(and(
    eq(contractorCredentials.contractorId, contractorId),
    eq(contractorCredentials.service, service)
  ));
}

async function setContractorCredential(contractorId: string, service: string, credentialKey: string, encryptedValue: string): Promise<ContractorCredential> {
  const existing = await getContractorCredential(contractorId, service, credentialKey);
  if (existing) {
    const result = await db.update(contractorCredentials).set({ encryptedValue, isActive: true, updatedAt: new Date() }).where(and(
      eq(contractorCredentials.contractorId, contractorId),
      eq(contractorCredentials.service, service),
      eq(contractorCredentials.credentialKey, credentialKey)
    )).returning();
    return result[0];
  } else {
    const result = await db.insert(contractorCredentials).values({ contractorId, service, credentialKey, encryptedValue, isActive: true }).returning();
    return result[0];
  }
}

async function disableContractorCredential(contractorId: string, service: string, credentialKey: string): Promise<void> {
  await db.update(contractorCredentials).set({ isActive: false, updatedAt: new Date() }).where(and(
    eq(contractorCredentials.contractorId, contractorId),
    eq(contractorCredentials.service, service),
    eq(contractorCredentials.credentialKey, credentialKey)
  ));
}

// Tenant provider operations
async function getTenantProvider(contractorId: string, providerType: 'email' | 'sms' | 'calling'): Promise<ContractorProvider | undefined> {
  const result = await db.select().from(contractorProviders).where(and(
    eq(contractorProviders.contractorId, contractorId),
    eq(contractorProviders.providerType, providerType),
    eq(contractorProviders.isActive, true)
  )).limit(1);
  return result[0];
}

async function setTenantProvider(contractorId: string, providerType: 'email' | 'sms' | 'calling', providerName: string): Promise<ContractorProvider> {
  const existingResult = await db.select().from(contractorProviders).where(and(
    eq(contractorProviders.contractorId, contractorId),
    eq(contractorProviders.providerType, providerType)
  )).limit(1);
  const existing = existingResult[0];

  const providerField =
    providerType === 'email' ? { emailProvider: providerName } :
    providerType === 'sms'   ? { smsProvider: providerName } :
                               { callingProvider: providerName };

  if (existing) {
    const result = await db.update(contractorProviders)
      // SAFE: `providerField` is a one-key object ({ emailProvider | smsProvider |
      // callingProvider }) derived from the `providerType` discriminant above.
      // Drizzle's `.set()` requires a full typed object, but the spread of a partial
      // `providerField` triggers a structural mismatch. The shape is correct at runtime.
      .set({ isActive: true, updatedAt: new Date(), ...providerField } as any)
      .where(and(
        eq(contractorProviders.contractorId, contractorId),
        eq(contractorProviders.providerType, providerType)
      )).returning();
    return result[0];
  } else {
    const result = await db.insert(contractorProviders)
      // SAFE: same reasoning as the `.set()` cast above — `providerField` spread is
      // structurally correct but doesn't satisfy Drizzle's strict insert type.
      .values({ contractorId, providerType, isActive: true, ...providerField } as any)
      .returning();
    return result[0];
  }
}

async function getTenantProviders(contractorId: string): Promise<ContractorProvider[]> {
  return await db.select().from(contractorProviders).where(and(
    eq(contractorProviders.contractorId, contractorId),
    eq(contractorProviders.isActive, true)
  ));
}

async function disableTenantProvider(contractorId: string, providerType: 'email' | 'sms' | 'calling'): Promise<void> {
  await db.update(contractorProviders).set({ isActive: false, updatedAt: new Date() }).where(and(
    eq(contractorProviders.contractorId, contractorId),
    eq(contractorProviders.providerType, providerType)
  ));
}

// Tenant integration enablement operations
async function getTenantIntegration(contractorId: string, integrationName: string): Promise<ContractorIntegration | undefined> {
  const result = await db.select().from(contractorIntegrations).where(and(
    eq(contractorIntegrations.contractorId, contractorId),
    eq(contractorIntegrations.integrationName, integrationName)
  )).limit(1);
  return result[0];
}

async function getTenantIntegrations(contractorId: string): Promise<ContractorIntegration[]> {
  return await db.select().from(contractorIntegrations).where(eq(contractorIntegrations.contractorId, contractorId)).orderBy(asc(contractorIntegrations.integrationName));
}

async function getEnabledIntegrations(contractorId: string): Promise<ContractorIntegration[]> {
  return await db.select().from(contractorIntegrations).where(and(
    eq(contractorIntegrations.contractorId, contractorId),
    eq(contractorIntegrations.isEnabled, true)
  )).orderBy(asc(contractorIntegrations.integrationName));
}

async function enableTenantIntegration(contractorId: string, integrationName: string, enabledBy?: string): Promise<ContractorIntegration> {
  const now = new Date();
  const existing = await getTenantIntegration(contractorId, integrationName);
  if (existing) {
    const result = await db.update(contractorIntegrations).set({ isEnabled: true, enabledAt: now, disabledAt: null, enabledBy, updatedAt: now }).where(and(
      eq(contractorIntegrations.contractorId, contractorId),
      eq(contractorIntegrations.integrationName, integrationName)
    )).returning();
    return result[0];
  } else {
    const result = await db.insert(contractorIntegrations).values({ contractorId, integrationName, isEnabled: true, enabledAt: now, enabledBy, createdAt: now, updatedAt: now }).returning();
    return result[0];
  }
}

async function disableTenantIntegration(contractorId: string, integrationName: string): Promise<void> {
  const now = new Date();
  await db.update(contractorIntegrations).set({ isEnabled: false, disabledAt: now, updatedAt: now }).where(and(
    eq(contractorIntegrations.contractorId, contractorId),
    eq(contractorIntegrations.integrationName, integrationName)
  ));
}

async function isIntegrationEnabled(contractorId: string, integrationName: string): Promise<boolean> {
  const result = await db.select({ isEnabled: contractorIntegrations.isEnabled }).from(contractorIntegrations).where(and(
    eq(contractorIntegrations.contractorId, contractorId),
    eq(contractorIntegrations.integrationName, integrationName)
  )).limit(1);
  return result[0]?.isEnabled ?? false;
}

// Housecall Pro integration operations
async function getContactByHousecallProEstimateId(housecallProEstimateId: string, contractorId: string): Promise<Contact | undefined> {
  const result = await db.select().from(contacts).where(and(
    eq(contacts.housecallProEstimateId, housecallProEstimateId),
    eq(contacts.contractorId, contractorId),
    eq(contacts.type, 'lead')
  )).limit(1);
  return result[0];
}

async function getEstimateByHousecallProEstimateId(housecallProEstimateId: string, contractorId: string): Promise<Estimate | undefined> {
  const result = await db.select().from(estimates).where(and(
    eq(estimates.externalId, housecallProEstimateId),
    eq(estimates.externalSource, 'housecall-pro'),
    eq(estimates.contractorId, contractorId)
  )).limit(1);
  return result[0];
}

async function getEstimatesByHousecallProIds(housecallProEstimateIds: string[], contractorId: string): Promise<Map<string, Estimate>> {
  if (housecallProEstimateIds.length === 0) return new Map();
  const result = await db.select().from(estimates).where(and(
    inArray(estimates.externalId, housecallProEstimateIds),
    eq(estimates.externalSource, 'housecall-pro'),
    eq(estimates.contractorId, contractorId)
  ));
  const estimateMap = new Map<string, Estimate>();
  for (const estimate of result) {
    if (estimate.externalId) estimateMap.set(estimate.externalId, estimate);
  }
  return estimateMap;
}

async function getJobsByExternalIds(externalIds: string[], contractorId: string): Promise<Map<string, Job>> {
  if (externalIds.length === 0) return new Map();
  const rows = await db.select().from(jobs).where(and(
    inArray(jobs.externalId, externalIds),
    eq(jobs.contractorId, contractorId)
  ));
  // SAFE: `.filter(j => j.externalId)` excludes rows where externalId is null/undefined,
  // so the `!` assertion after the filter is always sound.
  return new Map(rows.filter(j => j.externalId).map(j => [j.externalId!, j]));
}

async function getScheduledContacts(contractorId: string): Promise<Contact[]> {
  return await db.select().from(contacts).where(and(
    eq(contacts.contractorId, contractorId),
    eq(contacts.isScheduled, true),
    eq(contacts.type, 'lead')
  )).orderBy(desc(contacts.scheduledAt)).limit(500);  // safety cap for HCP scheduling flow
}

async function getUnscheduledContacts(contractorId: string): Promise<Contact[]> {
  return await db.select().from(contacts).where(and(
    eq(contacts.contractorId, contractorId),
    eq(contacts.isScheduled, false),
    eq(contacts.type, 'lead')
  )).orderBy(desc(contacts.createdAt)).limit(500);  // safety cap for HCP scheduling flow
}

async function scheduleContactAsEstimate(contactId: string, housecallProData: {
  housecallProCustomerId: string;
  housecallProEstimateId: string;
  scheduledAt: Date;
  scheduledEmployeeId: string;
  scheduledStart: Date;
  scheduledEnd: Date;
  description?: string;
}, contractorId: string): Promise<{ contact: Contact; estimate: Estimate } | undefined> {
  const originalContact = await db.select().from(contacts).where(and(eq(contacts.id, contactId), eq(contacts.contractorId, contractorId))).limit(1);
  if (!originalContact[0]) return undefined;

  return await db.transaction(async (tx) => {
    const [updatedContact] = await tx.update(contacts).set({
      housecallProCustomerId: housecallProData.housecallProCustomerId,
      housecallProEstimateId: housecallProData.housecallProEstimateId,
      scheduledAt: housecallProData.scheduledAt,
      scheduledEmployeeId: housecallProData.scheduledEmployeeId,
      isScheduled: true,
      updatedAt: new Date()
    }).where(and(eq(contacts.id, contactId), eq(contacts.contractorId, contractorId))).returning();

    const [newEstimate] = await tx.insert(estimates).values({
      title: `Estimate for ${originalContact[0].name}`,
      contactId: contactId,
      description: housecallProData.description || `Estimate for ${originalContact[0].name}`,
      amount: '0.00',
      status: 'scheduled',
      contractorId: contractorId,
      externalId: housecallProData.housecallProEstimateId,
      externalSource: 'housecall-pro',
      scheduledStart: housecallProData.scheduledStart,
      scheduledEnd: housecallProData.scheduledEnd,
      syncedAt: new Date()
    }).returning();

    return { contact: updatedContact, estimate: newEstimate };
  });
}

// Housecall Pro sync start date operations
async function getHousecallProSyncStartDate(contractorId: string): Promise<Date | null> {
  const result = await db.select({ housecallProSyncStartDate: contractors.housecallProSyncStartDate }).from(contractors).where(eq(contractors.id, contractorId)).limit(1);
  return result[0]?.housecallProSyncStartDate || null;
}

async function setHousecallProSyncStartDate(contractorId: string, syncStartDate: Date | null): Promise<void> {
  await db.update(contractors).set({ housecallProSyncStartDate: syncStartDate }).where(eq(contractors.id, contractorId));
}

// Business targets operations
async function getBusinessTargets(contractorId: string): Promise<BusinessTargets | undefined> {
  const result = await db.select().from(businessTargets).where(eq(businessTargets.contractorId, contractorId)).limit(1);
  return result[0];
}

async function createBusinessTargets(targets: Omit<InsertBusinessTargets, 'contractorId'>, contractorId: string): Promise<BusinessTargets> {
  const result = await db.insert(businessTargets).values({ ...targets, contractorId }).returning();
  return result[0];
}

async function updateBusinessTargets(targets: UpdateBusinessTargets, contractorId: string): Promise<BusinessTargets | undefined> {
  const result = await db.update(businessTargets).set({ ...targets, updatedAt: new Date() }).where(eq(businessTargets.contractorId, contractorId)).returning();
  return result[0];
}

// Shared email account operations
async function getSharedEmailAccount(contractorId: string): Promise<SharedEmailAccount | undefined> {
  const result = await db.select().from(sharedEmailAccounts).where(eq(sharedEmailAccounts.contractorId, contractorId)).limit(1);
  return result[0];
}

async function upsertSharedEmailAccount(contractorId: string, data: { email: string; displayName?: string; gmailRefreshToken: string; connectedByUserId?: string }): Promise<SharedEmailAccount> {
  const existing = await getSharedEmailAccount(contractorId);
  if (existing) {
    const result = await db.update(sharedEmailAccounts).set({
      email: data.email,
      displayName: data.displayName ?? existing.displayName,
      gmailRefreshToken: data.gmailRefreshToken,
      connectedByUserId: data.connectedByUserId ?? existing.connectedByUserId,
    }).where(eq(sharedEmailAccounts.contractorId, contractorId)).returning();
    return result[0];
  } else {
    const result = await db.insert(sharedEmailAccounts).values({
      contractorId,
      email: data.email,
      displayName: data.displayName,
      gmailRefreshToken: data.gmailRefreshToken,
      connectedByUserId: data.connectedByUserId,
    }).returning();
    return result[0];
  }
}

async function deleteSharedEmailAccount(contractorId: string): Promise<boolean> {
  const result = await db.delete(sharedEmailAccounts).where(eq(sharedEmailAccounts.contractorId, contractorId)).returning();
  return result.length > 0;
}

async function getAllSharedEmailAccounts(): Promise<SharedEmailAccount[]> {
  return await db.select().from(sharedEmailAccounts);
}

async function updateSharedEmailLastSyncAt(contractorId: string, when: Date): Promise<void> {
  await db.update(sharedEmailAccounts)
    .set({ lastSyncAt: when })
    .where(eq(sharedEmailAccounts.contractorId, contractorId));
}

async function clearSharedEmailToken(contractorId: string): Promise<void> {
  // Delete the row so the UI shows "Disconnected — reconnect". The shared-email
  // table requires a non-null refresh token, so we cannot simply null it out.
  await db.delete(sharedEmailAccounts).where(eq(sharedEmailAccounts.contractorId, contractorId));
}

// IStorage interface aliases
async function getContractorProvider(contractorId: string, providerType: 'email' | 'sms' | 'calling'): Promise<ContractorProvider | undefined> {
  return getTenantProvider(contractorId, providerType);
}
async function setContractorProvider(contractorId: string, providerType: 'email' | 'sms' | 'calling', providerName: string): Promise<ContractorProvider> {
  return setTenantProvider(contractorId, providerType, providerName);
}
async function getContractorProviders(contractorId: string): Promise<ContractorProvider[]> {
  return getTenantProviders(contractorId);
}
async function disableContractorProvider(contractorId: string, providerType: 'email' | 'sms' | 'calling'): Promise<void> {
  return disableTenantProvider(contractorId, providerType);
}
async function getContractorIntegration(contractorId: string, integrationName: string): Promise<ContractorIntegration | undefined> {
  return getTenantIntegration(contractorId, integrationName);
}
async function getContractorIntegrations(contractorId: string): Promise<ContractorIntegration[]> {
  return getTenantIntegrations(contractorId);
}
async function enableContractorIntegration(contractorId: string, integrationName: string, enabledBy?: string): Promise<ContractorIntegration> {
  return enableTenantIntegration(contractorId, integrationName, enabledBy);
}
async function disableContractorIntegration(contractorId: string, integrationName: string): Promise<void> {
  return disableTenantIntegration(contractorId, integrationName);
}

export const integrationMethods = {
  getContractorCredential,
  getContractorServiceCredentials,
  setContractorCredential,
  disableContractorCredential,
  getTenantProvider,
  setTenantProvider,
  getTenantProviders,
  disableTenantProvider,
  getTenantIntegration,
  getTenantIntegrations,
  getEnabledIntegrations,
  enableTenantIntegration,
  disableTenantIntegration,
  isIntegrationEnabled,
  getContactByHousecallProEstimateId,
  getEstimateByHousecallProEstimateId,
  getEstimatesByHousecallProIds,
  getJobsByExternalIds,
  getScheduledContacts,
  getUnscheduledContacts,
  scheduleContactAsEstimate,
  getHousecallProSyncStartDate,
  setHousecallProSyncStartDate,
  getBusinessTargets,
  createBusinessTargets,
  updateBusinessTargets,
  getContractorProvider,
  setContractorProvider,
  getContractorProviders,
  disableContractorProvider,
  getContractorIntegration,
  getContractorIntegrations,
  enableContractorIntegration,
  disableContractorIntegration,
  getSharedEmailAccount,
  getAllSharedEmailAccounts,
  upsertSharedEmailAccount,
  deleteSharedEmailAccount,
  updateSharedEmailLastSyncAt,
  clearSharedEmailToken,
};
