import { describe, it, expect } from 'vitest';
import { resolveDefaultFromNumber, type DefaultFromNumberDeps } from './send-sms';

const C = 'contractor-1';

function deps(overrides: Partial<DefaultFromNumberDeps>): DefaultFromNumberDeps {
  return {
    getActiveSmsProvider: async () => 'dialpad',
    getTwilioNumber: async () => undefined,
    getContractor: async () => undefined,
    ...overrides,
  };
}

describe('resolveDefaultFromNumber (task #902 provider-aware default)', () => {
  describe('Dialpad active', () => {
    it('uses the creator default unvalidated (pre-#902 behavior preserved)', async () => {
      const r = await resolveDefaultFromNumber(C, '+15551230001', deps({}));
      expect(r).toEqual({ fromNumber: '+15551230001' });
    });

    it('falls back to the org defaultDialpadNumber when creator has none', async () => {
      const r = await resolveDefaultFromNumber(C, null, deps({
        getContractor: async () => ({ defaultDialpadNumber: '+15551230002' }),
      }));
      expect(r).toEqual({ fromNumber: '+15551230002' });
    });

    it('errors when neither creator nor org default exists', async () => {
      const r = await resolveDefaultFromNumber(C, undefined, deps({}));
      expect(r).toHaveProperty('error');
      expect((r as { error: string }).error).toMatch(/No "From" phone number/);
    });
  });

  describe('Twilio active', () => {
    it('uses the creator default when it belongs to the tenant Twilio numbers', async () => {
      const r = await resolveDefaultFromNumber(C, '+15551230003', deps({
        getActiveSmsProvider: async () => 'twilio',
        getTwilioNumber: async (_c, n) => (n === '+15551230003' ? { id: 'tw1' } : undefined),
      }));
      expect(r).toEqual({ fromNumber: '+15551230003' });
    });

    it('falls back to org defaultTwilioNumber when creator default is not a Twilio number', async () => {
      const r = await resolveDefaultFromNumber(C, '+15551230004', deps({
        getActiveSmsProvider: async () => 'twilio',
        getTwilioNumber: async () => undefined,
        getContractor: async () => ({ defaultTwilioNumber: '+15551230005' }),
      }));
      expect(r).toEqual({ fromNumber: '+15551230005' });
    });

    it('falls back to org defaultTwilioNumber when creator has no default at all', async () => {
      const r = await resolveDefaultFromNumber(C, null, deps({
        getActiveSmsProvider: async () => 'twilio',
        getContractor: async () => ({ defaultTwilioNumber: '+15551230006' }),
      }));
      expect(r).toEqual({ fromNumber: '+15551230006' });
    });

    it('errors clearly when nothing usable exists', async () => {
      const r = await resolveDefaultFromNumber(C, '+15551230007', deps({
        getActiveSmsProvider: async () => 'twilio',
      }));
      expect((r as { error: string }).error).toMatch(/default Twilio number/);
    });

    it('never silently uses a non-Twilio creator default when Twilio is the active provider', async () => {
      const r = await resolveDefaultFromNumber(C, '+15551230008', deps({
        getActiveSmsProvider: async () => 'twilio',
        getTwilioNumber: async () => undefined,
        getContractor: async () => ({ defaultTwilioNumber: null }),
      }));
      expect(r).toHaveProperty('error');
    });
  });

  describe('no enabled provider', () => {
    it('surfaces the provider-service error message', async () => {
      const r = await resolveDefaultFromNumber(C, '+15551230009', deps({
        getActiveSmsProvider: async () => {
          throw new Error('No enabled sms providers found for contractor contractor-1.');
        },
      }));
      expect((r as { error: string }).error).toMatch(/No enabled sms providers/);
    });
  });

  describe('other/unknown provider', () => {
    it('uses the creator default when present', async () => {
      const r = await resolveDefaultFromNumber(C, '+15551230010', deps({
        getActiveSmsProvider: async () => 'someother',
      }));
      expect(r).toEqual({ fromNumber: '+15551230010' });
    });

    it('errors when creator has no default', async () => {
      const r = await resolveDefaultFromNumber(C, null, deps({
        getActiveSmsProvider: async () => 'someother',
      }));
      expect(r).toHaveProperty('error');
    });
  });
});
