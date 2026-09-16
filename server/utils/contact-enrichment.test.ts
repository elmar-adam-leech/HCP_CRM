import { describe, expect, it } from 'vitest';
import { buildContactEnrichment, noteSubmissionKey } from './contact-enrichment';

function contact(overrides: Record<string, unknown> = {}) {
  return {
    id: 'contact-1',
    name: 'Ada Example',
    emails: ['ada@example.test'],
    phones: ['(415) 555-0100'],
    tags: ['existing'],
    notes: 'existing note',
    address: null,
    street: null,
    city: null,
    state: null,
    zip: null,
    pageUrl: null,
    utmSource: null,
    utmMedium: null,
    utmCampaign: null,
    utmTerm: null,
    utmContent: null,
    ...overrides,
  } as any;
}

describe('buildContactEnrichment tracking fields', () => {
  it('fills a missing page URL and UTM fields without replacing first-touch values', () => {
    const result = buildContactEnrichment(
      contact({ utmSource: 'original-source' }),
      {
        pageUrl: 'https://example.test/new-page',
        utmSource: 'later-source',
        utmMedium: 'cpc',
        utmCampaign: 'spring',
        utmTerm: 'plumber',
        utmContent: 'hero',
      },
      [],
    );

    expect(result).toEqual({
      pageUrl: 'https://example.test/new-page',
      utmMedium: 'cpc',
      utmCampaign: 'spring',
      utmTerm: 'plumber',
      utmContent: 'hero',
    });
  });

  it('preserves notes append and tag merge while enriching tracking fields', () => {
    const result = buildContactEnrichment(
      contact(),
      {
        notes: 'new note',
        tags: ['existing', 'new'],
        pageUrl: 'https://example.test/landing',
      },
      ['(415) 555-0100', '(212) 555-0100'],
    );

    expect(result).toEqual({
      phones: ['(415) 555-0100', '(212) 555-0100'],
      tags: ['existing', 'new'],
      notes: 'existing note\nnew note',
      pageUrl: 'https://example.test/landing',
    });
  });

  it('does not write omitted or already populated tracking fields', () => {
    const result = buildContactEnrichment(
      contact({
        pageUrl: 'https://example.test/original',
        utmSource: 'original-source',
        utmMedium: 'original-medium',
        utmCampaign: 'original-campaign',
        utmTerm: 'original-term',
        utmContent: 'original-content',
      }),
      {},
      [],
    );

    expect(result).toBeNull();
  });
});

describe('noteSubmissionKey receipt identity', () => {
  const baseInput = {
    source: 'webhook',
    notes: 'Please call after 5pm',
  };

  it('returns the same receipt for an identical retry', () => {
    const first = noteSubmissionKey('tenant-1', {
      ...baseInput,
      activityExternalId: 'submission-123',
    });
    const retry = noteSubmissionKey('tenant-1', {
      ...baseInput,
      activityExternalId: 'submission-123',
    });

    expect(first).toBeDefined();
    expect(retry).toBe(first);
  });

  it('uses submissionId as receipt identity and trims it before hashing', () => {
    const first = noteSubmissionKey('tenant-1', {
      ...baseInput,
      submissionId: '  submission-123  ',
    });
    const retry = noteSubmissionKey('tenant-1', {
      ...baseInput,
      submissionId: 'submission-123',
    });

    expect(first).toBeDefined();
    expect(retry).toBe(first);
  });

  it('treats a new note for the same submission as a new receipt', () => {
    const first = noteSubmissionKey('tenant-1', {
      ...baseInput,
      activityExternalId: 'submission-123',
    });
    const changedNote = noteSubmissionKey('tenant-1', {
      ...baseInput,
      notes: 'Please call after 6pm',
      activityExternalId: 'submission-123',
    });

    expect(changedNote).not.toBe(first);
  });

  it('treats distinct submissions with the same note as different receipts', () => {
    const first = noteSubmissionKey('tenant-1', {
      ...baseInput,
      activityExternalId: 'submission-123',
    });
    const distinctSubmission = noteSubmissionKey('tenant-1', {
      ...baseInput,
      activityExternalId: 'submission-456',
    });

    expect(distinctSubmission).not.toBe(first);
  });

  it('isolates receipts by source and tenant', () => {
    const original = noteSubmissionKey('tenant-1', {
      ...baseInput,
      activityExternalId: 'submission-123',
    });
    const otherSource = noteSubmissionKey('tenant-1', {
      ...baseInput,
      source: 'facebook',
      activityExternalId: 'submission-123',
    });
    const otherTenant = noteSubmissionKey('tenant-2', {
      ...baseInput,
      activityExternalId: 'submission-123',
    });

    expect(otherSource).not.toBe(original);
    expect(otherTenant).not.toBe(original);
  });

  it('returns no receipt identity without submission evidence', () => {
    expect(noteSubmissionKey('tenant-1', baseInput)).toBeUndefined();
    expect(noteSubmissionKey('tenant-1', {
      ...baseInput,
      rawPayload: '  ',
    } as any)).toBeUndefined();
  });

  it('preserves note append behavior when no receipt identity is available', () => {
    const result = buildContactEnrichment(
      contact({ notes: 'first inquiry' }),
      { source: 'manual', notes: 'second inquiry' } as any,
      [],
    );

    expect(result).toEqual({ notes: 'first inquiry\nsecond inquiry' });
  });
});