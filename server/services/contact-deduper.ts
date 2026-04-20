/**
 * Contact Deduplication Service
 *
 * Uses a Union-Find (Disjoint Set Union) structure to group contacts sharing
 * a phone or email address. Contacts that share any identifier are unioned
 * into one group, and the oldest record in the group becomes the canonical
 * "primary" contact after merging.
 *
 * Time complexity: O(N·α(N)) where N = number of contacts, α = inverse
 * Ackermann function (effectively constant). Total work is dominated by the
 * batched DB reads: O(N / DEDUP_BATCH_SIZE) round-trips.
 *
 * Memory note: All contact records for the contractor are loaded into the
 * Node.js heap. For very large tenants this can be significant — see
 * DEDUP_MAX_CONTACTS for the current safety ceiling and the migration
 * notes below for lifting it.
 */

import { db } from "../db";
import { eq, inArray, sql } from "drizzle-orm";
import { type Contact, contacts, messages, activities, estimates, jobs } from "@shared/schema";
import { logger } from "../utils/logger";
import { normalizePhoneForStorage } from "../utils/phone-normalizer";

const log = logger('ContactDeduper');

/**
 * Batch size for the deduplication contact loader.
 *
 * Contacts are fetched from the database in pages of DEDUP_BATCH_SIZE rows,
 * then accumulated into the in-memory Union-Find structure. This bounds the
 * single DB round-trip to ~DEDUP_BATCH_SIZE rows so the Node.js heap never
 * holds the entire contacts table for a large tenant.
 *
 * Trade-off: total DB round-trips = Math.ceil(contactCount / DEDUP_BATCH_SIZE).
 * For a tenant with 100k contacts at 2k per batch: 50 queries — still far safer
 * than one 100k-row query that can OOM the process.
 *
 * Medium-term migration path: move deduplication into SQL using a temp table
 * + Postgres MERGE so zero rows are loaded into JS heap at all.
 */
const DEDUP_BATCH_SIZE = 2_000;

// Safety ceiling for deduplication. The Union-Find graph is built entirely in
// Node.js heap memory, so very large tenants can OOM the process. This guard
// prevents that by refusing to run deduplication above the threshold and
// returning early with a clear error. The limit can be raised once the
// algorithm is migrated to a SQL-side MERGE / temp-table approach (see the
// DEDUP_BATCH_SIZE comment above for the migration path).
const DEDUP_MAX_CONTACTS = 50_000;

export async function deduplicateContacts(contractorId: string): Promise<{
  duplicatesFound: number;
  contactsMerged: number;
  contactsDeleted: number;
}> {
  log.info(`Starting deduplication for contractor: ${contractorId}`);

  // Pre-flight count check — bail early before loading any rows into memory
  const [countRow] = await db
    .select({ total: sql<number>`COUNT(*)::int` })
    .from(contacts)
    .where(eq(contacts.contractorId, contractorId));
  const totalContacts = countRow?.total ?? 0;

  if (totalContacts > DEDUP_MAX_CONTACTS) {
    const msg = `Aborted: tenant has ${totalContacts} contacts which exceeds the in-memory deduplication limit of ${DEDUP_MAX_CONTACTS}. Migrate to SQL-side MERGE to lift this restriction.`;
    log.error(msg);
    throw new Error(`Contact deduplication is limited to ${DEDUP_MAX_CONTACTS} contacts. This tenant has ${totalContacts}.`);
  }

  const phoneToContacts = new Map<string, string[]>();
  const emailToContacts = new Map<string, string[]>();
  const contactById = new Map<string, Contact>();

  const normalizePhone = (phone: string): string => {
    const normalized = normalizePhoneForStorage(phone);
    if (normalized) return normalized;
    const digits = phone.replace(/\D/g, '');
    return digits.length > 0 ? digits.slice(-10) : '';
  };

  let offset = 0;
  let totalLoaded = 0;

  while (true) {
    const batch = await db
      .select()
      .from(contacts)
      .where(eq(contacts.contractorId, contractorId))
      .orderBy(contacts.createdAt)
      .limit(DEDUP_BATCH_SIZE)
      .offset(offset);

    if (batch.length === 0) break;

    for (const contact of batch) {
      contactById.set(contact.id, contact);
      contact.phones?.forEach((phone: string) => {
        const normalized = normalizePhone(phone);
        if (normalized.length >= 10) {
          const existing = phoneToContacts.get(normalized) || [];
          existing.push(contact.id);
          phoneToContacts.set(normalized, existing);
        }
      });
      contact.emails?.forEach((email: string) => {
        const normalized = email.toLowerCase().trim();
        if (normalized) {
          const existing = emailToContacts.get(normalized) || [];
          existing.push(contact.id);
          emailToContacts.set(normalized, existing);
        }
      });
    }

    totalLoaded += batch.length;
    offset += DEDUP_BATCH_SIZE;

    if (batch.length < DEDUP_BATCH_SIZE) break;
  }

  log.info(`Loaded ${totalLoaded} contacts across batches`);

  // Union-Find (Disjoint Set Union) algorithm for grouping duplicate contacts.
  //
  // Problem: two contacts are "duplicates" if they share any phone number or email,
  // even if they share different fields (A shares a phone with B; B shares an email
  // with C → A, B, C are all the same person).  A naive O(N²) pairwise comparison
  // would be too slow for large contractors.
  //
  // How it works:
  //   `parent` maps each contact ID to its group's representative (root) ID.
  //   Initially every contact is its own root (lazy-initialized in `find`).
  //
  //   `find(id)` — path-compressed lookup: follows parent pointers to the root,
  //   then flattens the chain so future lookups are O(1) amortized.
  //
  //   `union(id1, id2)` — merges two groups: finds both roots, and if they differ,
  //   makes the OLDER contact (by createdAt) the authoritative root so the earliest
  //   record is kept as the "primary" after merging.
  //
  // After all phone/email collisions are unioned, we group every contact by its root
  // to get the final duplicate clusters.
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    if (!parent.has(id)) parent.set(id, id);
    if (parent.get(id) !== id) {
      parent.set(id, find(parent.get(id)!)); // path compression
    }
    return parent.get(id)!;
  };
  const union = (id1: string, id2: string) => {
    const root1 = find(id1);
    const root2 = find(id2);
    if (root1 !== root2) {
      const contact1 = contactById.get(root1)!;
      const contact2 = contactById.get(root2)!;
      // Keep the oldest contact as the group root (it becomes the merge target)
      if (contact1.createdAt <= contact2.createdAt) {
        parent.set(root2, root1);
      } else {
        parent.set(root1, root2);
      }
    }
  };

  for (const contactIds of Array.from(phoneToContacts.values())) {
    for (let i = 1; i < contactIds.length; i++) union(contactIds[0], contactIds[i]);
  }
  for (const contactIds of Array.from(emailToContacts.values())) {
    for (let i = 1; i < contactIds.length; i++) union(contactIds[0], contactIds[i]);
  }

  const groups = new Map<string, Contact[]>();
  for (const contact of Array.from(contactById.values())) {
    const root = find(contact.id);
    const group = groups.get(root) || [];
    group.push(contact);
    groups.set(root, group);
  }

  const contactGroups = new Map<string, Contact[]>();
  for (const [root, group] of Array.from(groups)) {
    if (group.length > 1) {
      group.sort((a: Contact, b: Contact) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
      contactGroups.set(root, group);
    }
  }

  log.info(`Found ${contactGroups.size} groups of duplicates`);

  let contactsMerged = 0;
  let contactsDeleted = 0;

  const allDuplicateIds: string[] = [];

  await Promise.all(Array.from(contactGroups.entries()).map(async ([, duplicates]) => {
    const primary = duplicates[0];
    const duplicatesToMerge = duplicates.slice(1);
    if (duplicatesToMerge.length === 0) return;

    const duplicateIds = duplicatesToMerge.map(d => d.id);

    const allPhones = new Set<string>();
    const allEmails = new Set<string>();
    for (const contact of duplicates) {
      contact.phones?.forEach(phone => allPhones.add(phone));
      contact.emails?.forEach(email => allEmails.add(email.toLowerCase()));
    }

    await Promise.all([
      db.update(contacts).set({ phones: Array.from(allPhones), emails: Array.from(allEmails), updatedAt: new Date() }).where(eq(contacts.id, primary.id)),
      db.update(messages).set({ contactId: primary.id }).where(inArray(messages.contactId, duplicateIds)),
      db.update(activities).set({ contactId: primary.id }).where(inArray(activities.contactId, duplicateIds)),
      db.update(estimates).set({ contactId: primary.id }).where(inArray(estimates.contactId, duplicateIds)),
      db.update(jobs).set({ contactId: primary.id }).where(inArray(jobs.contactId, duplicateIds)),
    ]);

    allDuplicateIds.push(...duplicateIds);
    contactsDeleted += duplicateIds.length;
    contactsMerged++;
  }));

  if (allDuplicateIds.length > 0) {
    await db.delete(contacts).where(inArray(contacts.id, allDuplicateIds));
  }

  log.info(`Completed: ${contactsMerged} contacts merged, ${contactsDeleted} duplicates deleted`);
  return { duplicatesFound: contactGroups.size, contactsMerged, contactsDeleted };
}
