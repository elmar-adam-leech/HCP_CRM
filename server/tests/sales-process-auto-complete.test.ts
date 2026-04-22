import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { eq, sql } from 'drizzle-orm';

import { db } from '../db';
import {
  contractors,
  contacts,
  leads,
  salesProcesses,
  salesProcessSteps,
  salesProcessTaskInstances,
} from '@shared/schema';
import { storage } from '../storage';
import { materializeForLead } from '../services/sales-process';

/**
 * End-to-end integration coverage for the sales-process auto-completion
 * pathway (task #509). The unit suite in services/sales-process.test.ts
 * mocks the storage layer; this suite exercises the real Postgres write
 * path so the wiring between storage.createActivity → onActivityCreated
 * → markTaskCompleted is verified against actual SQL.
 */
describe('sales-process auto-completion (integration)', () => {
  const contractorId = randomUUID();
  const contactId = randomUUID();
  let leadId = '';
  let processId = '';

  beforeAll(async () => {
    await db.insert(contractors).values({
      id: contractorId,
      name: 'Auto-Complete Test Tenant',
      domain: `auto-complete-${contractorId}.example.com`,
    });
    await db.insert(contacts).values({
      id: contactId,
      name: 'Test Lead Contact',
      phones: ['+15555550000'],
      type: 'lead',
      contractorId,
    });
    const leadRows = await db.insert(leads).values({
      contactId,
      contractorId,
      status: 'new',
      archived: false,
    }).returning();
    leadId = leadRows[0].id;

    const procRows = await db.insert(salesProcesses).values({
      contractorId,
      name: 'Default sales process',
      active: true,
    }).returning();
    processId = procRows[0].id;
    await db.insert(salesProcessSteps).values({
      salesProcessId: processId,
      dayOffset: 0,
      actionType: 'call',
      mode: 'manual',
      displayOrder: 0,
    });
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM sales_process_task_instances WHERE contractor_id = ${contractorId}`);
    await db.execute(sql`DELETE FROM sales_process_steps WHERE sales_process_id = ${processId}`);
    await db.execute(sql`DELETE FROM sales_processes WHERE contractor_id = ${contractorId}`);
    await db.execute(sql`DELETE FROM activities WHERE contractor_id = ${contractorId}`);
    await db.execute(sql`DELETE FROM leads WHERE contractor_id = ${contractorId}`);
    await db.execute(sql`DELETE FROM contacts WHERE contractor_id = ${contractorId}`);
    await db.execute(sql`DELETE FROM contractors WHERE id = ${contractorId}`);
  });

  it('clears the matching Day-0 call task when the rep logs an outbound call', async () => {
    const lead = (await db.select().from(leads).where(eq(leads.id, leadId)))[0];
    expect(lead).toBeTruthy();

    const materializedCount = await materializeForLead(lead);
    expect(materializedCount).toBe(1);

    const beforeRows = await db.select().from(salesProcessTaskInstances)
      .where(eq(salesProcessTaskInstances.leadId, leadId));
    expect(beforeRows).toHaveLength(1);
    expect(beforeRows[0].status).toBe('pending');
    expect(beforeRows[0].actionType).toBe('call');

    // Logging an outbound call activity should fire the auto-completion
    // hook synchronously (createActivity awaits it under try/catch).
    const activity = await storage.createActivity({
      type: 'call',
      title: 'Outgoing call - Day 0',
      content: 'Reached customer, scheduled an estimate.',
      metadata: { callType: 'outbound' },
      contactId,
    }, contractorId);

    // Side-channel field that the POST /api/activities route forwards to
    // the client so the rep sees the subtle "cleared from cadence"
    // confirmation in the toast.
    const sideChannel = (activity as { autoCompletedCadenceTask?: { id: string; actionType: string } })
      .autoCompletedCadenceTask;
    expect(sideChannel).toBeTruthy();
    expect(sideChannel?.id).toBe(beforeRows[0].id);
    expect(sideChannel?.actionType).toBe('call');

    const afterRows = await db.select().from(salesProcessTaskInstances)
      .where(eq(salesProcessTaskInstances.leadId, leadId));
    expect(afterRows).toHaveLength(1);
    expect(afterRows[0].status).toBe('completed');
    expect(afterRows[0].completionReason).toBe('activity_logged');
    expect(afterRows[0].completedAt).toBeTruthy();
  });
});
