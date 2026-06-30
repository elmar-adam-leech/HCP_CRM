import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture the params handed to Twilio's /Calls.json so we can assert the
// generated bridge/status webhook URLs match the Express routes that actually
// handle them. Regression guard for task #838: the URLs were built with a
// `?contractorId=` query string while the routes expect the contractor id as a
// `/:tenantId` path param, so Twilio fetched the app's HTML catch-all instead
// of valid TwiML and every outbound call failed with an application error.
const twilioFormMock = vi.fn().mockResolvedValue({
  ok: true,
  status: 200,
  json: async () => ({ sid: 'CA-test-sid' }),
  text: async () => '',
});

vi.mock('../twilio/client', () => ({
  getTwilioCredentials: vi.fn().mockResolvedValue({ account_sid: 'AC', auth_token: 'tok' }),
  twilioForm: (...args: unknown[]) => twilioFormMock(...args),
  twilioGet: vi.fn(),
}));

vi.mock('../utils/public-base-url', () => ({
  getPublicBaseUrl: () => 'https://crm.example.com',
}));

vi.mock('../storage', () => ({
  storage: {
    getTwilioPhoneNumberByNumber: vi.fn().mockResolvedValue({ id: 'pn1' }),
    getUserContractor: vi.fn().mockResolvedValue({ twilioPhoneToRing: '+15551112222' }),
    getContractor: vi.fn().mockResolvedValue({
      defaultTwilioNumber: '+15553334444',
      twilioRecordCalls: false,
    }),
  },
}));

import { TwilioCallProvider } from './twilio-provider';

// Mirror the Express route definitions in server/routes/webhooks/twilio.ts.
// path-to-regexp turns `/:tenantId` into a single non-slash path segment.
const BRIDGE_ROUTE = /^\/api\/webhooks\/twilio\/voice\/bridge\/([^/]+)$/;
const STATUS_ROUTE = /^\/api\/webhooks\/twilio\/voice\/status\/([^/]+)$/;

describe('TwilioCallProvider.initiateCall webhook URL shape', () => {
  beforeEach(() => {
    twilioFormMock.mockClear();
  });

  it('generates bridge/status URLs that match the registered :tenantId routes', async () => {
    const provider = new TwilioCallProvider();
    const result = await provider.initiateCall({
      to: '5559876543',
      fromNumber: '+15553334444',
      contractorId: 'contractor-123',
      userId: 'user-1',
    });

    expect(result.success).toBe(true);
    expect(twilioFormMock).toHaveBeenCalledTimes(1);

    const [, endpoint, params] = twilioFormMock.mock.calls[0] as [
      unknown,
      string,
      Record<string, string>,
    ];
    expect(endpoint).toBe('/Calls.json');

    const bridge = new URL(params.Url);
    const status = new URL(params.StatusCallback);

    // Both webhook URLs must carry the contractor id as a path param so they
    // resolve to the real handlers instead of the HTML catch-all.
    const bridgeMatch = BRIDGE_ROUTE.exec(bridge.pathname);
    const statusMatch = STATUS_ROUTE.exec(status.pathname);
    expect(bridgeMatch?.[1]).toBe('contractor-123');
    expect(statusMatch?.[1]).toBe('contractor-123');

    // The contractor id must NOT also leak back in as a query param.
    expect(bridge.searchParams.get('contractorId')).toBeNull();
    expect(status.searchParams.get('contractorId')).toBeNull();

    // to/callerId/record stay as query params — the bridge handler reads them
    // from the query string.
    expect(bridge.searchParams.get('to')).toBe('+15559876543');
    expect(bridge.searchParams.get('callerId')).toBe('+15553334444');
    expect(bridge.searchParams.get('record')).toBe('0');
  });
});
