import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { sql, eq, and } from 'drizzle-orm';

// Mock gmailService.fetchNewEmails so we don't make a real API call. The Gmail
// sync handler should still run end-to-end for the shared-inbox branch: dedup,
// contact match, persistence, and the realtime `new_message` broadcast.
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
import {
  contractors,
  contacts,
  leads,
  activities,
  sharedEmailAccounts,
} from '@shared/schema';
import { syncGmail } from '../sync/gmail';

describe('Shared inbox Gmail sync → realtime new_message broadcast', () => {
  const contractorId = randomUUID();
  const contactId = randomUUID();
  const senderEmail = `shared-sender-${randomUUID()}@example.com`;
  const sharedMailboxEmail = `shared-mailbox-${randomUUID()}@example.com`;

  beforeAll(async () => {
    await db.execute(sql`ALTER TABLE activities ADD COLUMN IF NOT EXISTS read_at timestamp`);

    await db.insert(contractors).values({
      id: contractorId,
      name: 'Shared Inbox Realtime Test Tenant',
      domain: `test-${contractorId}.example.com`,
    });
    await db.insert(sharedEmailAccounts).values({
      contractorId,
      email: sharedMailboxEmail,
      gmailRefreshToken: 'mock-shared-refresh-token',
    });
    await db.insert(contacts).values({
      id: contactId,
      name: 'Shared Inbox Sender',
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
    await db.execute(sql`DELETE FROM shared_email_accounts WHERE contractor_id = ${contractorId}`);
    await db.execute(sql`DELETE FROM contractors WHERE id = ${contractorId}`);
  });

  it('broadcasts new_message and persists the inbound email as unread when the shared inbox sync ingests it', async () => {
    const gmailMessageId = `gmail-shared-msg-${randomUUID()}`;

    fetchNewEmailsMock.mockResolvedValueOnce({
      emails: [
        {
          id: gmailMessageId,
          threadId: `thread-${randomUUID()}`,
          from: senderEmail,
          to: [sharedMailboxEmail],
          subject: 'Hello from shared inbox',
          body: 'Inbound email arriving via the shared company mailbox.',
          date: new Date(),
          snippet: 'Inbound email arriving...',
          labelIds: ['INBOX'],
        },
      ],
    });

    broadcastSpy.mockClear();

    await syncGmail(contractorId);

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

    const rows = await db
      .select({
        id: activities.id,
        readAt: activities.readAt,
        contactId: activities.contactId,
        userId: activities.userId,
      })
      .from(activities)
      .where(and(
        eq(activities.contractorId, contractorId),
        eq(activities.externalId, gmailMessageId),
      ));
    expect(rows).toHaveLength(1);
    expect(rows[0].contactId).toBe(contactId);
    expect(rows[0].readAt).toBeNull();
    // Shared inbox activities are system-attributed (no user).
    expect(rows[0].userId).toBeNull();
  });
});
