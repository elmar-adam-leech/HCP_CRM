import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const table = () => new Proxy({}, { get: (_target, property) => String(property) });
  return {
    ingestLead: vi.fn(),
    parseEmailWithAI: vi.fn(),
    runHeuristicSpamCheck: vi.fn(),
    createSpamAuditEntry: vi.fn(),
    failures: {
      listPending: vi.fn(),
      record: vi.fn(),
      resolve: vi.fn(),
    },
    fetchNewEmails: vi.fn(),
    fetchPageText: vi.fn(),
    extractFirstUrl: vi.fn(),
    getContractor: vi.fn(),
    updateLeadCaptureInboxSyncTime: vi.fn(),
    notifyLeadIdentityAmbiguity: vi.fn(),
    db: {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => Promise.resolve([])),
        })),
      })),
    },
    activities: table(),
    contacts: table(),
  };
});

vi.mock('@shared/schema', () => ({ activities: h.activities, contacts: h.contacts }));
vi.mock('../gmail-service', () => ({ gmailService: { fetchNewEmails: h.fetchNewEmails } }));
vi.mock('./email-ai-parser', () => ({
  parseEmailWithAI: h.parseEmailWithAI,
  runHeuristicSpamCheck: h.runHeuristicSpamCheck,
}));
vi.mock('../storage/email-parse-failures', () => ({ emailParseFailureStore: h.failures }));
vi.mock('./link-fetcher', () => ({
  extractFirstUrl: h.extractFirstUrl,
  extractUrlByPattern: vi.fn(),
  fetchPageText: h.fetchPageText,
  extractMarketingUrl: vi.fn(),
  KNOWN_PLATFORMS: new Set(),
  SOURCE_ABBREVIATIONS: {},
}));
vi.mock('../storage', () => ({
  storage: {
    getContractor: h.getContractor,
    findActivitiesByRfc822MessageIds: vi.fn(),
    createSpamAuditEntry: h.createSpamAuditEntry,
    updateLeadCaptureInboxSyncTime: h.updateLeadCaptureInboxSyncTime,
  },
}));
vi.mock('../storage/contacts', () => ({ emailInvolvesContact: vi.fn() }));
vi.mock('../db', () => ({ db: h.db }));
vi.mock('../utils/logger', () => ({
  logger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../utils/phone-normalizer', () => ({
  normalizePhoneForStorage: (value: string) => value.replace(/\D/g, ''),
}));
vi.mock('../utils/pii-redactor', () => ({ maskEmail: (value: string) => value }));
vi.mock('./lead-ingestion', () => ({ ingestLead: h.ingestLead }));
vi.mock('./lead-identity-ambiguity', () => ({
  isLeadIdentityAmbiguity: (error: unknown) => (error as { code?: unknown })?.code === 'LEAD_IDENTITY_AMBIGUOUS',
  notifyLeadIdentityAmbiguity: h.notifyLeadIdentityAmbiguity,
}));
vi.mock('../websocket', () => ({ broadcastToContractor: vi.fn() }));
vi.mock('./inbound-reply-dispatcher', () => ({ dispatchInboundReplyWorkflows: vi.fn() }));

import { syncLeadCaptureInbox } from './lead-capture-sync';

const PERSON_BODY = [
  'Name: Ada Example',
  'Email: ada@example.test',
  'Phone: (415) 555-0100',
].join('\n');

function inbox(actions: Array<'each_email_is_new_lead' | 'follow_link'>) {
  return {
    id: 'inbox-1',
    contractorId: 'tenant-1',
    gmailRefreshToken: 'refresh',
    senderRules: [{
      senderEmail: 'notifications@lead-source.test',
      actions,
      fieldMappings: [
        { label: 'Name:', field: 'name' },
        { label: 'Email:', field: 'email' },
        { label: 'Phone:', field: 'phone' },
      ],
    }],
    spamFilterEnabled: false,
    lastSyncAt: null,
    emailAddress: 'team@example.test',
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.failures.listPending.mockResolvedValue([]);
  h.failures.record.mockResolvedValue(undefined);
  h.failures.resolve.mockResolvedValue(undefined);
  h.createSpamAuditEntry.mockReset();
  h.runHeuristicSpamCheck.mockReturnValue({ isSpam: false, confidence: 0 });
  h.getContractor.mockResolvedValue({ domain: 'example.test', autoLearnReplyAddresses: true });
  h.fetchNewEmails.mockResolvedValue({
    emails: [{
      id: 'gmail-message-1',
      labelIds: ['INBOX'],
      from: 'notifications@lead-source.test',
      subject: 'New form lead',
      body: PERSON_BODY,
      to: ['team@example.test'],
    }],
  });
  h.extractFirstUrl.mockReturnValue('https://lead-source.test/submission/1');
  h.fetchPageText.mockResolvedValue(PERSON_BODY);
  h.ingestLead.mockResolvedValue({
    contact: { id: 'contact-1' },
    lead: { id: 'lead-1' },
    isNewContact: true,
    skippedDuplicateLead: false,
  });
  h.parseEmailWithAI.mockResolvedValue({ status: 'success', isSpam: false });
  h.updateLeadCaptureInboxSyncTime.mockResolvedValue(undefined);
  h.notifyLeadIdentityAmbiguity.mockResolvedValue(undefined);
});

describe('failed email parsing and retries', () => {
  const failed = { status: 'failed', errorCode: 'api_error', message: 'AI parsing is unavailable.' };
  function aiInbox() {
    const value = inbox(['each_email_is_new_lead']);
    value.senderRules[0].fieldMappings = [];
    value.spamFilterEnabled = true;
    return value;
  }

  it.each(['missing_credentials', 'api_error', 'empty_output', 'truncated_output', 'invalid_output'])(
    'retains %s without marking spam or ingesting a lead', async (errorCode) => {
      h.parseEmailWithAI.mockResolvedValue({ ...failed, errorCode });
      const stats = await syncLeadCaptureInbox(aiInbox());
      expect(stats).toMatchObject({ parseFailed: 1, processed: 0, skippedSpam: 0, errors: 0 });
      expect(h.failures.record).toHaveBeenCalledWith(expect.objectContaining({
        contractorId: 'tenant-1', inboxId: 'inbox-1', errorCode,
        email: expect.objectContaining({ id: 'gmail-message-1', body: PERSON_BODY }),
      }));
      expect(h.ingestLead).not.toHaveBeenCalled();
      expect(h.createSpamAuditEntry).not.toHaveBeenCalled();
      expect(h.updateLeadCaptureInboxSyncTime).toHaveBeenCalledOnce();
    },
  );

  it('does not advance the checkpoint when retaining an email fails', async () => {
    h.parseEmailWithAI.mockResolvedValue(failed);
    h.failures.record.mockRejectedValueOnce(new Error('Database unavailable'));
    const stats = await syncLeadCaptureInbox(aiInbox());
    expect(stats.errors).toBe(1);
    expect(h.updateLeadCaptureInboxSyncTime).not.toHaveBeenCalled();
    expect(h.ingestLead).not.toHaveBeenCalled();
  });

  it('retries saved emails after they disappear from Gmail and resolves only after successful ingestion', async () => {
    const saved = {
      messageId: 'saved-1',
      email: { id: 'saved-1', from: 'notifications@lead-source.test', subject: 'Saved inquiry', body: PERSON_BODY, labelIds: [] },
    };
    h.failures.listPending.mockResolvedValue([saved]);
    h.fetchNewEmails.mockResolvedValue({ emails: [] });
    await syncLeadCaptureInbox(aiInbox());
    expect(h.ingestLead).toHaveBeenCalledWith('tenant-1', expect.objectContaining({
      submissionId: 'saved-1', activityExternalId: 'saved-1', identityPolicy: 'two-field',
    }));
    expect(h.failures.resolve).toHaveBeenCalledWith('tenant-1', 'inbox-1', 'saved-1');
    expect(h.ingestLead.mock.invocationCallOrder[0]).toBeLessThan(h.failures.resolve.mock.invocationCallOrder[0]);
  });

  it('deduplicates Gmail and saved copies, leaving a repeated failure pending', async () => {
    const fetched = await h.fetchNewEmails();
    h.fetchNewEmails.mockClear();
    h.failures.listPending.mockResolvedValue([{ messageId: 'gmail-message-1', email: fetched.emails[0] }]);
    h.parseEmailWithAI.mockResolvedValue(failed);
    await syncLeadCaptureInbox(aiInbox());
    expect(h.parseEmailWithAI).toHaveBeenCalledOnce();
    expect(h.failures.record).toHaveBeenCalledOnce();
    expect(h.failures.resolve).not.toHaveBeenCalled();
    expect(h.ingestLead).not.toHaveBeenCalled();
  });

  it('manual retry skips Gmail and never advances the inbox checkpoint', async () => {
    const email = (await h.fetchNewEmails()).emails[0];
    h.fetchNewEmails.mockClear();
    h.failures.listPending.mockResolvedValue([{ messageId: email.id, email }]);
    await syncLeadCaptureInbox(aiInbox(), email);
    expect(h.fetchNewEmails).not.toHaveBeenCalled();
    expect(h.updateLeadCaptureInboxSyncTime).not.toHaveBeenCalled();
    expect(h.failures.resolve).toHaveBeenCalledOnce();
  });

  it('retains pending emails if lead ingestion fails after parsing succeeds', async () => {
    const email = (await h.fetchNewEmails()).emails[0];
    h.failures.listPending.mockResolvedValue([{ messageId: email.id, email }]);
    h.ingestLead.mockRejectedValueOnce(new Error('Storage failure'));
    const stats = await syncLeadCaptureInbox(aiInbox(), email);
    expect(stats.errors).toBe(1);
    expect(h.failures.resolve).not.toHaveBeenCalled();
  });

  it('resolves a previously ingested email without parsing or dispatching ingestion again', async () => {
    const email = (await h.fetchNewEmails()).emails[0];
    h.failures.listPending.mockResolvedValue([{ messageId: email.id, email }]);
    h.db.select.mockReturnValueOnce({
      from: vi.fn(() => ({ where: vi.fn(() => Promise.resolve([{ externalId: email.id }])) })),
    } as any);
    const stats = await syncLeadCaptureInbox(aiInbox(), email);
    expect(stats.skippedDuplicate).toBe(1);
    expect(h.parseEmailWithAI).not.toHaveBeenCalled();
    expect(h.ingestLead).not.toHaveBeenCalled();
    expect(h.failures.resolve).toHaveBeenCalledWith('tenant-1', 'inbox-1', email.id);
  });

  it('uses the active tenant and inbox when loading and saving failures', async () => {
    const configured = { ...aiInbox(), contractorId: 'tenant-2', id: 'inbox-2' };
    h.parseEmailWithAI.mockResolvedValue(failed);
    await syncLeadCaptureInbox(configured);
    expect(h.failures.listPending).toHaveBeenCalledWith('tenant-2', 'inbox-2');
    expect(h.failures.record).toHaveBeenCalledWith(expect.objectContaining({
      contractorId: 'tenant-2', inboxId: 'inbox-2',
    }));
  });

  it.each(['ai', 'heuristic', 'sender-block'])(
    'keeps one spam disposition identity across concurrent retries and replay (%s)', async (path) => {
      const email = (await h.fetchNewEmails()).emails[0];
      h.failures.listPending.mockResolvedValue([{ messageId: email.id, email }]);
      const configured = aiInbox();
      h.parseEmailWithAI.mockResolvedValue({ status: 'success', isSpam: true, spamConfidence: 95 });
      if (path === 'heuristic') {
        h.runHeuristicSpamCheck.mockReturnValue({ isSpam: true, confidence: 90, reason: 'Heuristic spam' });
      }
      if (path === 'sender-block') configured.senderRules[0].spamOverride = 'always_block';

      // Model the storage uniqueness contract; the storage suite separately
      // verifies the actual conflict target, SQL and tenant-scoped lookup.
      const rows = new Map<string, object>();
      h.createSpamAuditEntry.mockImplementation(async (entry) => {
        const key = JSON.stringify([entry.contractorId, entry.inboxId, entry.messageId]);
        if (!rows.has(key)) rows.set(key, { ...entry, id: `audit-${rows.size + 1}` });
        return rows.get(key);
      });
      const results = await Promise.all([
        syncLeadCaptureInbox(configured, email),
        syncLeadCaptureInbox(configured, email),
      ]);
      expect(results.every(result => result.skippedSpam === 1)).toBe(true);
      // A normal fetch can replay the same message after resolution, even if
      // the failed-email queue no longer contains it.
      h.failures.listPending.mockResolvedValue([]);
      await syncLeadCaptureInbox(configured);
      expect(h.createSpamAuditEntry).toHaveBeenCalledTimes(3);
      expect(rows.size).toBe(1);
      expect([...rows.values()][0]).toMatchObject({
        contractorId: 'tenant-1', inboxId: 'inbox-1', messageId: email.id,
      });
      expect(h.ingestLead).not.toHaveBeenCalled();
      expect(h.failures.resolve).toHaveBeenCalledWith('tenant-1', 'inbox-1', email.id);
    },
  );
});

describe('lead-capture sender-rule identity handling', () => {
  it.each([
    ['each-email', ['each_email_is_new_lead'] as const],
    ['follow-link', ['follow_link'] as const],
  ])('%s rules retain extracted identity and two-field protection', async (_name, actions) => {
    const result = await syncLeadCaptureInbox(inbox([...actions]));

    expect(result).toMatchObject({ processed: 1, skippedDuplicate: 0, errors: 0 });
    expect(h.ingestLead).toHaveBeenCalledWith('tenant-1', expect.objectContaining({
      name: 'Ada Example',
      emails: ['ada@example.test'],
      phones: ['4155550100'],
      identityPolicy: 'two-field',
      submissionId: 'gmail-message-1',
      activityExternalId: 'gmail-message-1',
      skipDuplicateLeadWithinHours: 24,
    }));
    const leadInput = h.ingestLead.mock.calls[0][1];
    expect(leadInput.emails).not.toContain('notifications@lead-source.test');
    expect(leadInput).not.toHaveProperty('skipContactMatching');
  });

  it('does not treat a mapped notification sender address as the person email', async () => {
    h.fetchNewEmails.mockResolvedValue({
      emails: [{
        id: 'gmail-message-sender-copy',
        labelIds: ['INBOX'],
        from: 'Lead Source <NOTIFICATIONS@lead-source.test>',
        subject: 'New form lead',
        body: [
          'Name: Ada Example',
          'Email: notifications@lead-source.test',
          'Phone: (415) 555-0100',
        ].join('\n'),
        to: ['team@example.test'],
      }],
    });

    await syncLeadCaptureInbox(inbox(['each_email_is_new_lead']));

    expect(h.ingestLead).toHaveBeenCalledWith('tenant-1', expect.objectContaining({
      name: 'Ada Example',
      emails: [],
      phones: ['4155550100'],
    }));
  });

  it('also removes a notification sender address repeated by AI extraction', async () => {
    const configuredInbox = inbox(['follow_link']);
    configuredInbox.senderRules[0].fieldMappings = [];
    h.fetchPageText.mockResolvedValue('Please call the customer at (415) 555-0100');
    h.parseEmailWithAI.mockResolvedValue({
      isSpam: false,
      name: 'Ada Example',
      email: 'NOTIFICATIONS@lead-source.test',
      phone: '(415) 555-0100',
    });

    await syncLeadCaptureInbox(configuredInbox);

    expect(h.ingestLead).toHaveBeenCalledWith('tenant-1', expect.objectContaining({
      name: 'Ada Example',
      emails: [],
      phones: ['4155550100'],
    }));
  });

  it('does not synthesize identity evidence from a notification sender local-part', async () => {
    const configuredInbox = inbox(['each_email_is_new_lead']);
    configuredInbox.senderRules[0].fieldMappings = [];
    h.fetchNewEmails.mockResolvedValue({
      emails: [{
        id: 'gmail-message-no-person-name',
        labelIds: ['INBOX'],
        from: 'shared-leads@lead-source.test',
        subject: 'New form lead',
        body: 'Phone: (415) 555-0100',
        to: ['team@example.test'],
      }],
    });
    // The configured sender address must match the notification sender for
    // this test; no contact field is supplied by the email itself.
    configuredInbox.senderRules[0].senderEmail = 'shared-leads@lead-source.test';
    h.parseEmailWithAI.mockResolvedValue({
      isSpam: false,
      email: 'shared-leads@lead-source.test',
      phone: '(415) 555-0100',
    });

    await syncLeadCaptureInbox(configuredInbox);

    expect(h.ingestLead).toHaveBeenCalledWith('tenant-1', expect.objectContaining({
      name: 'Unknown',
      emails: [],
      phones: ['4155550100'],
    }));
  });

  it('does not use a shared notification/source label as a person name', async () => {
    const configuredInbox = inbox(['each_email_is_new_lead']);
    configuredInbox.senderRules[0].senderEmail = 'noreply@lead-source.test';
    h.fetchNewEmails.mockResolvedValue({
      emails: [{
        id: 'gmail-message-shared-name',
        labelIds: ['INBOX'],
        from: 'noreply@lead-source.test',
        subject: 'New form lead',
        body: [
          'Name: Lead Source',
          'Email: ada@example.test',
          'Phone: (415) 555-0100',
        ].join('\n'),
        to: ['team@example.test'],
      }],
    });

    await syncLeadCaptureInbox(configuredInbox);

    expect(h.ingestLead).toHaveBeenCalledWith('tenant-1', expect.objectContaining({
      name: 'Unknown',
      emails: ['ada@example.test'],
      phones: ['4155550100'],
    }));
  });

  it('leaves the checkpoint unchanged and alerts admins when an identity is ambiguous', async () => {
    const ambiguity = Object.assign(new Error('Resolve duplicate contacts and retry.'), {
      code: 'LEAD_IDENTITY_AMBIGUOUS',
    });
    h.ingestLead.mockRejectedValueOnce(ambiguity);

    const result = await syncLeadCaptureInbox(inbox(['each_email_is_new_lead']));

    expect(result).toMatchObject({ processed: 0, errors: 1 });
    expect(h.updateLeadCaptureInboxSyncTime).not.toHaveBeenCalled();
    expect(h.notifyLeadIdentityAmbiguity).toHaveBeenCalledWith(
      'tenant-1',
      'email-capture',
      'gmail-message-1',
      ambiguity,
      'It will be retried automatically after the duplicate contacts are resolved.',
    );
  });
});