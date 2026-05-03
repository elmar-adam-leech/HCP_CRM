/**
 * Unit coverage for resolveAddressComponents — the resolver that decides
 * which address gets shipped to HCP for a booking.
 *
 * Covers Task #690 step 4 (defense-in-depth). The resolver must always
 * prefer the user's just-submitted address over the contact's prior stored
 * address, even when the strict `hasRealStreetAddress` check rejects the
 * submitted string (partial address typed by hand, or missing zip).
 */
import { describe, it, expect } from 'vitest';

import { resolveAddressComponents } from '../scheduling/hcp-customer';
import { hasRealStreetAddress, type BookingRequest } from '../types/scheduling';

const STORED_CONTACT = {
  street: '100 Old Way',
  city: 'Boston',
  state: 'MA',
  zip: '02101',
};
const STORED_CONTACT_ADDRESS = '100 Old Way, Boston, MA 02101';

function req(overrides: Partial<BookingRequest>): BookingRequest {
  return overrides as BookingRequest;
}

describe('resolveAddressComponents', () => {
  it('structured request components win over stored contact when no conflicting string is present', () => {
    // No customerAddress string at all → components are the only signal
    // describing the user's intent for this booking, so they win over the
    // stored contact's prior address.
    const result = resolveAddressComponents(
      req({
        customerAddressComponents: {
          street: '123 New St',
          city: 'Salem',
          state: 'NH',
          zip: '03079',
          country: 'US',
        },
      }),
      STORED_CONTACT_ADDRESS,
      STORED_CONTACT,
    );
    expect(result?.street).toBe('123 New St');
    expect(result?.city).toBe('Salem');
    expect(result?.zip).toBe('03079');
  });

  it('full request string with city + zip wins over stored contact address', () => {
    // Three+ comma-separated parts → hasRealStreetAddress = true → primary path.
    const result = resolveAddressComponents(
      req({ customerAddress: '123 New St, Salem, NH 03079' }),
      STORED_CONTACT_ADDRESS,
      STORED_CONTACT,
    );
    expect(result?.street).toBe('123 New St');
    expect(result?.city).toBe('Salem');
  });

  it('partial request string with no zip still wins over stored contact address (defense-in-depth)', () => {
    // "123 New St, Salem NH" — no zip and only two comma-separated parts —
    // is rejected by hasRealStreetAddress. Before fix, the resolver silently
    // fell back to the contact's stored "100 Old Way". After fix, the
    // best-effort parse of the user's submission must win.
    const result = resolveAddressComponents(
      req({ customerAddress: '123 New St, Salem NH' }),
      STORED_CONTACT_ADDRESS,
      STORED_CONTACT,
    );
    expect(result?.street).toBe('123 New St');
    expect(result?.street).not.toBe('100 Old Way');
  });

  it('comma-less single-line typed request still wins over stored contact address', () => {
    // "123 New Street" with no commas at all — also rejected by the strict
    // gate. Defense-in-depth must still prefer this over "100 Old Way".
    const result = resolveAddressComponents(
      req({ customerAddress: '123 New Street' }),
      STORED_CONTACT_ADDRESS,
      STORED_CONTACT,
    );
    expect(result?.street).toBe('123 New Street');
    expect(result?.street).not.toBe('100 Old Way');
  });

  it('STALE structured components case: components.street is not present, but request string is — request string wins', () => {
    // Frontend bug case before client-side fix: the user picked a Google
    // suggestion (sets components), then edited the input (string changes
    // but components stale). With the client fix in place, components are
    // cleared on edit and only the string arrives — verify the resolver
    // still produces the user's submission, not the contact's prior data.
    const result = resolveAddressComponents(
      req({
        customerAddress: '456 Edited Ave, Salem, NH 03079',
        customerAddressComponents: undefined,
      }),
      STORED_CONTACT_ADDRESS,
      STORED_CONTACT,
    );
    expect(result?.street).toBe('456 Edited Ave');
  });

  it('empty request string falls back to the contact (no submission to honor)', () => {
    const result = resolveAddressComponents(
      req({ customerAddress: '' }),
      STORED_CONTACT_ADDRESS,
      STORED_CONTACT,
    );
    expect(result?.street).toBe('100 Old Way');
  });

  it('whitespace-only request string falls back to the contact', () => {
    const result = resolveAddressComponents(
      req({ customerAddress: '   ' }),
      STORED_CONTACT_ADDRESS,
      STORED_CONTACT,
    );
    expect(result?.street).toBe('100 Old Way');
  });

  it('no submitted address and no stored contact returns undefined', () => {
    const result = resolveAddressComponents(req({}), null, null);
    expect(result).toBeUndefined();
  });

  it('CONFLICT GUARD: stale components do NOT win over a typed string that disagrees', () => {
    // Non-conforming external caller (or stale client) sends BOTH a typed
    // string AND structured components, but they describe different streets.
    // The typed string is what the human just submitted — it must win.
    const result = resolveAddressComponents(
      req({
        customerAddress: '456 Edited Ave, Salem, NH 03079',
        customerAddressComponents: {
          street: '789 Stale Blvd',
          city: 'Springfield',
          state: 'IL',
          zip: '62701',
          country: 'US',
        },
      }),
      STORED_CONTACT_ADDRESS,
      STORED_CONTACT,
    );
    expect(result?.street).toBe('456 Edited Ave');
    expect(result?.street).not.toBe('789 Stale Blvd');
    expect(result?.city).toBe('Salem');
  });

  it('CONFLICT GUARD: components win when typed string actually contains them (agreement case)', () => {
    // Agreement case: components and string describe the same street. The
    // structured components are richer (have country) so they should still
    // be the winner, not the parsed string.
    const result = resolveAddressComponents(
      req({
        customerAddress: '123 New St, Salem, NH 03079',
        customerAddressComponents: {
          street: '123 New St',
          city: 'Salem',
          state: 'NH',
          zip: '03079',
          country: 'US',
        },
      }),
      STORED_CONTACT_ADDRESS,
      STORED_CONTACT,
    );
    expect(result?.street).toBe('123 New St');
    expect(result?.country).toBe('US');
  });

  // The loose parser is last-resort — auto-resolve paths fill in partials.
  // It only runs when a real US `<STATE> <ZIP>` is present in the tail.
  describe('hasRealStreetAddress', () => {
    it('accepts a full 3-part address with state + zip in the tail', () => {
      expect(hasRealStreetAddress('123 Maple St, Springfield, IL 62701')).toBe(true);
    });

    it('accepts a 4-part address with apt + state + zip', () => {
      expect(hasRealStreetAddress('123 Maple St, Apt 4, Springfield, IL 62701')).toBe(true);
    });

    it('accepts a comma-less address with a clear <street> <STATE> <ZIP> tail', () => {
      expect(hasRealStreetAddress('123 Maple St Springfield IL 62701')).toBe(true);
    });

    it('REJECTS a 3-part address whose tail has no state + zip (used to slip through)', () => {
      // Previously `parts.length >= 3` was enough — this would route the
      // user's submission straight into the loose parser and produce
      // garbage city/state/zip. Now: rejected → caller falls through to
      // the Places fallback path.
      expect(hasRealStreetAddress('123 Maple St, Some Town, foo bar')).toBe(false);
    });

    it('REJECTS a 2-part address with no zip', () => {
      expect(hasRealStreetAddress('123 New St, Salem NH')).toBe(false);
    });

    it('REJECTS a comma-less single-line typed string with no tail', () => {
      expect(hasRealStreetAddress('123 New Street')).toBe(false);
    });

    it('REJECTS empty / whitespace-only input', () => {
      expect(hasRealStreetAddress('')).toBe(false);
      expect(hasRealStreetAddress('   ')).toBe(false);
    });
  });

  it('CONFLICT GUARD: agreement is case- and punctuation-insensitive (no false-positive disagreement)', () => {
    // Components: "123 New St." (with period). Typed: "123 NEW ST, Salem,
    // NH 03079" (uppercase, no period). These describe the same street, so
    // the conflict guard must NOT trip and components win.
    const result = resolveAddressComponents(
      req({
        customerAddress: '123 NEW ST, Salem, NH 03079',
        customerAddressComponents: {
          street: '123 New St.',
          city: 'Salem',
          state: 'NH',
          zip: '03079',
          country: 'US',
        },
      }),
      STORED_CONTACT_ADDRESS,
      STORED_CONTACT,
    );
    expect(result?.street).toBe('123 New St.');
  });
});
