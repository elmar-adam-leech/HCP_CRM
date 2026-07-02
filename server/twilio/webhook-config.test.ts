import { describe, it, expect, vi, beforeEach } from 'vitest';

// When a contractor's Twilio number lives inside a Messaging Service, Twilio
// ignores the number-level SMS webhook and uses the Service's inbound setting.
// configureTwilioWebhooks must set the Service's InboundRequestUrl DIRECTLY to
// our SMS webhook (and UseInboundWebhookOnNumber=false) on any Service that owns
// one of the contractor's numbers so inbound texts reach the CRM — the earlier
// UseInboundWebhookOnNumber=true deferral did not take effect for some accounts.
// Outbound/A2P config is left alone and the operation stays idempotent on re-run.

const twilioFormMock = vi.fn();
const twilioMessagingGetMock = vi.fn();
const twilioMessagingFormMock = vi.fn();

const twilioGetMock = vi.fn();

vi.mock('./client', () => ({
  getTwilioCredentials: vi.fn().mockResolvedValue({ accountSid: 'AC', authToken: 'tok', baseUrl: 'https://api.twilio.com' }),
  twilioForm: (...args: unknown[]) => twilioFormMock(...args),
  twilioGet: (...args: unknown[]) => twilioGetMock(...args),
  twilioMessagingGet: (...args: unknown[]) => twilioMessagingGetMock(...args),
  twilioMessagingForm: (...args: unknown[]) => twilioMessagingFormMock(...args),
}));

vi.mock('../utils/public-base-url', () => ({
  getPublicBaseUrl: () => 'https://crm.example.com',
}));

const upsertTwilioWebhookStateMock = vi.fn().mockResolvedValue({});
const getTwilioPhoneNumbersMock = vi.fn();
const getContractorMock = vi.fn();

vi.mock('../storage', () => ({
  storage: {
    getTwilioPhoneNumbers: (...args: unknown[]) => getTwilioPhoneNumbersMock(...args),
    upsertTwilioWebhookState: (...args: unknown[]) => upsertTwilioWebhookStateMock(...args),
    getContractor: (...args: unknown[]) => getContractorMock(...args),
  },
}));

import { configureTwilioWebhooks } from './webhook-config';

const okJson = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => '' });

describe('configureTwilioWebhooks — Messaging Service inbound routing', () => {
  beforeEach(() => {
    twilioFormMock.mockReset().mockResolvedValue(okJson({ sid: 'PN1' }));
    twilioMessagingGetMock.mockReset();
    twilioMessagingFormMock.mockReset().mockResolvedValue(okJson({ sid: 'MG1' }));
    upsertTwilioWebhookStateMock.mockClear();
    getTwilioPhoneNumbersMock.mockReset().mockResolvedValue([
      { id: 'n1', twilioSid: 'PN1', phoneNumber: '+15551112222', isActive: true },
    ]);
    getContractorMock.mockReset().mockResolvedValue({ id: 'c1', twilioInboundCallMode: 'crm' });
  });

  const smsUrl = 'https://crm.example.com/api/webhooks/twilio/sms/c1';

  it('sets InboundRequestUrl directly on the Service owning the number', async () => {
    twilioMessagingGetMock.mockImplementation((_creds: unknown, path: string) => {
      if (path.startsWith('/Services?')) {
        return Promise.resolve(okJson({ services: [{ sid: 'MG1', use_inbound_webhook_on_number: false }], meta: {} }));
      }
      return Promise.resolve(okJson({ phone_numbers: [{ sid: 'PN1', phone_number: '+15551112222' }], meta: {} }));
    });

    const result = await configureTwilioWebhooks('c1');

    expect(result.configured).toBe(1);
    expect(result.messagingServicesConfigured).toBe(1);
    expect(result.inboundRouting.ok).toBe(true);
    expect(twilioMessagingFormMock).toHaveBeenCalledTimes(1);
    const [, path, params] = twilioMessagingFormMock.mock.calls[0] as [unknown, string, Record<string, string>];
    expect(path).toBe('/Services/MG1');
    expect(params.InboundRequestUrl).toBe(smsUrl);
    expect(params.InboundMethod).toBe('POST');
    expect(params.UseInboundWebhookOnNumber).toBe('false');
    expect(upsertTwilioWebhookStateMock.mock.calls[0][0].configuredMessagingServiceSids).toEqual(['MG1']);
  });

  it('is idempotent: counts but does not re-POST a Service already pointed at our URL', async () => {
    twilioMessagingGetMock.mockImplementation((_creds: unknown, path: string) => {
      if (path.startsWith('/Services?')) {
        return Promise.resolve(okJson({ services: [{ sid: 'MG1', inbound_request_url: smsUrl, use_inbound_webhook_on_number: false }], meta: {} }));
      }
      return Promise.resolve(okJson({ phone_numbers: [{ sid: 'PN1' }], meta: {} }));
    });

    const result = await configureTwilioWebhooks('c1');

    expect(result.messagingServicesConfigured).toBe(1);
    expect(result.inboundRouting.ok).toBe(true);
    expect(twilioMessagingFormMock).not.toHaveBeenCalled();
  });

  it('re-POSTs a Service that only defers via UseInboundWebhookOnNumber=true', async () => {
    twilioMessagingGetMock.mockImplementation((_creds: unknown, path: string) => {
      if (path.startsWith('/Services?')) {
        return Promise.resolve(okJson({ services: [{ sid: 'MG1', use_inbound_webhook_on_number: true }], meta: {} }));
      }
      return Promise.resolve(okJson({ phone_numbers: [{ sid: 'PN1' }], meta: {} }));
    });

    const result = await configureTwilioWebhooks('c1');

    expect(result.messagingServicesConfigured).toBe(1);
    expect(twilioMessagingFormMock).toHaveBeenCalledTimes(1);
    const [, , params] = twilioMessagingFormMock.mock.calls[0] as [unknown, string, Record<string, string>];
    expect(params.InboundRequestUrl).toBe(smsUrl);
  });

  it('ignores Services that do not own any of the contractor numbers', async () => {
    twilioMessagingGetMock.mockImplementation((_creds: unknown, path: string) => {
      if (path.startsWith('/Services?')) {
        return Promise.resolve(okJson({ services: [{ sid: 'MGX', use_inbound_webhook_on_number: false }], meta: {} }));
      }
      return Promise.resolve(okJson({ phone_numbers: [{ sid: 'PN-other', phone_number: '+19998887777' }], meta: {} }));
    });

    const result = await configureTwilioWebhooks('c1');

    expect(result.messagingServicesConfigured).toBe(0);
    expect(twilioMessagingFormMock).not.toHaveBeenCalled();
  });

  it('stays resilient when listing Services fails, still configuring numbers', async () => {
    twilioMessagingGetMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}), text: async () => 'boom' });

    const result = await configureTwilioWebhooks('c1');

    expect(result.configured).toBe(1);
    expect(result.messagingServicesConfigured).toBe(0);
  });
});

// Task #853: contractors can keep their own Twilio call handling (e.g. a Studio
// Flow / IVR) instead of the CRM's ring-a-rep + voicemail flow. In 'external'
// mode Sync must NOT touch VoiceUrl/VoiceMethod on the number, but must still
// set SmsUrl (inbound texts) and StatusCallback (call logging — it fires no
// matter what answers the call). Default 'crm' mode is byte-for-byte unchanged.
describe('configureTwilioWebhooks — inbound call mode', () => {
  beforeEach(() => {
    twilioFormMock.mockReset().mockResolvedValue(okJson({ sid: 'PN1' }));
    twilioMessagingGetMock.mockReset().mockResolvedValue(okJson({ services: [], meta: {} }));
    twilioMessagingFormMock.mockReset();
    upsertTwilioWebhookStateMock.mockClear();
    getTwilioPhoneNumbersMock.mockReset().mockResolvedValue([
      { id: 'n1', twilioSid: 'PN1', phoneNumber: '+15551112222', isActive: true },
    ]);
  });

  const voiceUrl = 'https://crm.example.com/api/webhooks/twilio/voice/incoming/c1';
  const smsUrl = 'https://crm.example.com/api/webhooks/twilio/sms/c1';
  const statusUrl = 'https://crm.example.com/api/webhooks/twilio/voice/status/c1';

  it("mode 'external': omits VoiceUrl/VoiceMethod but still sets SmsUrl and StatusCallback", async () => {
    getContractorMock.mockReset().mockResolvedValue({ id: 'c1', twilioInboundCallMode: 'external' });

    const result = await configureTwilioWebhooks('c1');

    expect(result.configured).toBe(1);
    expect(twilioFormMock).toHaveBeenCalledTimes(1);
    const [, path, params] = twilioFormMock.mock.calls[0] as [unknown, string, Record<string, string>];
    expect(path).toBe('/IncomingPhoneNumbers/PN1.json');
    expect(params.VoiceUrl).toBeUndefined();
    expect(params.VoiceMethod).toBeUndefined();
    expect(params.SmsUrl).toBe(smsUrl);
    expect(params.SmsMethod).toBe('POST');
    expect(params.StatusCallback).toBe(statusUrl);
    expect(params.StatusCallbackMethod).toBe('POST');
    // Webhook state must not claim we registered a voice URL we did not set.
    expect(upsertTwilioWebhookStateMock.mock.calls[0][0].lastRegisteredVoiceUrl).toBeNull();
    expect(upsertTwilioWebhookStateMock.mock.calls[0][0].lastRegisteredSmsUrl).toBe(smsUrl);
  });

  it("mode 'crm' (default): sets VoiceUrl, SmsUrl and StatusCallback exactly as before (regression)", async () => {
    getContractorMock.mockReset().mockResolvedValue({ id: 'c1', twilioInboundCallMode: 'crm' });

    const result = await configureTwilioWebhooks('c1');

    expect(result.configured).toBe(1);
    const [, path, params] = twilioFormMock.mock.calls[0] as [unknown, string, Record<string, string>];
    expect(path).toBe('/IncomingPhoneNumbers/PN1.json');
    expect(params).toEqual({
      VoiceUrl: voiceUrl,
      VoiceMethod: 'POST',
      StatusCallback: statusUrl,
      StatusCallbackMethod: 'POST',
      SmsUrl: smsUrl,
      SmsMethod: 'POST',
    });
    expect(upsertTwilioWebhookStateMock.mock.calls[0][0].lastRegisteredVoiceUrl).toBe(voiceUrl);
  });

  it('missing contractor row falls back to crm behavior (sets VoiceUrl)', async () => {
    getContractorMock.mockReset().mockResolvedValue(undefined);

    await configureTwilioWebhooks('c1');

    const [, , params] = twilioFormMock.mock.calls[0] as [unknown, string, Record<string, string>];
    expect(params.VoiceUrl).toBe(voiceUrl);
    expect(params.VoiceMethod).toBe('POST');
  });
});
