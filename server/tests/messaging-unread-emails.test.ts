import { describe, it, expect } from 'vitest';
import { deriveInitialReadAt } from '../storage/activities';

describe('deriveInitialReadAt', () => {
  it('returns NOW for outbound email activities so they never count as unread', () => {
    const before = Date.now();
    const result = deriveInitialReadAt({
      type: 'email',
      content: 'hi',
      metadata: { direction: 'outbound', subject: 's' },
    });
    expect(result).toBeInstanceOf(Date);
    expect((result as Date).getTime()).toBeGreaterThanOrEqual(before);
  });

  it('returns undefined (NULL) for inbound email activities so they count as unread', () => {
    const result = deriveInitialReadAt({
      type: 'email',
      content: 'hi',
      metadata: { direction: 'inbound', subject: 's' },
    });
    expect(result).toBeUndefined();
  });

  it('returns undefined for email activities without explicit direction (treated as unread)', () => {
    const result = deriveInitialReadAt({
      type: 'email',
      content: 'hi',
      metadata: { subject: 's' },
    });
    expect(result).toBeUndefined();
  });

  it('returns undefined for email activities with no metadata', () => {
    const result = deriveInitialReadAt({
      type: 'email',
      content: 'hi',
    });
    expect(result).toBeUndefined();
  });

  it('returns undefined for non-email activity types regardless of metadata', () => {
    expect(deriveInitialReadAt({
      type: 'sms',
      content: 'hi',
      metadata: { direction: 'outbound' },
    })).toBeUndefined();
    expect(deriveInitialReadAt({
      type: 'note',
      content: 'note text',
    })).toBeUndefined();
    expect(deriveInitialReadAt({
      type: 'call',
      content: 'rang',
    })).toBeUndefined();
  });

  it('respects an explicit caller-supplied readAt (opt-out)', () => {
    const fixed = new Date('2024-01-01T00:00:00Z');
    expect(deriveInitialReadAt({
      type: 'email',
      content: 'hi',
      metadata: { direction: 'outbound' },
      readAt: fixed,
    })).toBe(fixed);

    expect(deriveInitialReadAt({
      type: 'email',
      content: 'hi',
      metadata: { direction: 'inbound' },
      readAt: null,
    })).toBeNull();
  });

  it('handles non-object metadata defensively', () => {
    expect(deriveInitialReadAt({
      type: 'email',
      content: 'hi',
      // @ts-expect-error — guarding against legacy/malformed rows
      metadata: 'not-an-object',
    })).toBeUndefined();

    expect(deriveInitialReadAt({
      type: 'email',
      content: 'hi',
      metadata: null,
    })).toBeUndefined();
  });
});
