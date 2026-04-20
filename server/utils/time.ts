/**
 * Timezone utility functions extracted from HousecallSchedulingService.
 *
 * All functions here are pure (no side effects, no DB access). They rely
 * exclusively on the Intl.DateTimeFormat API which is available in all
 * Node.js environments ≥12. No external packages are required.
 *
 * DST handling note: JavaScript's Intl.DateTimeFormat resolves wall-clock
 * times in the target timezone correctly across DST transitions. The
 * createDateInTimezone iterative approach handles "spring forward" gaps
 * and "fall back" ambiguities by converging on the correct UTC instant.
 */

/**
 * Parse a "HH:MM" time string into numeric hours and minutes.
 * Minutes default to 0 if the string has no colon component.
 */
export function parseWorkingHours(timeStr: string): { hours: number; minutes: number } {
  const [hours, minutes = 0] = timeStr.split(':').map(Number);
  return { hours, minutes };
}

/**
 * Return the calendar date parts (year, month-0-indexed, day) for a given
 * UTC instant as seen in a specific IANA timezone.
 *
 * @example
 *   getDatePartsInTimezone(new Date('2024-03-10T06:00:00Z'), 'America/New_York')
 *   // → { year: 2024, month: 2, day: 10 }  (month is 0-indexed)
 */
export function getDatePartsInTimezone(
  date: Date,
  timezone: string
): { year: number; month: number; day: number } {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  });
  const parts = formatter.formatToParts(date);
  const getPart = (type: string) => parseInt(parts.find(p => p.type === type)?.value || '0');
  return {
    year: getPart('year'),
    month: getPart('month') - 1, // Intl returns 1-indexed months; convert to 0-indexed
    day: getPart('day'),
  };
}

/**
 * Find the UTC instant that corresponds to a specific wall-clock time
 * (hours:minutes) on the same calendar day as `date`, in `timezone`.
 *
 * Uses an iterative convergence loop (max 48 half-hour steps) to handle DST
 * transitions where a naive UTC offset calculation would land in a gap or
 * duplicate hour. Returns the best approximation after 48 iterations if
 * exact convergence is not reached (should not occur in practice).
 */
export function createDateInTimezone(
  date: Date,
  hours: number,
  minutes: number,
  timezone: string
): Date {
  const { year, month, day } = getDatePartsInTimezone(date, timezone);

  const localDateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00`;

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hour12: false,
  });

  let testDate = new Date(`${localDateStr}Z`);
  for (let i = 0; i < 48; i++) {
    const parts = formatter.formatToParts(testDate);
    const getPart = (type: string) => parseInt(parts.find(p => p.type === type)?.value || '0');
    const tzHour = getPart('hour');
    const tzMinute = getPart('minute');

    if (tzHour === hours && tzMinute === minutes) {
      return testDate;
    }

    // Raw minute difference between target and current TZ time.
    const rawDiffMin = (hours - tzHour) * 60 + (minutes - tzMinute);

    // Normalize to the range (-720, +720] so that the iteration always moves
    // in the direction that is ≤ 12 hours away.  Without this, a case like
    // tzHour=20 / target=0 (midnight) would produce hourDiff=-20 and march
    // the clock backward 20 h, landing on midnight of the PREVIOUS TZ day
    // instead of midnight of the CURRENT TZ day (+4 h forward).
    const normalizedDiffMin = ((rawDiffMin % (24 * 60)) + (24 * 60)) % (24 * 60);
    const adjustedDiffMin = normalizedDiffMin > 12 * 60 ? normalizedDiffMin - 24 * 60 : normalizedDiffMin;
    testDate = new Date(testDate.getTime() + adjustedDiffMin * 60 * 1000);
  }

  return testDate;
}

/**
 * Return the day-of-week index (0 = Sunday, 6 = Saturday) for a UTC instant
 * as seen in the given IANA timezone.
 *
 * Uses Intl.DateTimeFormat with weekday:'short' so the result is DST-aware
 * (differs from `date.getDay()` which uses the local Node.js timezone).
 */
export function getDayOfWeekInTimezone(date: Date, timezone: string): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
  });
  const dayName = formatter.format(date);
  const dayMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  return dayMap[dayName] ?? 0;
}
