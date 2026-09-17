/**
 * Real-Postgres coverage for the two-field lead identity critical section.
 * These tests deliberately use ingestLead rather than mocking storage: the
 * advisory-lock holder and the normal storage writes use separate pool
 * checkouts, which is the race this suite protects.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { contacts, leads, activities } from '@shared/schema';
import { db } from '../db';
import { storage } from '../storage';
import { ingestLead } from './lead-ingestion';

const RUN = !!process.env.DATABASE_URL;
const d = RUN ? describe : describe.skip;

let contractorId: string;
let otherContractorId: string;
let serial = 0;

function unique(prefix: string): string {
  serial++;
  return `${prefix}-${Date.now()}-${serial}`;
}

function leadInput(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Ada Example',
    emails: ['ada@example.test'],
    phones: ['(415) 555-1212'],
    source: 'test-intake',
    identityPolicy: 'two-field' as const,
    skipAutoAssign: true,
    skipWorkflows: true,
    skipHcpSync: true,
    ...overrides,
  };
}

async function tenantRows(tenantId = contractorId) {
  return db.select({
    contactId: contacts.id,
    emails: contacts.emails,
    phones: contacts.phones,
    notes: contacts.notes,
    leadId: leads.id,
    createdAt: leads.createdAt,
  }).from(contacts)
    .leftJoin(leads, and(eq(leads.contactId, contacts.id), eq(leads.contractorId, tenantId)))
    .where(eq(contacts.contractorId, tenantId));
}

beforeAll(async () => {
  // Runtime applies this idempotent schema-drift migration during boot. The
  // standalone Vitest process intentionally does not boot the app, so make
  // the real-DB test environment match that contract before using ingestion.
  await db.execute(sql`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS submission_creation_key text`);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS contacts_submission_creation_idx
    ON contacts (contractor_id, submission_creation_key)`);
  await db.execute(sql`ALTER TABLE leads ADD COLUMN IF NOT EXISTS submission_creation_keys text[] NOT NULL DEFAULT '{}'`);

  const suffix = unique('lead-identity');
  const [primary] = await db.execute<{ id: string }>(sql`
    INSERT INTO contractors (name, domain)
    VALUES (${`Lead identity ${suffix}`}, ${`${suffix}.example.test`})
    RETURNING id
  `).then(result => result.rows);
  const [other] = await db.execute<{ id: string }>(sql`
    INSERT INTO contractors (name, domain)
    VALUES (${`Lead identity other ${suffix}`}, ${`other-${suffix}.example.test`})
    RETURNING id
  `).then(result => result.rows);
  contractorId = primary.id;
  otherContractorId = other.id;
});

afterEach(async () => {
  if (!contractorId) return;
  await db.execute(sql`DELETE FROM consent_logs WHERE contractor_id IN (${contractorId}, ${otherContractorId})`);
  await db.delete(contacts).where(eq(contacts.contractorId, contractorId));
  await db.delete(contacts).where(eq(contacts.contractorId, otherContractorId));
});

afterAll(async () => {
  if (!contractorId) return;
  await db.execute(sql`DELETE FROM consent_logs WHERE contractor_id IN (${contractorId}, ${otherContractorId})`);
  await db.execute(sql`DELETE FROM contractors WHERE id IN (${contractorId}, ${otherContractorId})`);
});

d('lead ingestion two-field identity (real Postgres)', () => {
  it.each([
    ['email-first', 'Email intake', 'Facebook intake'],
    ['social-first', 'Facebook intake', 'Email intake'],
  ])('keeps one lead and both timeline activities for concurrent %s arrivals', async (_order, firstSource, secondSource) => {
    const name = ` Ada   ${unique('Concurrent')} `;
    const [first, second] = await Promise.all([
      ingestLead(contractorId, leadInput({
        name,
        emails: ['ada.secondary@example.test'],
        phones: ['+1 415 555 1212'],
        source: firstSource,
        activityNote: `received from ${firstSource}`,
        activityExternalId: unique('activity'),
        submissionId: unique('submission'),
      })),
      ingestLead(contractorId, leadInput({
        name: name.trim().replace(/\s+/g, ' '),
        emails: ['ADA.SECONDARY@EXAMPLE.TEST', 'richer@example.test'],
        phones: ['415-555-1212', '(415) 555-0000'],
        source: secondSource,
        activityNote: `received from ${secondSource}`,
        activityExternalId: unique('activity'),
        submissionId: unique('submission'),
      })),
    ]);

    expect([first.isNewContact, second.isNewContact].filter(Boolean)).toHaveLength(1);
    expect([first.skippedDuplicateLead, second.skippedDuplicateLead].filter(Boolean)).toHaveLength(1);
    expect(first.contact.id).toBe(second.contact.id);
    expect(first.lead.id).toBe(second.lead.id);

    // Reload from Postgres to prove the retained card sees the additive
    // contact fields, not an in-memory enrichment snapshot.
    const [saved] = await db.select().from(contacts)
      .where(and(eq(contacts.id, first.contact.id), eq(contacts.contractorId, contractorId)));
    expect(saved.emails).toEqual(expect.arrayContaining(['richer@example.test']));
    expect(saved.phones).toEqual(expect.arrayContaining(['(415) 555-0000']));
    const timeline = await db.select().from(activities).where(and(
      eq(activities.contractorId, contractorId),
      eq(activities.contactId, saved.id),
      eq(activities.leadId, first.lead.id),
    ));
    expect(timeline).toHaveLength(2);
  });

  it('serializes concurrent sparse-identity retries for the same provider submission', async () => {
    const submissionId = unique('sparse-submission');
    const [first, second] = await Promise.all([
      ingestLead(contractorId, leadInput({
        name: 'Unknown Lead',
        emails: [],
        phones: [],
        source: 'sparse-channel',
        submissionId,
      })),
      ingestLead(contractorId, leadInput({
        name: 'Unknown Lead',
        emails: [],
        phones: [],
        source: 'sparse-channel',
        submissionId,
      })),
    ]);

    expect(first.contact.id).toBe(second.contact.id);
    expect(first.lead.id).toBe(second.lead.id);
    expect([first.isNewContact, second.isNewContact].filter(Boolean)).toHaveLength(1);
  });

  it('matches every supported pair using secondary methods, but ignores blank and invalid evidence', async () => {
    const original = await ingestLead(contractorId, leadInput({
      emails: ['primary@example.test', 'secondary@example.test'],
      phones: ['(415) 555-1111', '(415) 555-2222'],
    }));

    for (const values of [
      { name: ' ADA   EXAMPLE ', emails: ['SECONDARY@EXAMPLE.TEST'], phones: [] },
      { name: 'Ada Example', emails: [], phones: ['4155552222'] },
      { name: 'Unknown Lead', emails: ['primary@example.test'], phones: ['+1 (415) 555-1111'] },
    ]) {
      const result = await ingestLead(contractorId, leadInput(values));
      expect(result.contact.id).toBe(original.contact.id);
      expect(result.skippedDuplicateLead).toBe(true);
    }

    const insufficient = await ingestLead(contractorId, leadInput({
      name: 'Unknown Lead',
      emails: ['not an email'],
      phones: ['123'],
    }));
    expect(insufficient.isNewContact).toBe(true);
  });

  it('does not cross tenant boundaries and reports conflicting candidates', async () => {
    await ingestLead(otherContractorId, leadInput());
    const isolated = await ingestLead(contractorId, leadInput());
    expect(isolated.isNewContact).toBe(true);

    // Make a second local record outside the normal ingestion path to simulate
    // historical duplicates. An automatic winner would be data loss.
    await db.insert(contacts).values({
      name: 'Ada Example',
      emails: ['ada@example.test'],
      phones: ['(415) 555-1212'],
      contractorId,
      type: 'lead',
      status: 'new',
    });
    await expect(ingestLead(contractorId, leadInput())).rejects.toMatchObject({
      code: 'LEAD_IDENTITY_AMBIGUOUS',
    });
  });

  it('rejects identity fields split across two stored contacts instead of enriching either one', async () => {
    await db.insert(contacts).values([
      {
        name: 'Ada Example',
        emails: ['ada@example.test'],
        phones: [],
        contractorId,
        type: 'lead',
        status: 'new',
      },
      {
        name: 'Someone Else',
        emails: [],
        phones: ['(415) 555-1212'],
        contractorId,
        type: 'lead',
        status: 'new',
      },
    ]);

    await expect(ingestLead(contractorId, leadInput({
      skipContactMatching: true,
    }))).rejects.toMatchObject({ code: 'LEAD_IDENTITY_AMBIGUOUS' });
    expect(await tenantRows()).toHaveLength(2);
  });

  it('deduplicates at the 24-hour boundary, permits a later inquiry, and remembers a reused submission', async () => {
    const initial = await ingestLead(contractorId, leadInput({
      source: 'first-channel',
      submissionId: 'provider-a',
      notes: 'first note',
    }));
    await db.execute(sql`
      UPDATE leads
      SET created_at = NOW() - INTERVAL '23 hours 59 minutes 59 seconds'
      WHERE id = ${initial.lead.id} AND contractor_id = ${contractorId}
    `);

    const duplicate = await ingestLead(contractorId, leadInput({
      source: 'second-channel',
      submissionId: 'provider-b',
      emails: ['ada@example.test', 'richer@example.test'],
      notes: 'second note',
    }));
    expect(duplicate.skippedDuplicateLead).toBe(true);
    expect(duplicate.contact.notes).toContain('second note');

    // This retry has no matching person fields; the stored provider-b receipt
    // still resolves it to the retained contact and avoids a new lead.
    const retried = await ingestLead(contractorId, leadInput({
      source: 'second-channel',
      submissionId: 'provider-b',
      name: 'Unknown Lead',
      emails: [],
      phones: [],
    }));
    expect(retried.contact.id).toBe(initial.contact.id);
    expect(retried.lead.id).toBe(initial.lead.id);
    expect(retried.skippedDuplicateLead).toBe(true);

    await db.execute(sql`
      UPDATE leads
      SET created_at = NOW() - INTERVAL '24 hours 1 second'
      WHERE id = ${initial.lead.id} AND contractor_id = ${contractorId}
    `);
    const later = await ingestLead(contractorId, leadInput({ source: 'later-channel' }));
    expect(later.skippedDuplicateLead).toBe(false);
    expect(later.contact.id).toBe(initial.contact.id);
    expect(await tenantRows()).toHaveLength(2);
  });

  it('finalizes a receipt after a failure following lead insertion', async () => {
    const activityExternalId = unique('recovery-activity');
    const submissionId = unique('recovery-submission');
    const createActivity = vi.spyOn(storage, 'createActivity')
      .mockRejectedValueOnce(new Error('simulated activity persistence failure'));
    const firstInput = leadInput({
      source: 'recovery-channel',
      submissionId,
      activityExternalId,
      activityNote: 'initial capture activity',
      notes: 'initial receipt note',
    });
    await expect(ingestLead(contractorId, firstInput)).rejects.toThrow('simulated activity persistence failure');
    createActivity.mockRestore();

    const recovered = await ingestLead(contractorId, leadInput({
      source: 'recovery-channel',
      submissionId,
      activityExternalId,
      activityNote: 'initial capture activity',
      notes: 'revised receipt note',
      emails: ['ada@example.test', 'recovered@example.test'],
    }));
    const savedActivities = await db.select().from(activities).where(and(
      eq(activities.contractorId, contractorId),
      eq(activities.externalId, activityExternalId),
      eq(activities.externalSource, 'lead_capture'),
    ));
    const [savedContact] = await db.select().from(contacts).where(and(
      eq(contacts.id, recovered.contact.id),
      eq(contacts.contractorId, contractorId),
    ));

    expect(savedActivities).toHaveLength(1);
    expect(savedActivities[0].leadId).toBe(recovered.lead.id);
    expect(savedContact.notes).toContain('revised receipt note');
    expect(savedContact.emails).toEqual(expect.arrayContaining(['recovered@example.test']));
  });
});