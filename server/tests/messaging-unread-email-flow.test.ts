import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { sql } from 'drizzle-orm';

// Stub the gmail send so we don't make a real API call. The route only cares
// that sendEmail() resolves with success — everything else (storing the
// activity, broadcasting, etc.) is real.
vi.mock('../gmail-service', () => ({
  gmailService: {
    sendEmail: vi.fn().mockResolvedValue({ success: true, messageId: 'mock-msg-id' }),
  },
}));

// broadcastToContractor would otherwise try to push to live WebSocket clients.
const broadcastSpy = vi.fn();
vi.mock('../websocket', () => ({
  broadcastToContractor: (...args: unknown[]) => broadcastSpy(...args),
}));

// Dialpad and provider modules are imported transitively by routes/messaging.ts
// but we only hit the email + mark-read endpoints. Stub them defensively so
// importing routes/messaging.ts doesn't trigger real network behavior.
vi.mock('../dialpad', () => ({ DialpadService: class {} }));
vi.mock('../providers/provider-service', () => ({
  providerService: {
    initiateCall: vi.fn(),
    getAvailableProviders: () => [],
    setTenantProvider: vi.fn(),
  },
}));

import { db } from '../db';
import { contractors, contacts, leads, users, activities, messages } from '@shared/schema';
import { storage } from '../storage';
import { messagingMethods } from '../storage/messaging';
import { registerMessagingRoutes } from '../routes/messaging';

const TEST_USER = { contractorId: '', userId: '' };

let server: http.Server | undefined;
let baseUrl = '';

async function startApp(): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = {
      contractorId: TEST_USER.contractorId,
      userId: TEST_USER.userId,
      role: 'admin',
    };
    next();
  });
  registerMessagingRoutes(app);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const { port } = server!.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
}

describe('Email unread badge flow (route-level integration)', () => {
  const contractorId = randomUUID();
  const domain = `test-${contractorId}.example.com`;
  const contactId = randomUUID();
  const otherContactId = randomUUID();
  const userId = randomUUID();

  beforeAll(async () => {
    // Ensure the activities.read_at column exists on the local schema.
    // In production it is added by `npm run db:push --force`; CI/dev DBs may
    // lag behind, so apply it idempotently here.
    await db.execute(sql`ALTER TABLE activities ADD COLUMN IF NOT EXISTS read_at timestamp`);

    await db.insert(contractors).values({
      id: contractorId,
      name: 'Unread Email Flow Test Tenant',
      domain,
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
      gmailEmail: 'support@example.com',
    });
    await db.insert(contacts).values([
      {
        id: contactId,
        name: 'Inbound Sender',
        emails: ['inbound@example.com'],
        type: 'lead',
        contractorId,
      },
      {
        id: otherContactId,
        name: 'Other Contact',
        emails: ['other@example.com'],
        type: 'lead',
        contractorId,
      },
    ]);
    // A non-archived lead keeps the contact in scope for the unread summary's
    // archive-exclusion logic.
    await db.insert(leads).values([
      { contactId, contractorId, status: 'new', archived: false },
      { contactId: otherContactId, contractorId, status: 'new', archived: false },
    ]);

    TEST_USER.contractorId = contractorId;
    TEST_USER.userId = userId;
    await startApp();
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      if (!server) return resolve();
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await db.execute(sql`DELETE FROM activities WHERE contractor_id = ${contractorId}`);
    await db.execute(sql`DELETE FROM leads WHERE contractor_id = ${contractorId}`);
    await db.execute(sql`DELETE FROM contacts WHERE contractor_id = ${contractorId}`);
    await db.execute(sql`DELETE FROM users WHERE id = ${userId}`);
    await db.execute(sql`DELETE FROM contractors WHERE id = ${contractorId}`);
    // Intentionally do NOT close the global db pool — other test files share it.
  });

  it('lights up email badges for inbound emails and clears them via the mark-read endpoint', async () => {
    // Baseline: no unread for this brand-new tenant.
    expect(await messagingMethods.getUnreadMessageSummary(contractorId)).toEqual({
      messages: false,
      leads: false,
      estimates: false,
    });
    expect(await messagingMethods.getUnreadMessageCount(contractorId)).toBe(0);
    expect(await messagingMethods.getUnreadCountsByContactIds(contractorId, [contactId, otherContactId])).toEqual({});

    // Simulate two inbound emails arriving (Gmail sync code path uses
    // storage.createActivity, which routes through deriveInitialReadAt and
    // leaves read_at = NULL for inbound).
    await storage.createActivity({
      type: 'email',
      title: 'Email received: Hello',
      content: 'Hi there',
      metadata: {
        subject: 'Hello',
        from: 'inbound@example.com',
        to: ['support@example.com'],
        direction: 'inbound',
      },
      contactId,
    }, contractorId);
    await storage.createActivity({
      type: 'email',
      title: 'Email received: Follow up',
      content: 'Following up',
      metadata: {
        subject: 'Follow up',
        from: 'inbound@example.com',
        to: ['support@example.com'],
        direction: 'inbound',
      },
      contactId,
    }, contractorId);

    // Sidebar dot + lead-card badge should both light up.
    expect(await messagingMethods.getUnreadMessageSummary(contractorId)).toEqual({
      messages: true,
      leads: true,
      estimates: false,
    });
    expect(await messagingMethods.getUnreadMessageCount(contractorId)).toBe(1);
    const perContact = await messagingMethods.getUnreadCountsByContactIds(
      contractorId,
      [contactId, otherContactId],
    );
    expect(perContact[contactId]).toEqual({ text: 0, email: 2 });
    expect(perContact[otherContactId]).toBeUndefined();

    // Send an outbound email through the real /api/messages/send-email route.
    // This hits storage.createActivity with direction=outbound, which must NOT
    // contribute to the unread count.
    const sendResp = await fetch(`${baseUrl}/api/messages/send-email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        to: 'inbound@example.com',
        subject: 'Re: Hello',
        content: 'Thanks for reaching out',
        contactId,
      }),
    });
    expect(sendResp.status).toBe(200);
    const sendBody = await sendResp.json();
    expect(sendBody.success).toBe(true);

    // Counts unchanged after outbound send.
    expect(await messagingMethods.getUnreadMessageCount(contractorId)).toBe(1);
    const afterOutbound = await messagingMethods.getUnreadCountsByContactIds(
      contractorId,
      [contactId, otherContactId],
    );
    expect(afterOutbound[contactId]).toEqual({ text: 0, email: 2 });

    // Pre-condition: the two inbound rows are still unread (read_at IS NULL),
    // and the outbound row is already stamped (so it never counted as unread).
    const preMarkRows = await db.execute<{ direction: string; read_at: string | null }>(sql`
      SELECT (metadata::jsonb)->>'direction' AS direction, read_at
      FROM activities
      WHERE contractor_id = ${contractorId} AND type = 'email'
    `);
    const inboundBefore = preMarkRows.rows.filter((r) => r.direction === 'inbound');
    const outboundBefore = preMarkRows.rows.filter((r) => r.direction === 'outbound');
    expect(inboundBefore).toHaveLength(2);
    for (const row of inboundBefore) expect(row.read_at).toBeNull();
    expect(outboundBefore).toHaveLength(1);
    expect(outboundBefore[0].read_at).not.toBeNull();

    // Open the conversation — hit the real mark-read endpoint that the
    // frontend calls when the user views the thread.
    const markResp = await fetch(`${baseUrl}/api/conversations/${contactId}/read`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'email' }),
    });
    expect(markResp.status).toBe(200);
    const markBody = await markResp.json();
    expect(markBody.markedCount).toBe(2);

    // The route should also have broadcast the messages_read event.
    expect(broadcastSpy).toHaveBeenCalledWith(
      contractorId,
      expect.objectContaining({ type: 'messages_read', contactId }),
    );

    // All three badge sources are clear.
    expect(await messagingMethods.getUnreadMessageSummary(contractorId)).toEqual({
      messages: false,
      leads: false,
      estimates: false,
    });
    expect(await messagingMethods.getUnreadMessageCount(contractorId)).toBe(0);
    expect(await messagingMethods.getUnreadCountsByContactIds(contractorId, [contactId, otherContactId])).toEqual({});

    // And every inbound email row now has a non-null read_at stamp.
    const rows = await db.execute<{ read_at: string | null; direction: string }>(sql`
      SELECT read_at, (metadata::jsonb)->>'direction' AS direction
      FROM activities
      WHERE contractor_id = ${contractorId} AND type = 'email'
    `);
    expect(rows.rows.length).toBeGreaterThanOrEqual(3); // 2 inbound + 1 outbound
    for (const row of rows.rows) {
      expect(row.read_at).not.toBeNull();
    }
  });

  it('lists email-only and mixed unread conversations via GET /api/conversations?unreadOnly=true', async () => {
    // Clean any prior emails/messages for a fresh slate.
    await db.execute(sql`DELETE FROM activities WHERE contractor_id = ${contractorId}`);
    await db.execute(sql`DELETE FROM messages WHERE contractor_id = ${contractorId}`);

    // Email-only contact: a single inbound email, no SMS.
    await storage.createActivity({
      type: 'email',
      title: 'Email received: Email-only ping',
      content: 'Email only',
      metadata: {
        subject: 'Email-only ping',
        from: 'inbound@example.com',
        to: ['support@example.com'],
        direction: 'inbound',
      },
      contactId,
    }, contractorId);

    // Mixed contact: an inbound SMS AND an inbound email.
    await db.insert(messages).values({
      type: 'text',
      status: 'delivered',
      direction: 'inbound',
      content: 'Hi via SMS',
      toNumber: '+15555550000',
      fromNumber: '+15555550001',
      contactId: otherContactId,
      contractorId,
    });
    await storage.createActivity({
      type: 'email',
      title: 'Email received: Also email',
      content: 'Also email',
      metadata: {
        subject: 'Also email',
        from: 'other@example.com',
        to: ['support@example.com'],
        direction: 'inbound',
      },
      contactId: otherContactId,
    }, contractorId);

    // Hit the actual route the frontend uses for the Unread tab.
    const resp = await fetch(`${baseUrl}/api/conversations?unreadOnly=true`);
    expect(resp.status).toBe(200);
    const list = (await resp.json()) as Array<{ contactId: string; unreadCount: number }>;

    const byContact = new Map(list.map((c) => [c.contactId, c]));
    expect(byContact.has(contactId)).toBe(true);
    expect(byContact.get(contactId)!.unreadCount).toBeGreaterThanOrEqual(1);

    // Mixed contact appears exactly once with both unread items counted.
    const mixedRows = list.filter((c) => c.contactId === otherContactId);
    expect(mixedRows).toHaveLength(1);
    expect(mixedRows[0].unreadCount).toBe(2);

    // Mark the email-only contact's emails as read — it should drop off the list.
    const markEmail = await fetch(`${baseUrl}/api/conversations/${contactId}/read`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'email' }),
    });
    expect(markEmail.status).toBe(200);

    // Mark the mixed contact's SMS + email as read — it too should drop off.
    const markMixed = await fetch(`${baseUrl}/api/conversations/${otherContactId}/read`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(markMixed.status).toBe(200);

    const respAfter = await fetch(`${baseUrl}/api/conversations?unreadOnly=true`);
    const listAfter = (await respAfter.json()) as Array<{ contactId: string }>;
    expect(listAfter.find((c) => c.contactId === contactId)).toBeUndefined();
    expect(listAfter.find((c) => c.contactId === otherContactId)).toBeUndefined();

    // Sidebar count is also clear.
    expect(await messagingMethods.getUnreadMessageCount(contractorId)).toBe(0);
  });
});
