import { describe, it, expect, vi, beforeEach } from 'vitest';

// Task #840: when a contractor's Twilio number lives inside a Messaging Service,
// Twilio ignores the number-level SMS webhook and uses the Service's inbound
// setting. configureTwilioWebhooks must flip UseInboundWebhookOnNumber=true on
// any Service that owns one of the contractor's numbers so inbound texts reach
// the CRM, while leaving outbound/A2P alone and staying idempotent.

const twilioFormMock = vi.fn();
const twilioMessagingGetMock = vi.fn();
const twilioMessagingFormMock = vi.fn();

vi.mock('./client', () => ({
  getTwilioCredentials: vi.fn().mockResolvedValue({ accountSid: 'AC', authToken: 'tok', baseUrl: 'https://api.twilio.com' }),
  twilioForm: (...args: unknown[]) => twilioFormMock(...args),
  twilioMessagingGet: (...args: unknown[]) => twilioMessagingGetMock(...args),
  twilioMessagingForm: (...args: unknown[]) => twilioMessagingFormMock(...args),
}));

vi.mock('../utils/public-base-url', () => ({
  getPublicBaseUrl: () => 'https://crm.example.com',
}));

const upsertTwilioWebhookStateMock = vi.fn().mockResolvedValue({});
const getTwilioPhoneNumbersMock = vi.fn();

vi.mock('../storage', () => ({
  storage: {
    getTwilioPhoneNumbers: (...args: unknown[]) => getTwilioPhoneNumbersMock(...args),
    upsertTwilioWebhookState: (...args: unknown[]) => upsertTwilioWebhookStateMock(...args),
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
  });

  it('flips UseInboundWebhookOnNumber on the Service owning the number', async () => {
    twilioMessagingGetMock.mockImplementation((_creds: unknown, path: string) => {
      if (path.startsWith('/Services?')) {
        return Promise.resolve(okJson({ services: [{ sid: 'MG1', use_inbound_webhook_on_number: false }], meta: {} }));
      }
      return Promise.resolve(okJson({ phone_numbers: [{ sid: 'PN1', phone_number: '+15551112222' }], meta: {} }));
    });

    const result = await configureTwilioWebhooks('c1');

    expect(result.configured).toBe(1);
    expect(result.messagingServicesConfigured).toBe(1);
    expect(twilioMessagingFormMock).toHaveBeenCalledTimes(1);
    const [, path, params] = twilioMessagingFormMock.mock.calls[0] as [unknown, string, Record<string, string>];
    expect(path).toBe('/Services/MG1');
    expect(params.UseInboundWebhookOnNumber).toBe('true');
    expect(upsertTwilioWebhookStateMock.mock.calls[0][0].configuredMessagingServiceSids).toEqual(['MG1']);
  });

  it('is idempotent: counts but does not re-POST a Service already deferring to the number', async () => {
    twilioMessagingGetMock.mockImplementation((_creds: unknown, path: string) => {
      if (path.startsWith('/Services?')) {
        return Promise.resolve(okJson({ services: [{ sid: 'MG1', use_inbound_webhook_on_number: true }], meta: {} }));
      }
      return Promise.resolve(okJson({ phone_numbers: [{ sid: 'PN1' }], meta: {} }));
    });

    const result = await configureTwilioWebhooks('c1');

    expect(result.messagingServicesConfigured).toBe(1);
    expect(twilioMessagingFormMock).not.toHaveBeenCalled();
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
