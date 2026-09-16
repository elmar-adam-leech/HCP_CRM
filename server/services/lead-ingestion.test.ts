import { beforeEach, describe, expect, it, vi } from 'vitest';
import { noteSubmissionKey } from '../utils/contact-enrichment';

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

  return {
    storage,
    leads: table(),
    activities: table(),
    contacts: table(),
    selectResults: [] as any[][],
    updateResults: [] as any[][],
    updateSets: [] as Record<string, unknown>[],
    updateTables: [] as unknown[],
    updateWheres: [] as any[],
    contact: undefined as any,
    reset() {
      this.selectResults = [];
      this.updateResults = [];
      this.updateSets = [];
      this.updateTables = [];
      this.updateWheres = [];
      this.contact = undefined;
    },
    db: {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(() => Promise.resolve(h.selectResults.shift() ?? [])),
          })),
        })),
      })),
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
    gte: vi.fn((column: unknown, value: unknown) => ({ kind: 'gte', column, value })),
    sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values })),
    logConsent: vi.fn(() => Promise.resolve()),
    cacheInvalidation: {
      invalidateContact: vi.fn(),
    },
  };
});

vi.mock('../storage', () => ({ storage: h.storage }));
vi.mock('../db', () => ({ db: h.db }));
vi.mock('@shared/schema', () => ({
  leads: h.leads,
  activities: h.activities,
  contacts: h.contacts,
}));
vi.mock('drizzle-orm', () => ({
  eq: h.eq,
  and: h.and,
  gte: h.gte,
  sql: h.sql,
}));
vi.mock('../utils/phone-normalizer', () => ({
  normalizePhoneForStorage: (phone: string) => phone,
  normalizePhoneForHcp: vi.fn(),
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
vi.mock('../hcp/index', () => ({ housecallProService: {} }));
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