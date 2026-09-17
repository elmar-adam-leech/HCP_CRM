import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  getCredential: vi.fn(),
  setCredential: vi.fn(),
  httpJson: vi.fn(),
  ingestLead: vi.fn(),
  sendConversionEvent: vi.fn(),
  notifyLeadIdentityAmbiguity: vi.fn(),
}));

vi.mock('../credential-service', () => ({
  CredentialService: {
    getCredential: h.getCredential,
    setCredential: h.setCredential,
  },
}));
vi.mock('../utils/http', () => ({ httpJson: h.httpJson }));
vi.mock('../services/facebook-service', () => ({
  facebookService: { sendConversionEvent: h.sendConversionEvent },
}));
vi.mock('../services/lead-ingestion', () => ({ ingestLead: h.ingestLead }));
vi.mock('../utils/logger', () => ({
  logger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../utils/phone-normalizer', () => ({
  normalizePhoneForStorage: (phone: string) => phone.replace(/\D/g, ''),
}));
vi.mock('../services/lead-identity-ambiguity', () => ({
  isLeadIdentityAmbiguity: (error: unknown) => (error as { code?: unknown })?.code === 'LEAD_IDENTITY_AMBIGUOUS',
  notifyLeadIdentityAmbiguity: h.notifyLeadIdentityAmbiguity,
}));

import { processFacebookLead, syncFacebookLeads } from './facebook-leads';

beforeEach(() => {
  vi.clearAllMocks();
  h.getCredential.mockResolvedValue(undefined);
  h.setCredential.mockResolvedValue(undefined);
  h.ingestLead.mockResolvedValue({
    contact: { id: 'contact-1' },
    lead: { id: 'lead-1' },
    isNewContact: true,
    skippedDuplicateLead: true,
  });
  h.notifyLeadIdentityAmbiguity.mockResolvedValue(undefined);
});

describe('Facebook lead identity intake', () => {
  it.each(['webhook', 'poll', 'manual-sync'] as const)(
    '%s imports opt into conservative two-field identity matching',
    async (source) => {
      await processFacebookLead({
        contractorId: 'tenant-1',
        source,
        formName: 'Spring offer',
        leadResource: {
          id: 'facebook-lead-7',
          ad_name: 'Spring offer',
          form_id: 'form-1',
          field_data: [
            { name: 'full_name', values: ['Ada Example'] },
            { name: 'email', values: ['ADA@example.test'] },
            { name: 'phone_number', values: ['(415) 555-0100'] },
          ],
        },
      });

      expect(h.ingestLead).toHaveBeenCalledWith('tenant-1', expect.objectContaining({
        name: 'Ada Example',
        emails: ['ADA@example.test'],
        phones: ['4155550100'],
        identityPolicy: 'two-field',
        submissionId: 'facebook-lead-7',
        activityExternalId: 'facebook:facebook-lead-7',
        skipDuplicateLeadWithinHours: 24,
      }));
      expect(h.ingestLead.mock.calls[0][1].activityNote).toContain('Facebook lead ID: facebook-lead-7');
    },
  );

  it('persists an admin-visible resolution request before surfacing ambiguity', async () => {
    const ambiguity = Object.assign(new Error('Resolve duplicate contacts and retry.'), {
      code: 'LEAD_IDENTITY_AMBIGUOUS',
    });
    h.ingestLead.mockRejectedValueOnce(ambiguity);

    await expect(processFacebookLead({
      contractorId: 'tenant-1',
      source: 'poll',
      formName: 'Spring offer',
      leadResource: { id: 'facebook-lead-ambiguous' },
    })).rejects.toBe(ambiguity);

    expect(h.notifyLeadIdentityAmbiguity).toHaveBeenCalledWith(
      'tenant-1',
      'Facebook',
      'facebook-lead-ambiguous',
      ambiguity,
      'Resolve the duplicate contacts, then use Sync Leads in Settings > Integrations to retry this lead.',
    );
  });

  it('advances polling past a notified ambiguity so one bad historical lead cannot poison future polls', async () => {
    const ambiguity = Object.assign(new Error('Resolve duplicate contacts and retry.'), {
      code: 'LEAD_IDENTITY_AMBIGUOUS',
    });
    h.getCredential.mockImplementation(async (_tenant: string, _service: string, key: string) => ({
      page_id: 'page-1',
      page_access_token: 'page-token',
      user_access_token: undefined,
      last_poll_at: undefined,
      field_mappings: undefined,
      form_tag_rules: undefined,
    }[key]));
    h.httpJson
      .mockResolvedValueOnce({ data: { data: [{ id: 'form-1', name: 'Spring offer' }] } })
      .mockResolvedValueOnce({ data: { data: [{ id: 'facebook-lead-ambiguous', form_id: 'form-1' }] } });
    h.ingestLead.mockRejectedValueOnce(ambiguity);

    await syncFacebookLeads('tenant-1');

    expect(h.notifyLeadIdentityAmbiguity).toHaveBeenCalled();
    expect(h.setCredential).toHaveBeenCalledWith(
      'tenant-1',
      'facebook-leads',
      'last_poll_at',
      expect.any(String),
    );
  });
});