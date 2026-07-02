export interface TimeSlot {
  start: Date;
  end: Date;
}

export interface BusyWindow {
  start: string;
  end: string;
}

export interface AvailableSlot {
  start: Date;
  end: Date;
  availableSalespersonIds: string[];
}

/**
 * A single entry rendered on the read-only unified day schedule (task #861).
 * `source` distinguishes CRM-created bookings from external Google Calendar
 * busy blocks so the UI can label them clearly. Google entries are opaque
 * busy windows (no title/attendees) to preserve teammates' event privacy.
 */
export interface CalendarEvent {
  source: 'crm' | 'google';
  id: string;
  title: string;
  start: string;
  end: string;
  salespersonId: string | null;
  salespersonName: string | null;
  status?: string | null;
  customerName?: string | null;
}

export interface AddressComponents {
  street: string;
  city: string;
  state: string;
  zip: string;
  country?: string;
}

export function parseAddressString(address: string): AddressComponents {
  const trimmed = address.trim();
  // Handle comma-less single-line addresses like "456 Oak Ave Baltimore MD 21218"
  // (and "123 Main St Los Angeles CA 90001"). Strategy: anchor on the trailing
  // `<STATE> <ZIP>`, then locate a street-suffix token (St, Ave, Blvd, etc.) in
  // the remainder. Everything from the start through that suffix is the street;
  // everything after it (until STATE) is the city — which correctly captures
  // multi-word cities. Falls back to "last token = city" only when no suffix is
  // found, preserving the single-word-city behaviour for inputs like
  // "456 Oak Baltimore MD 21218".
  if (!trimmed.includes(',')) {
    const tail = trimmed.match(/^(.*?)\s+([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)$/);
    if (tail) {
      const beforeStateZip = tail[1].trim();
      const tokens = beforeStateZip.split(/\s+/);
      if (tokens.length >= 2 && /^\d+/.test(tokens[0])) {
        const STREET_SUFFIXES = new Set([
          'st', 'street', 'ave', 'avenue', 'blvd', 'boulevard', 'rd', 'road',
          'dr', 'drive', 'ln', 'lane', 'way', 'ct', 'court', 'pl', 'place',
          'pkwy', 'parkway', 'ter', 'terrace', 'cir', 'circle', 'hwy', 'highway',
          'trl', 'trail', 'sq', 'square', 'aly', 'alley', 'row', 'loop',
        ]);
        const normalize = (t: string) => t.toLowerCase().replace(/\.$/, '');
        let suffixIdx = -1;
        // Search from the right so a suffix appearing inside a city name (rare)
        // doesn't beat the actual street suffix.
        for (let i = tokens.length - 2; i >= 1; i--) {
          if (STREET_SUFFIXES.has(normalize(tokens[i]))) {
            suffixIdx = i;
            break;
          }
        }
        let street: string;
        let city: string;
        if (suffixIdx >= 1 && suffixIdx < tokens.length - 1) {
          street = tokens.slice(0, suffixIdx + 1).join(' ');
          city = tokens.slice(suffixIdx + 1).join(' ');
        } else {
          city = tokens[tokens.length - 1];
          street = tokens.slice(0, -1).join(' ');
        }
        return {
          street,
          city,
          state: tail[2].toUpperCase(),
          zip: tail[3],
          country: 'US',
        };
      }
    }
  }
  const parts = trimmed.split(',').map(s => s.trim());
  if (parts.length >= 3) {
    const street = parts[0];
    const city = parts[1];
    const stateZipPart = parts[2];
    const stateZipMatch = stateZipPart.match(/^([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)$/);
    if (stateZipMatch) {
      return {
        street,
        city,
        state: stateZipMatch[1].toUpperCase(),
        zip: stateZipMatch[2],
        country: parts[3]?.trim() || 'US',
      };
    }
    const stateOnlyMatch = stateZipPart.match(/^([A-Za-z]{2})$/);
    if (stateOnlyMatch) {
      const zipPart = parts[3]?.trim();
      const zipMatch = zipPart?.match(/^(\d{5}(?:-\d{4})?)$/);
      return {
        street,
        city,
        state: stateOnlyMatch[1].toUpperCase(),
        zip: zipMatch ? zipMatch[1] : '',
        country: 'US',
      };
    }
    return {
      street,
      city,
      state: stateZipPart,
      zip: parts[3]?.trim() || '',
      country: 'US',
    };
  }
  if (parts.length === 2) {
    return { street: parts[0], city: parts[1], state: '', zip: '', country: 'US' };
  }
  return { street: address, city: '', state: '', zip: '', country: 'US' };
}

export function hasRealStreetAddress(address: string): boolean {
  const trimmed = address.trim();
  if (!trimmed) return false;
  const parts = trimmed.split(',').map(s => s.trim());
  // For multi-part addresses, require a real US `<STATE> <ZIP>` tail.
  // Without this, strings like "123 Main, Some Town, foo bar" produce
  // garbage city/state/zip from the loose parser.
  if (parts.length >= 3) {
    const tail = parts.slice(2).join(' ');
    return /\b[A-Za-z]{2}\b\s+\d{5}(?:-\d{4})?\b/.test(tail);
  }
  // Comma-less: only treat as "real" when we can actually parse a full
  // <number street...> <city> <STATE> <ZIP> tail. This protects callers
  // (e.g. public booking writeback) from persisting empty city/state/zip
  // when the user typed only a partial address.
  if (!/^\d+\s+\S+/.test(trimmed)) return false;
  const tail = trimmed.match(/\s+[A-Za-z]{2}\s+\d{5}(?:-\d{4})?$/);
  return !!tail;
}

export interface BookingRequest {
  startTime: Date;
  title: string;
  customerName: string;
  customerEmail?: string;
  customerPhone?: string;
  customerAddress?: string;
  customerAddressComponents?: AddressComponents;
  notes?: string;
  contactId?: string;
  salespersonId?: string;
  housecallProEmployeeId?: string;
  timezone?: string;
  bookingPayload?: Record<string, unknown>;
  /**
   * Where this booking was initiated from. Used as a diagnostic label by the
   * markContactScheduled helper so the audit trail distinguishes in-app bookings
   * from public booking widget submissions. Defaults to 'in_app_booking'.
   */
  scheduleSource?: 'in_app_booking' | 'public_booking' | 'ai_agent';
}

export interface BookingResult {
  success: boolean;
  bookingId?: string;
  assignedSalespersonId?: string;
  assignedSalespersonName?: string;
  housecallProEventId?: string;
  googleCalendarEventId?: string;
  error?: string;
  scheduleError?: string;
}

export interface SalespersonInfo {
  userId: string;
  name: string;
  email: string;
  housecallProUserId: string | null;
  lastAssignmentAt: Date | null;
  calendarColor: string | null;
  isSalesperson: boolean;
  workingDays: number[];
  workingHoursStart: string;
  workingHoursEnd: string;
  hasCustomSchedule: boolean;
  displayOrder: number | null;
  // Per-user Google Calendar connection (task #858). The refresh token is
  // AES-256-GCM encrypted at rest; availability reads busy times from it and
  // booking writes real events to it.
  googleCalendarConnected?: boolean;
  googleCalendarRefreshToken?: string | null;
}
