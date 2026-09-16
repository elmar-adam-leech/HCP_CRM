import { describe, expect, it } from 'vitest';
import { buildContactEnrichment } from './contact-enrichment';

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