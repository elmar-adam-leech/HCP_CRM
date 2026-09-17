import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const table = () => new Proxy({}, { get: (_target, property) => String(property) });
  return {
    ingestLead: vi.fn(),
    parseEmailWithAI: vi.fn(),
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
  runHeuristicSpamCheck: vi.fn(),
}));
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
    createSpamAuditEntry: vi.fn(),
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
  h.parseEmailWithAI.mockResolvedValue({ isSpam: false });
  h.updateLeadCaptureInboxSyncTime.mockResolvedValue(undefined);
  h.notifyLeadIdentityAmbiguity.mockResolvedValue(undefined);
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