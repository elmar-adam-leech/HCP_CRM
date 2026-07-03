import { describe, it, expect, afterEach, vi } from 'vitest';
import { localYmd, todayYmdInTimezone } from './utils';

afterEach(() => {
  vi.useRealTimers();
});

describe('localYmd', () => {
  it('formats a Date as YYYY-MM-DD using its displayed local components', () => {
    // react-day-picker builds calendar squares at local midnight; localYmd must
    // reflect the displayed calendar date, not any UTC shift.
    const d = new Date(2026, 6, 2); // July 2, 2026 local
    expect(localYmd(d)).toBe('2026-07-02');
  });

  it('zero-pads single-digit months and days', () => {
    expect(localYmd(new Date(2026, 0, 5))).toBe('2026-01-05');
  });
});

describe('todayYmdInTimezone (task #877 same-day boundary)', () => {
  it('anchors "today" to the contractor timezone, not the browser', () => {
    // Freeze "now" to an instant that is still the previous calendar day in a
    // western US timezone but already the next day in UTC. The contractor-local
    // date must win.
    // 2026-07-02T04:30:00Z === 2026-07-01 21:30 in America/Los_Angeles.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-02T04:30:00Z'));

    expect(todayYmdInTimezone('America/Los_Angeles')).toBe('2026-07-01');
    expect(todayYmdInTimezone('UTC')).toBe('2026-07-02');
  });

  it('falls back to the browser timezone when tz is missing or invalid', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-02T12:00:00Z'));

    const browser = todayYmdInTimezone(undefined);
    expect(todayYmdInTimezone(null)).toBe(browser);
    expect(todayYmdInTimezone('Not/AZone')).toBe(browser);
    expect(browser).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('keeps a same-day calendar square selectable in the contractor tz', () => {
    // At 21:30 local (LA) on July 1, the July 1 square must NOT be disabled
    // even though UTC has already rolled to July 2.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-02T04:30:00Z'));

    const today = todayYmdInTimezone('America/Los_Angeles');
    const julyFirstSquare = localYmd(new Date(2026, 6, 1));
    const juneThirtySquare = localYmd(new Date(2026, 5, 30));

    // disabled predicate is `localYmd(date) < contractorTodayYmd`
    expect(julyFirstSquare < today).toBe(false); // today — selectable
    expect(juneThirtySquare < today).toBe(true); // past — disabled
  });
});
