import { beforeEach, describe, expect, it, vi } from 'vitest';
import { noteSubmissionKey } from '../utils/contact-enrichment';
import { submissionIdentityKey } from '../utils/submission-identity';

const h = vi.hoisted(() => {
  const table = () => new Proxy({}, {
    get: (_target, property) => String(property),
  });

  const storage = {
    findMatchingContact: vi.fn(),
    getContact: vi.fn(),
    getLeadsByContact: vi.fn(),
    unageLead: vi.fn(),
    updateContact: vi.fn(),
    markLeadContacted: vi.fn(),
    createContact: vi.fn(),
    createLead: vi.fn(),
    createActivity: vi.fn(),
  };
  const housecallProService = {
    searchCustomers: vi.fn(),
    createCustomer: vi.fn(),
    createLead: vi.fn(),
  };

  return {
    storage,
    housecallProService,
    leads: table(),
    activities: table(),
    contacts: table(),
    contactReceiptResults: [] as any[][],
    identitySelectResults: [] as any[][],
    activitySelectResults: [] as any[][],
    selectResults: [] as any[][],
    updateResults: [] as any[][],
    updateSets: [] as Record<string, unknown>[],
    updateTables: [] as unknown[],
    updateWheres: [] as any[],
    contact: undefined as any,
    reset() {
      this.contactReceiptResults = [];
      this.identitySelectResults = [];
      this.activitySelectResults = [];
      this.selectResults = [];
      this.updateResults = [];
      this.updateSets = [];
      this.updateTables = [];
      this.updateWheres = [];
      this.contact = undefined;
    },
    db: {
      // Receipt lookup was added before the existing lead queries. Keep its
      // responses separate so a contact lookup cannot consume a queued lead
      // duplicate result (and vice versa).
       select: vi.fn((projection?: Record<string, unknown>) => {
        let selectedTable: unknown;
        return {
          from: vi.fn((table: unknown) => {
            selectedTable = table;
            return {
               where: vi.fn(() => {
                 const result = {
                   limit: vi.fn(() => {
                  const results = selectedTable === h.contacts
                     ? projection && 'name' in projection
                       ? h.identitySelectResults
                       : h.contactReceiptResults
                    : selectedTable === h.activities
                      ? h.activitySelectResults
                      : h.selectResults;
                  return Promise.resolve(results.shift() ?? []);
                }),
                   then: (resolve: (value: unknown[]) => unknown) => {
                     const results = selectedTable === h.contacts
                       ? projection && 'name' in projection
                         ? h.identitySelectResults
                         : h.contactReceiptResults
                       : selectedTable === h.activities
                         ? h.activitySelectResults
                         : h.selectResults;
                     return Promise.resolve(results.shift() ?? []).then(resolve);
                   },
                   orderBy: vi.fn(() => result),
                 };
                 return result;
               }),
            };
          }),
        };
      }),
      update: vi.fn((table: unknown) => {
        h.updateTables.push(table);
        return {
          set: vi.fn((values: Record<string, unknown>) => {
            h.updateSets.push(values);
            return {
              where: vi.fn((condition: unknown) => {
                h.updateWheres.push(condition);
                return {
                  returning: vi.fn(() => Promise.resolve(h.updateResults.shift() ?? [])),
                };
              }),
            };
          }),
        };
      }),
    },
    eq: vi.fn((column: unknown, value: unknown) => ({ kind: 'eq', column, value })),
    and: vi.fn((...conditions: unknown[]) => ({ kind: 'and', conditions })),
     or: vi.fn((...conditions: unknown[]) => ({ kind: 'or', conditions })),
    desc: vi.fn((column: unknown) => ({ kind: 'desc', column })),
    gte: vi.fn((column: unknown, value: unknown) => ({ kind: 'gte', column, value })),
    sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values })),
    logConsent: vi.fn(() => Promise.resolve()),
    cacheInvalidation: {
      invalidateContact: vi.fn(),
    },
     pool: {
       connect: vi.fn().mockResolvedValue({
         query: vi.fn().mockResolvedValue(undefined),
         release: vi.fn(),
       }),
     },
  };
});

vi.mock('../storage', () => ({ storage: h.storage }));
vi.mock('../db', () => ({ db: h.db, pool: h.pool }));
vi.mock('@shared/schema', () => ({
  leads: h.leads,
  activities: h.activities,
  contacts: h.contacts,
}));
vi.mock('drizzle-orm', () => ({
  eq: h.eq,
  and: h.and,
  or: h.or,
  desc: h.desc,
  gte: h.gte,
  sql: h.sql,
}));
vi.mock('../utils/phone-normalizer', () => ({
  normalizePhoneForStorage: (phone: string) => phone,
  normalizePhoneForHcp: vi.fn(),
  normalizePhoneNumber: (phone: string) => {
    const digits = phone.replace(/\D/g, '');
    return `+${digits.length === 10 ? `1${digits}` : digits}`;
  },
  isValidPhoneNumber: (phone: string) => phone.replace(/\D/g, '').length >= 10,
  maskPhone: (phone: string) => phone,
}));
vi.mock('../workflow-engine', () => ({
  workflowEngine: { triggerWorkflowsForEvent: vi.fn() },
}));
vi.mock('../utils/workflow/entity-adapter', () => ({ toWorkflowEvent: vi.fn() }));
vi.mock('../routes/assignments', () => ({ autoAssignLead: vi.fn() }));
vi.mock('../services/cache', () => ({
  isIntegrationEnabledCached: vi.fn(),
  cacheInvalidation: h.cacheInvalidation,
}));
vi.mock('../hcp/index', () => ({ housecallProService: h.housecallProService }));
vi.mock('../utils/logger', () => ({
  logger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));
vi.mock('../utils/hcp-helpers', () => ({ resolveHcpLeadSource: vi.fn() }));
vi.mock('../utils/consent-log', () => ({ logConsent: h.logConsent, hashIp: vi.fn() }));
vi.mock('../utils/normalize-address', () => ({ normalizeAddress: vi.fn() }));
vi.mock('../utils/address', () => ({
  buildFormattedAddress: vi.fn(),
  parseAddressString: vi.fn(),
}));
vi.mock('../scheduling/hcp-customer', () => ({ syncHcpCustomerAddress: vi.fn() }));

import { ingestLead } from './lead-ingestion';
import { workflowEngine } from '../workflow-engine';
import { autoAssignLead } from '../routes/assignments';
import { isIntegrationEnabledCached } from '../services/cache';

const TENANT = 'tenant-1';
const OTHER_TENANT = 'tenant-2';
const tracking = {
  pageUrl: 'https://example.test/landing',
  utmSource: 'google',
  utmMedium: 'cpc',
  utmCampaign: 'spring',
  utmTerm: 'plumber',
  utmContent: 'hero',
};

function makeContact(overrides: Record<string, unknown> = {}) {
  return {
    id: 'contact-1',
    name: 'Ada Example',
    emails: ['ada@example.test'],
    phones: [],
    tags: [],
    notes: null,
    type: 'lead',
    status: 'new',
    contractorId: TENANT,
    pageUrl: null,
    utmSource: null,
    utmMedium: null,
    utmCampaign: null,
    utmTerm: null,
    utmContent: null,
    ...overrides,
  };
}

function makeLead(overrides: Record<string, unknown> = {}) {
  return {
    id: 'lead-1',
    contactId: 'contact-1',
    contractorId: TENANT,
    status: 'new',
    ...tracking,
    ...overrides,
  };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Ada Example',
    emails: ['ada@example.test'],
    source: 'webhook',
    ...tracking,
    skipAutoAssign: true,
    skipWorkflows: true,
    skipHcpSync: true,
    ...overrides,
  };
}

function stableInput(overrides: Record<string, unknown> = {}) {
  return input({
    emails: undefined,
    phones: undefined,
    notes: undefined,
    tags: undefined,
    pageUrl: undefined,
    utmSource: undefined,
    utmMedium: undefined,
    utmCampaign: undefined,
    utmTerm: undefined,
    utmContent: undefined,
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.reset();
  h.storage.findMatchingContact.mockResolvedValue(null);
  h.storage.getContact.mockResolvedValue(undefined);
  h.storage.getLeadsByContact.mockResolvedValue([]);
  h.storage.unageLead.mockResolvedValue(undefined);
  h.storage.updateContact.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
    ...h.contact,
    ...patch,
  }));
  h.storage.markLeadContacted.mockResolvedValue(undefined);
  h.storage.createContact.mockImplementation(async (values: Record<string, unknown>, contractorId: string) => {
    h.contact = makeContact({ ...values, id: 'contact-created', contractorId });
    return h.contact;
  });
  h.storage.createLead.mockImplementation(async (values: Record<string, unknown>, contractorId: string) => ({
    ...makeLead({ ...values, id: 'lead-created', contractorId }),
  }));
  h.storage.createActivity.mockResolvedValue(undefined);
});

describe('ingestLead tracking and contact mapping', () => {
  it.each([
    ['name + email', { name: '  ADA   EXAMPLE ', emails: [' ADA@EXAMPLE.TEST '] }],
    ['name + phone', { name: ' Ada Example ', emails: undefined, phones: ['+1 (415) 555-1212'] }],
    ['email + phone', { name: 'Unknown Lead', emails: [' ADA@EXAMPLE.TEST '], phones: ['4155551212'] }],
  ])('reuses a contact only when the two-field %s identity matches', async (_pair, incoming) => {
    h.contact = makeContact({
      name: 'Ada Example',
      emails: ['ada@example.test', 'secondary@example.test'],
      phones: ['(415) 555-1212', '(415) 555-0000'],
    });
    h.storage.getContact.mockResolvedValue(h.contact);
    h.identitySelectResults = [[h.contact]];
    // No recent lead: matching must reuse the contact and create this inquiry.
    h.selectResults = [[]];

    const result = await ingestLead(TENANT, input({
      ...incoming,
      identityPolicy: 'two-field',
      pageUrl: undefined,
      utmSource: undefined,
      utmMedium: undefined,
      utmCampaign: undefined,
      utmTerm: undefined,
      utmContent: undefined,
    }));

    expect(result.contact.id).toBe('contact-1');
    expect(result.isNewContact).toBe(false);
    expect(h.storage.createContact).not.toHaveBeenCalled();
    expect(h.storage.findMatchingContact).not.toHaveBeenCalled();
  });

  it('does not turn a single identifier into a lead identity match', async () => {
    h.contact = makeContact();
    h.identitySelectResults = [[]];

    const result = await ingestLead(TENANT, input({
      name: 'Unknown Lead',
      emails: ['ada@example.test'],
      identityPolicy: 'two-field',
      pageUrl: undefined,
      utmSource: undefined,
      utmMedium: undefined,
      utmCampaign: undefined,
      utmTerm: undefined,
      utmContent: undefined,
    }));

    expect(result.isNewContact).toBe(true);
    expect(h.storage.findMatchingContact).not.toHaveBeenCalled();
  });

  it('rejects ambiguous two-field candidates instead of choosing one arbitrarily', async () => {
    h.identitySelectResults = [[
      makeContact({ id: 'contact-a', phones: ['(415) 555-1212'] }),
      makeContact({ id: 'contact-b', phones: ['(415) 555-1212'] }),
    ]];

    await expect(ingestLead(TENANT, input({
      phones: ['4155551212'],
      identityPolicy: 'two-field',
    }))).rejects.toMatchObject({ code: 'LEAD_IDENTITY_AMBIGUOUS' });

    expect(h.storage.createContact).not.toHaveBeenCalled();
    expect(h.storage.createLead).not.toHaveBeenCalled();
  });

  it('rejects split identity ownership and does not let the policy bypass matching', async () => {
    h.identitySelectResults = [[
      makeContact({ id: 'name-email-owner', phones: [] }),
      makeContact({
        id: 'phone-owner',
        name: 'Different Person',
        emails: [],
        phones: ['(415) 555-1212'],
      }),
    ]];

    await expect(ingestLead(TENANT, input({
      phones: ['4155551212'],
      identityPolicy: 'two-field',
      skipContactMatching: true,
    }))).rejects.toMatchObject({ code: 'LEAD_IDENTITY_AMBIGUOUS' });

    expect(h.storage.findMatchingContact).not.toHaveBeenCalled();
    expect(h.storage.createContact).not.toHaveBeenCalled();
  });

  it('does not treat a name-only bystander as an ambiguity', async () => {
    h.contact = makeContact({
      id: 'strong-match',
      phones: ['(415) 555-1212'],
    });
    h.storage.getContact.mockResolvedValue(h.contact);
    h.identitySelectResults = [[
      h.contact,
      makeContact({
        id: 'same-name-only',
        emails: [],
        phones: [],
      }),
    ]];
    h.selectResults = [[]];

    const result = await ingestLead(TENANT, input({
      phones: ['4155551212'],
      identityPolicy: 'two-field',
    }));

    expect(result.contact.id).toBe('strong-match');
    expect(h.storage.createContact).not.toHaveBeenCalled();
  });

  it('maps page URL and all UTM fields onto a new contact and lead', async () => {
    const result = await ingestLead(TENANT, input());

    expect(h.storage.createContact).toHaveBeenCalledWith(
      expect.objectContaining(tracking),
      TENANT,
    );
    expect(h.storage.createLead).toHaveBeenCalledWith(
      expect.objectContaining(tracking),
      TENANT,
    );
    expect(result.contact).toEqual(expect.objectContaining(tracking));
    expect(result.lead).toEqual(expect.objectContaining(tracking));
    expect(result.isNewContact).toBe(true);
    expect(result.skippedDuplicateLead).toBe(false);
  });

  it('creates a new lead for an existing contact while preserving additive enrichment', async () => {
    h.contact = makeContact({
      utmSource: 'first-touch',
      notes: 'existing note',
      tags: ['existing'],
    });
    h.storage.findMatchingContact.mockResolvedValue('contact-1');
    h.storage.getContact.mockResolvedValue(h.contact);
    // Existing contact, but no recent lead in the deduplication window.
    h.selectResults = [[]];

    const result = await ingestLead(TENANT, input({
      notes: 'follow-up note',
      tags: ['existing', 'new'],
    }));

    expect(h.storage.createContact).not.toHaveBeenCalled();
    expect(h.storage.updateContact).toHaveBeenCalledWith(
      'contact-1',
      expect.objectContaining({
        notes: 'existing note\nfollow-up note',
        tags: ['existing', 'new'],
        pageUrl: tracking.pageUrl,
        utmMedium: tracking.utmMedium,
        utmCampaign: tracking.utmCampaign,
        utmTerm: tracking.utmTerm,
        utmContent: tracking.utmContent,
      }),
      TENANT,
    );
    expect(h.storage.createLead).toHaveBeenCalledWith(
      expect.objectContaining(tracking),
      TENANT,
    );
    expect(result.isNewContact).toBe(false);
    expect(result.skippedDuplicateLead).toBe(false);
  });

  it('fills missing duplicate-lead tracking fields, preserves existing values, and returns saved data', async () => {
    h.contact = makeContact();
    h.storage.findMatchingContact.mockResolvedValue('contact-1');
    h.storage.getContact.mockResolvedValue(h.contact);
    h.selectResults = [
      [{ id: 'lead-duplicate' }],
      [makeLead({
        id: 'lead-duplicate',
        pageUrl: null,
        utmSource: ' original-source ',
        utmMedium: null,
        utmCampaign: null,
        utmTerm: null,
        utmContent: null,
      })],
    ];
    const savedLead = makeLead({
      id: 'lead-duplicate',
      pageUrl: tracking.pageUrl,
      utmSource: ' original-source ',
      utmMedium: tracking.utmMedium,
      utmCampaign: tracking.utmCampaign,
      utmTerm: tracking.utmTerm,
      utmContent: tracking.utmContent,
    });
    h.updateResults = [[savedLead]];

    const result = await ingestLead(TENANT, input());

    expect(result.skippedDuplicateLead).toBe(true);
    expect(result.lead).toBe(savedLead);
    expect(Object.keys(h.updateSets[0])).toEqual(expect.arrayContaining([
      'pageUrl',
      'utmSource',
      'utmMedium',
      'utmCampaign',
      'utmTerm',
      'utmContent',
    ]));
    // The SQL CASE preserves the exact existing value, including whitespace.
    expect(result.lead.utmSource).toBe(' original-source ');
    expect(result.lead.utmMedium).toBe(tracking.utmMedium);
  });

  it('omits the duplicate update when the incoming tracking fields are absent', async () => {
    const existingLead = makeLead({
      id: 'lead-duplicate',
      pageUrl: null,
      utmSource: null,
      utmMedium: null,
      utmCampaign: null,
      utmTerm: null,
      utmContent: null,
    });
    h.contact = makeContact();
    h.storage.findMatchingContact.mockResolvedValue('contact-1');
    h.storage.getContact.mockResolvedValue(h.contact);
    h.selectResults = [[{ id: 'lead-duplicate' }], [existingLead]];

    const result = await ingestLead(TENANT, input({
      pageUrl: undefined,
      utmSource: undefined,
      utmMedium: undefined,
      utmCampaign: undefined,
      utmTerm: undefined,
      utmContent: undefined,
    }));

    expect(h.db.update).not.toHaveBeenCalled();
    expect(result.lead).toBe(existingLead);
  });

  it('scopes duplicate tracking writes to the requested tenant', async () => {
    h.contact = makeContact();
    h.storage.findMatchingContact.mockResolvedValue('contact-1');
    h.storage.getContact.mockResolvedValue(h.contact);
    h.selectResults = [[{ id: 'lead-duplicate' }], [makeLead({ id: 'lead-duplicate' })]];
    h.updateResults = [[makeLead({ id: 'lead-duplicate' })]];

    await ingestLead(OTHER_TENANT, input());

    const condition = h.updateWheres[0];
    expect(condition.kind).toBe('and');
    expect(condition.conditions).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'eq', value: OTHER_TENANT }),
    ]));
  });

  it('seeds a receipt on a new contact when the submission has identity', async () => {
    const submission = input({
      notes: 'Please call tomorrow',
      submissionId: '  submission-123  ',
    });
    const receipt = noteSubmissionKey(TENANT, submission);

    await ingestLead(TENANT, submission);

    expect(receipt).toBeDefined();
    expect(h.storage.createContact).toHaveBeenCalledWith(
      expect.objectContaining({
        notes: submission.notes,
        noteSubmissionKeys: [receipt],
      }),
      TENANT,
    );
  });

  it('appends identical raw payload retries again when no submission identity is provided', async () => {
    h.contact = makeContact({ notes: 'existing note' });
    h.storage.findMatchingContact.mockResolvedValue('contact-1');
    h.storage.getContact.mockImplementation(async () => h.contact);
    h.storage.updateContact.mockImplementation(async (_id: string, patch: Record<string, unknown>) => {
      h.contact = { ...h.contact, ...patch };
      return h.contact;
    });
    h.selectResults = [[], []];

    const submission = input({
      notes: 'same inquiry',
      rawPayload: '{"submission":"same"}',
      pageUrl: undefined,
      utmSource: undefined,
      utmMedium: undefined,
      utmCampaign: undefined,
      utmTerm: undefined,
      utmContent: undefined,
    });

    await ingestLead(TENANT, submission);
    await ingestLead(TENANT, submission);

    expect(h.db.update).not.toHaveBeenCalled();
    expect(h.storage.updateContact).toHaveBeenNthCalledWith(
      1,
      'contact-1',
      { notes: 'existing note\nsame inquiry' },
      TENANT,
    );
    expect(h.storage.updateContact).toHaveBeenNthCalledWith(
      2,
      'contact-1',
      { notes: 'existing note\nsame inquiry\nsame inquiry' },
      TENANT,
    );
    expect(h.storage.createLead).toHaveBeenCalledTimes(2);
  });

  it('atomically appends a keyed note, scopes the write, and returns the saved contact', async () => {
    const snapshot = makeContact({ notes: 'snapshot note' });
    const savedContact = makeContact({
      notes: 'snapshot note\nlatest note',
      noteSubmissionKeys: ['receipt-1'],
    });
    h.contact = snapshot;
    h.storage.findMatchingContact.mockResolvedValue('contact-1');
    h.storage.getContact.mockResolvedValue(snapshot);
    h.updateResults = [[savedContact]];

    const submission = input({
      notes: 'latest note',
      activityExternalId: 'receipt-1',
      pageUrl: undefined,
      utmSource: undefined,
      utmMedium: undefined,
      utmCampaign: undefined,
      utmTerm: undefined,
      utmContent: undefined,
    });
    const receipt = noteSubmissionKey(TENANT, submission);
    const result = await ingestLead(TENANT, submission);

    expect(h.updateTables[0]).toBe(h.contacts);
    expect(h.updateSets[0]).toEqual(expect.objectContaining({
      notes: expect.anything(),
      noteSubmissionKeys: expect.anything(),
      updatedAt: expect.anything(),
    }));
    const update = h.updateSets[0] as any;
    const seen = update.notes.values[0];
    expect(seen.strings.join('')).toContain('= ANY(COALESCE(');
    expect(seen.values).toEqual(expect.arrayContaining([
      receipt,
      h.contacts.noteSubmissionKeys,
    ]));
    expect(update.notes.strings.join('')).toContain('CASE WHEN');
    expect(update.notes.strings.join('')).toContain('NULLIF(BTRIM(');
    expect(update.notes.strings.join('')).toContain("E'\\n'");
    expect(update.notes.values).toEqual(expect.arrayContaining([submission.notes]));
    expect(update.noteSubmissionKeys.strings.join('')).toContain('array_append(COALESCE(');
    expect(update.noteSubmissionKeys.values).toContain(receipt);
    expect(update.updatedAt.strings.join('')).toContain('CASE WHEN');
    expect(update.updatedAt.strings.join('')).toContain('NOW()');
    expect(update.updatedAt.values).toContain(h.contacts.updatedAt);
    const condition = h.updateWheres[0];
    expect(condition.kind).toBe('and');
    expect(condition.conditions).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'eq', value: 'contact-1' }),
      expect.objectContaining({ kind: 'eq', value: TENANT }),
    ]));
    expect(h.cacheInvalidation.invalidateContact).toHaveBeenCalledWith('contact-1', TENANT);
    expect(h.storage.updateContact).not.toHaveBeenCalled();
    expect(result.contact).toBe(savedContact);
    expect(result.contact.notes).toBe('snapshot note\nlatest note');
    expect(h.storage.createLead).toHaveBeenCalled();
    expect(result.skippedDuplicateLead).toBe(false);
  });

  it('keeps keyed retries within the existing recent-lead duplicate rules', async () => {
    const snapshot = makeContact({ notes: 'snapshot note' });
    const savedContact = makeContact({
      notes: 'snapshot note\nretry note',
      noteSubmissionKeys: ['receipt-1'],
    });
    const existingLead = makeLead({ id: 'lead-recent' });
    h.contact = snapshot;
    h.storage.findMatchingContact.mockResolvedValue('contact-1');
    h.storage.getContact.mockResolvedValue(snapshot);
    h.selectResults = [[{ id: 'lead-recent' }], [existingLead]];
    h.updateResults = [[savedContact]];

    const result = await ingestLead(TENANT, input({
      notes: 'retry note',
      activityExternalId: 'receipt-1',
      pageUrl: undefined,
      utmSource: undefined,
      utmMedium: undefined,
      utmCampaign: undefined,
      utmTerm: undefined,
      utmContent: undefined,
    }));

    expect(result.skippedDuplicateLead).toBe(true);
    expect(result.lead).toBe(existingLead);
    expect(result.contact).toBe(savedContact);
    expect(h.storage.createLead).not.toHaveBeenCalled();
    // The keyed contact receipt is the only update; duplicate tracking still
    // uses its existing conditional update rules when tracking is supplied.
    expect(h.db.update).toHaveBeenCalledTimes(1);
  });
});

describe('initial contact creation identity', () => {
  describe('email recovery receipt replay', () => {
    function recoveredEmailInput(overrides: Record<string, unknown> = {}) {
      return stableInput({
        name: 'Ada Example',
        emails: ['ada@example.test'],
        source: 'email_capture',
        submissionId: 'gmail-message-original-123',
        activityExternalId: 'gmail-message-original-123',
        activityNote: 'Recovered Gmail lead capture',
        identityPolicy: 'two-field',
        skipAutoAssign: false,
        skipWorkflows: false,
        skipHcpSync: false,
        ...overrides,
      });
    }

    it('returns the original Gmail lead receipt after its audit record is recreated without repeating effects', async () => {
      const recovery = recoveredEmailInput();
      const recreatedAuditRecovery = recoveredEmailInput({
        activityNote: 'Recovered again after spam audit recreation',
      });
      const creationKey = submissionIdentityKey(TENANT, recovery);
      const existingContact = makeContact();
      const existingLead = makeLead({
        id: 'lead-from-original-gmail-message',
        submissionCreationKeys: [creationKey],
      });

      expect(creationKey).toBeDefined();
      expect(submissionIdentityKey(TENANT, recreatedAuditRecovery)).toBe(creationKey);

      h.selectResults = [[existingLead], [existingLead]];
      h.activitySelectResults = [[{ id: 'capture-activity' }], [{ id: 'capture-activity' }]];
      h.storage.getContact.mockResolvedValue(existingContact);

      const firstRecovery = await ingestLead(TENANT, recovery);
      const afterAuditRecreation = await ingestLead(TENANT, recreatedAuditRecovery);

      expect(firstRecovery.lead).toBe(existingLead);
      expect(afterAuditRecreation.lead).toBe(existingLead);
      expect(firstRecovery).toMatchObject({
        contact: existingContact,
        isNewContact: false,
        skippedDuplicateLead: true,
      });
      expect(afterAuditRecreation).toMatchObject({
        contact: existingContact,
        isNewContact: false,
        skippedDuplicateLead: true,
      });
      expect(h.storage.createLead).not.toHaveBeenCalled();
      expect(h.storage.createContact).not.toHaveBeenCalled();
      expect(h.storage.createActivity).not.toHaveBeenCalled();
      expect(workflowEngine.triggerWorkflowsForEvent).not.toHaveBeenCalled();
      expect(autoAssignLead).not.toHaveBeenCalled();
      expect(isIntegrationEnabledCached).not.toHaveBeenCalled();
      expect(h.housecallProService.searchCustomers).not.toHaveBeenCalled();
      expect(h.housecallProService.createCustomer).not.toHaveBeenCalled();
      expect(h.housecallProService.createLead).not.toHaveBeenCalled();
    });

    it('converges concurrent recovery calls on the existing Gmail lead receipt without repeating effects', async () => {
      const recovery = recoveredEmailInput();
      const creationKey = submissionIdentityKey(TENANT, recovery);
      const existingContact = makeContact();
      const existingLead = makeLead({
        id: 'lead-from-original-gmail-message',
        submissionCreationKeys: [creationKey],
      });

      h.selectResults = [[existingLead], [existingLead]];
      h.activitySelectResults = [[{ id: 'capture-activity' }], [{ id: 'capture-activity' }]];
      h.storage.getContact.mockResolvedValue(existingContact);

      const [first, second] = await Promise.all([
        ingestLead(TENANT, recovery),
        ingestLead(TENANT, { ...recovery }),
      ]);

      expect(first.lead).toBe(existingLead);
      expect(second.lead).toBe(existingLead);
      expect(first.skippedDuplicateLead).toBe(true);
      expect(second.skippedDuplicateLead).toBe(true);
      expect(h.storage.createLead).not.toHaveBeenCalled();
      expect(h.storage.createContact).not.toHaveBeenCalled();
      expect(h.storage.createActivity).not.toHaveBeenCalled();
      expect(workflowEngine.triggerWorkflowsForEvent).not.toHaveBeenCalled();
      expect(autoAssignLead).not.toHaveBeenCalled();
      expect(isIntegrationEnabledCached).not.toHaveBeenCalled();
      expect(h.housecallProService.searchCustomers).not.toHaveBeenCalled();
      expect(h.housecallProService.createCustomer).not.toHaveBeenCalled();
      expect(h.housecallProService.createLead).not.toHaveBeenCalled();
    });
  });

  it('converges same-ID deliveries after a wrapped unique-insert race, without matching or note work', async () => {
    const delivery = stableInput({
      submissionId: 'provider-submission-1',
      skipContactMatching: true,
    });
    const creationKey = submissionIdentityKey(TENANT, delivery);
    const winner = makeContact({
      id: 'contact-winner',
      emails: [],
      phones: [],
      notes: undefined,
      contractorId: TENANT,
      submissionCreationKey: creationKey,
    });
    const duplicateInsert = Object.assign(new Error('duplicate submission'), {
      cause: {
        code: '23505',
        constraint: 'contacts_submission_creation_idx',
      },
    });
    let insertAttempts = 0;

    // Both initial attempts observe no receipt. The first insert wins; the
    // second receives the wrapped PostgreSQL conflict and its bounded retry
    // observes the committed winner.
    h.contactReceiptResults = [[], [], [{ id: winner.id }]];
    h.storage.getContact.mockResolvedValue(winner);
    h.storage.createContact.mockImplementation(async () => {
      insertAttempts += 1;
      if (insertAttempts === 2) throw duplicateInsert;
      return winner;
    });

    const [first, second] = await Promise.all([
      ingestLead(TENANT, delivery),
      ingestLead(TENANT, { ...delivery }),
    ]);

    expect(h.storage.createContact).toHaveBeenCalledTimes(2);
    expect(h.storage.createContact.mock.calls[0][0]).toEqual(expect.objectContaining({
      emails: [],
      phones: [],
      notes: undefined,
      submissionCreationKey: creationKey,
    }));
    expect(h.storage.createContact.mock.calls[0][0]).not.toHaveProperty('noteSubmissionKeys');
    expect(h.storage.createContact.mock.calls[1][0]).toEqual(expect.objectContaining({
      submissionCreationKey: creationKey,
    }));
    expect(h.storage.findMatchingContact).not.toHaveBeenCalled();
    expect(h.db.update).not.toHaveBeenCalled();
    expect(first.contact).toBe(winner);
    expect(second.contact).toBe(winner);
    expect(first.isNewContact).toBe(true);
    expect(second.isNewContact).toBe(false);
    expect(first.skippedDuplicateLead).toBe(false);
    expect(second.skippedDuplicateLead).toBe(false);
  });

  it('uses one stable creation identity while appending a changed note on retry', async () => {
    const firstSubmission = stableInput({
      submissionId: 'provider-submission-with-note',
      notes: 'first note',
      skipContactMatching: true,
    });
    const firstResult = await ingestLead(TENANT, firstSubmission);
    const created = firstResult.contact;
    const secondSubmission = stableInput({
      submissionId: 'provider-submission-with-note',
      notes: 'changed note',
      skipContactMatching: true,
    });
    const firstReceipt = noteSubmissionKey(TENANT, firstSubmission);
    const secondReceipt = noteSubmissionKey(TENANT, secondSubmission);
    const saved = {
      ...created,
      notes: 'first note\nchanged note',
      noteSubmissionKeys: [firstReceipt, secondReceipt],
    };

    expect(firstReceipt).toBeDefined();
    expect(secondReceipt).toBeDefined();
    expect(firstReceipt).not.toBe(secondReceipt);
    expect(created.submissionCreationKey).toBe(
      submissionIdentityKey(TENANT, firstSubmission),
    );
    expect(created.submissionCreationKey).toBe(
      submissionIdentityKey(TENANT, secondSubmission),
    );

    h.contactReceiptResults = [[{ id: created.id }]];
    h.storage.getContact.mockResolvedValue(created);
    h.updateResults = [[saved]];

    const result = await ingestLead(TENANT, secondSubmission);

    expect(h.storage.createContact).toHaveBeenCalledTimes(1);
    expect(h.storage.updateContact).not.toHaveBeenCalled();
    expect(h.updateTables[0]).toBe(h.contacts);
    expect(h.updateSets[0].notes).toEqual(expect.anything());
    expect(((h.updateSets[0].notes as any).values[0] as any).values).toContain(secondReceipt);
    expect((h.updateSets[0].notes as any).values).toContain(secondSubmission.notes);
    expect(result.contact).toBe(saved);
    expect(result.contact.notes).toBe('first note\nchanged note');
  });

  it('keeps distinct IDs separate when matching finds no contact', async () => {
    let contactNumber = 0;
    h.storage.createContact.mockImplementation(async (
      values: Record<string, unknown>,
      contractorId: string,
    ) => {
      const created = makeContact({
        ...values,
        id: `contact-unmatched-${++contactNumber}`,
        contractorId,
      });
      h.contact = created;
      return created;
    });

    const [first, second] = await Promise.all([
      ingestLead(TENANT, stableInput({
        submissionId: 'provider-submission-a',
        emails: ['same@example.test'],
      })),
      ingestLead(TENANT, stableInput({
        submissionId: 'provider-submission-b',
        emails: ['same@example.test'],
      })),
    ]);

    expect(h.storage.findMatchingContact).toHaveBeenCalledTimes(2);
    expect(h.storage.createContact).toHaveBeenCalledTimes(2);
    expect(first.contact.id).not.toBe(second.contact.id);
    expect(first.isNewContact).toBe(true);
    expect(second.isNewContact).toBe(true);
    expect(h.storage.createContact.mock.calls[0][0].submissionCreationKey).not.toBe(
      h.storage.createContact.mock.calls[1][0].submissionCreationKey,
    );
  });

  it('lets distinct IDs retain the existing matching behavior and share a match', async () => {
    const shared = makeContact({
      id: 'contact-shared',
      emails: ['same@example.test'],
    });
    h.contact = shared;
    h.storage.findMatchingContact.mockResolvedValue(shared.id);
    h.storage.getContact.mockResolvedValue(shared);

    const [first, second] = await Promise.all([
      ingestLead(TENANT, stableInput({
        submissionId: 'provider-submission-c',
        emails: ['same@example.test'],
      })),
      ingestLead(TENANT, stableInput({
        submissionId: 'provider-submission-d',
        emails: ['same@example.test'],
      })),
    ]);

    expect(h.storage.findMatchingContact).toHaveBeenCalledTimes(2);
    expect(h.storage.createContact).not.toHaveBeenCalled();
    expect(first.contact).toBe(shared);
    expect(second.contact).toBe(shared);
    expect(first.isNewContact).toBe(false);
    expect(second.isNewContact).toBe(false);
  });

  it('keeps the same provider ID isolated by tenant and source', async () => {
    let contactNumber = 0;
    h.storage.createContact.mockImplementation(async (
      values: Record<string, unknown>,
      contractorId: string,
    ) => {
      const created = makeContact({
        ...values,
        id: `contact-isolated-${++contactNumber}`,
        contractorId,
      });
      h.contact = created;
      return created;
    });
    const tenantSubmission = stableInput({
      submissionId: 'provider-submission-isolated',
      source: 'webhook',
    });
    const otherSource = stableInput({
      submissionId: 'provider-submission-isolated',
      source: 'facebook',
    });
    const otherTenant = stableInput({
      submissionId: 'provider-submission-isolated',
      source: 'webhook',
    });

    await ingestLead(TENANT, tenantSubmission);
    await ingestLead(TENANT, otherSource);
    await ingestLead(OTHER_TENANT, otherTenant);

    const calls = h.storage.createContact.mock.calls;
    const keys = calls.map(([values]) => values.submissionCreationKey);
    expect(new Set(keys).size).toBe(3);
    expect(keys).toEqual([
      submissionIdentityKey(TENANT, tenantSubmission),
      submissionIdentityKey(TENANT, otherSource),
      submissionIdentityKey(OTHER_TENANT, otherTenant),
    ]);
    expect(calls.map(([, contractorId]) => contractorId)).toEqual([
      TENANT,
      TENANT,
      OTHER_TENANT,
    ]);
  });

  it('propagates a non-target unique error instead of retrying', async () => {
    const error = Object.assign(new Error('duplicate email'), {
      cause: {
        code: '23505',
        constraint: 'contacts_email_unique',
      },
    });
    h.storage.createContact.mockRejectedValue(error);

    await expect(ingestLead(TENANT, stableInput({
      submissionId: 'provider-submission-other-error',
    }))).rejects.toBe(error);

    expect(h.storage.createContact).toHaveBeenCalledTimes(1);
    expect(h.contactReceiptResults).toHaveLength(0);
  });
});