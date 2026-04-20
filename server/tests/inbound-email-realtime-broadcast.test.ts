import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { sql, eq, and } from 'drizzle-orm';

// Mock gmailService.fetchNewEmails so we don't make a real API call. The Gmail
// sync handler should still run end-to-end: dedup, contact match, persistence,
// and the realtime `new_message` broadcast.
const fetchNewEmailsMock = vi.fn();
vi.mock('../gmail-service', () => ({
  gmailService: {
    fetchNewEmails: (...args: unknown[]) => fetchNewEmailsMock(...args),
  },
}));

// Spy on broadcastToContractor — that's what the unread-badge hooks listen to.
const broadcastSpy = vi.fn();
vi.mock('../websocket', () => ({
  broadcastToContractor: (...args: unknown[]) => broadcastSpy(...args),
}));

import { db } from '../db';
import { contractors, contacts, leads, users, activities } from '@shared/schema';
import { syncGmail } from '../sync/gmail';

describe('Gmail inbound sync → realtime new_message broadcast', () => {
  const contractorId = randomUUID();
  const userId = randomUUID();
  const contactId = randomUUID();
  const senderEmail = `sender-${randomUUID()}@example.com`;
  const mailboxEmail = `mailbox-${randomUUID()}@example.com`;

  beforeAll(async () => {
    await db.execute(sql`ALTER TABLE activities ADD COLUMN IF NOT EXISTS read_at timestamp`);

    await db.insert(contractors).values({
      id: contractorId,
      name: 'Inbound Email Realtime Test Tenant',
      domain: `test-${contractorId}.example.com`,
    });
    await db.insert(users).values({
      id: userId,
      username: `tester-${userId}`,
      password: 'irrelevant',
      name: 'Test User',
      email: `tester-${userId}@example.com`,
      role: 'admin',
      contractorId,
      gmailConnected: true,
      gmailRefreshToken: 'mock-refresh-token',
      gmailEmail: mailboxEmail,
    });
    await db.insert(contacts).values({
      id: contactId,
      name: 'Inbound Sender',
      emails: [senderEmail],
      type: 'lead',
      contractorId,
    });
    await db.insert(leads).values({
      contactId,
      contractorId,
      status: 'new',
      archived: false,
    });
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM activities WHERE contractor_id = ${contractorId}`);
    await db.execute(sql`DELETE FROM leads WHERE contractor_id = ${contractorId}`);
    await db.execute(sql`DELETE FROM contacts WHERE contractor_id = ${contractorId}`);
    await db.execute(sql`DELETE FROM users WHERE id = ${userId}`);
    await db.execute(sql`DELETE FROM contractors WHERE id = ${contractorId}`);
  });

  it('broadcasts new_message and persists the inbound email as unread when Gmail sync ingests it', async () => {
    const gmailMessageId = `gmail-msg-${randomUUID()}`;

    fetchNewEmailsMock.mockResolvedValueOnce({
      emails: [
        {
          id: gmailMessageId,
          threadId: `thread-${randomUUID()}`,
          from: senderEmail,
          to: [mailboxEmail],
          subject: 'Hello from inbound',
          body: 'This is a real inbound email coming through the sync handler.',
          date: new Date(),
          snippet: 'This is a real inbound...',
          labelIds: ['INBOX'],
        },
      ],
    });

    broadcastSpy.mockClear();

    await syncGmail(contractorId);

    // The Gmail sync handler must broadcast a realtime `new_message` for the
    // inbound email so the unread-badge hooks re-fetch immediately.
    type NewMessagePayload = { type: 'new_message'; contactId: string };
    const isNewMessagePayload = (value: unknown): value is NewMessagePayload => {
      if (!value || typeof value !== 'object') return false;
      const v = value as Record<string, unknown>;
      return v.type === 'new_message' && typeof v.contactId === 'string';
    };
    const newMessageCalls = broadcastSpy.mock.calls.filter(([tenant, payload]) =>
      tenant === contractorId
      && isNewMessagePayload(payload)
      && payload.contactId === contactId
    );
    expect(newMessageCalls).toHaveLength(1);

    // The activity row should be persisted as unread (read_at IS NULL) so it
    // counts toward the unread badges on the next refetch.
    const rows = await db
      .select({
        id: activities.id,
        readAt: activities.readAt,
        contactId: activities.contactId,
      })
      .from(activities)
      .where(and(
        eq(activities.contractorId, contractorId),
        eq(activities.externalId, gmailMessageId),
      ));
    expect(rows).toHaveLength(1);
    expect(rows[0].contactId).toBe(contactId);
    expect(rows[0].readAt).toBeNull();
  });
});
