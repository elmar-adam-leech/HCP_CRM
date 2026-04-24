import { describe, it, expect } from 'vitest';
import { BOOKER_NOTES_MISSING_TOKEN } from '../scheduling/hcp-estimate';

// Mirrors the public-route check that decides whether to surface a
// customer-facing warning + email contractor admins.
function classifyBookerNotesWarning(scheduleError: string | undefined, customerNotesText: string): boolean {
  return !!scheduleError && customerNotesText.length > 0 && scheduleError.includes(BOOKER_NOTES_MISSING_TOKEN);
}

describe('public booking warning classification', () => {
  it('triggers when scheduleError contains the sentinel and customer typed notes', () => {
    const scheduleError = `Estimate was created in HousecallPro but the following note(s) could not be added automatically: booker notes. Please open HousecallPro to add them manually. ${BOOKER_NOTES_MISSING_TOKEN}`;
    expect(classifyBookerNotesWarning(scheduleError, 'tankless installation')).toBe(true);
  });

  it('does NOT trigger when only service-address note failed (no sentinel)', () => {
    // Mirrors the real failure-message format produced when only the
    // service-address note write failed but booker notes attached fine.
    const scheduleError = 'Estimate was created in HousecallPro but the following note(s) could not be added automatically: service address. Please open HousecallPro to add them manually.';
    expect(classifyBookerNotesWarning(scheduleError, 'some notes the customer typed')).toBe(false);
  });

  it('does NOT trigger when scheduleError is missing entirely', () => {
    expect(classifyBookerNotesWarning(undefined, 'some notes the customer typed')).toBe(false);
  });

  it('does NOT trigger when the customer typed no notes (nothing to warn about)', () => {
    const scheduleError = `Estimate was created in HousecallPro but the following note(s) could not be added automatically: booker notes. ${BOOKER_NOTES_MISSING_TOKEN}`;
    expect(classifyBookerNotesWarning(scheduleError, '')).toBe(false);
  });
});
