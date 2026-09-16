import { beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type Express } from 'express';

const mocks = vi.hoisted(() => ({
  ingestLead: vi.fn(),
  getContractor: vi.fn(),
  updateContact: vi.fn(),
  getCredential: vi.fn(),
}));

vi.mock('../../middleware/rate-limiter', () => ({
  webhookRateLimiter: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('../../services/lead-ingestion', () => ({
  ingestLead: mocks.ingestLead,
}));
vi.mock('../../storage', () => ({
  storage: {
    getContractor: mocks.getContractor,
    updateContact: mocks.updateContact,
  },
}));
vi.mock('../../credential-service', () => ({
  CredentialService: {
    getCredential: mocks.getCredential,
  },
}));
vi.mock('../../utils/public-base-url', () => ({
  getPublicBaseUrl: () => '',
}));

import { registerLeadWebhookRoutes } from './leads';

const tenantId = 'tenant-with-a-long-id-0000000000000000000000000000000000000001';
const apiKey = 'webhook-secret';

function makeResult() {
  return {
    contact: { id: 'contact-1', bookingCode: 'BOOK123' },
    lead: {
      id: 'lead-1',
      contactId: 'contact-1',
      status: 'new',
      source: 'External API',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    },
    isNewContact: true,
    skippedDuplicateLead: false,
  };
}

function makeApp(): Express {
  const app = express();
  registerLeadWebhookRoutes(app);
  return app;
}

async function call(
  app: Express,
  body: Record<string, unknown>,
  requestedTenantId = tenantId,
  requestApiKey?: string,
) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const path = `/api/webhooks/${encodeURIComponent(requestedTenantId)}/leads`;
    const headers: Record<string, string> = {
      host: 'localhost:5000',
      'user-agent': 'vitest',
    };
    if (requestApiKey !== undefined) headers['x-api-key'] = requestApiKey;

    const req: any = {
      method: 'POST',
      url: path,
      body,
      headers,
      protocol: 'http',
      query: {},
      params: { contractorId: requestedTenantId },
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
      get(name: string) {
        return this.headers[name.toLowerCase()];
      },
    };
    const res: any = {
      statusCode: 200,
      setHeader() {},
      getHeader() {},
      removeHeader() {},
      status(statusCode: number) {
        this.statusCode = statusCode;
        return this;
      },
      json(payload: any) {
        resolve({ status: this.statusCode, body: payload });
        return this;
      },
      send(payload: any) {
        resolve({ status: this.statusCode, body: payload });
        return this;
      },
      end() {
        resolve({ status: this.statusCode, body: null });
      },
    };

    const stack: any[] = (app as any)._router.stack;
    const routePath = '/api/webhooks/:contractorId/leads';
    const route = stack.find((layer) =>
      layer.route?.path === routePath
      && layer.route.methods.post,
    );
    if (!route) {
      reject(new Error(`Route not found: ${routePath}`));
      return;
    }

    const handlers = route.route.stack.map((layer: any) => layer.handle);
    let handlerIndex = 0;
    const next = (error?: unknown) => {
      if (error) {
        reject(error);
        return;
      }
      const handler = handlers[handlerIndex++];
      if (!handler) return;
      try {
        Promise.resolve(handler(req, res, next)).catch(reject);
      } catch (error) {
        reject(error);
      }
    };
    next();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getContractor.mockImplementation(async (requestedTenantId: string) => (
    requestedTenantId === tenantId
      ? { id: tenantId, name: 'Test Contractor', bookingSlug: null }
      : null
  ));
  mocks.getCredential.mockImplementation(async (requestedTenantId: string) => (
    requestedTenantId === tenantId ? apiKey : null
  ));
  mocks.updateContact.mockResolvedValue(undefined);
  mocks.ingestLead.mockResolvedValue(makeResult());
});

describe('POST /api/webhooks/:contractorId/leads intake mapping', () => {
  it('routes a long tenant ID and maps notes, UTMs, primary pageUrl, and string tags', async () => {
    const longCampaign = `campaign-${'x'.repeat(180)}`;
    const app = makeApp();
    const response = await call(app, {
      name: '  Jane Lead  ',
      email: 'jane@example.com',
      notes: '  Please call after 5  ',
      pageUrl: '  https://example.com/primary  ',
      pageURL: 'https://example.com/alias',
      utmSource: '  newsletter  ',
      utmMedium: ' email ',
      utmCampaign: ` ${longCampaign} `,
      utmTerm: ' spring ',
      utmContent: ' hero ',
      tags: ' VIP, VIP , Repeat, , vip ',
    }, tenantId, apiKey);

    expect(response.status).toBe(201);
    expect(mocks.getContractor).toHaveBeenCalledWith(tenantId);
    expect(mocks.getCredential).toHaveBeenCalledWith(tenantId, 'webhook', 'api_key');
    expect(mocks.ingestLead).toHaveBeenCalledTimes(1);
    expect(mocks.ingestLead.mock.calls[0][0]).toBe(tenantId);
    expect(mocks.ingestLead.mock.calls[0][1]).toMatchObject({
      name: 'Jane Lead',
      notes: 'Please call after 5',
      message: 'Please call after 5',
      pageUrl: 'https://example.com/primary',
      utmSource: 'newsletter',
      utmMedium: 'email',
      utmCampaign: longCampaign,
      utmTerm: 'spring',
      utmContent: 'hero',
      tags: ['VIP', 'Repeat', 'vip'],
    });
  });

  it('uses pageURL when pageUrl is blank and omits null or blank optional values', async () => {
    const app = makeApp();
    const response = await call(app, {
      name: 'Alias Lead',
      notes: null,
      pageUrl: '   ',
      pageURL: '  https://example.com/from-alias  ',
      utmSource: null,
      utmMedium: ' ',
      utmCampaign: undefined,
      utmTerm: null,
      utmContent: '',
      tags: ['  A ', 'A', '', 'a', ' A '],
    }, tenantId, apiKey);

    expect(response.status).toBe(201);
    expect(mocks.ingestLead.mock.calls[0][1]).toMatchObject({
      pageUrl: 'https://example.com/from-alias',
      tags: ['A', 'a'],
      notes: undefined,
      message: undefined,
      utmSource: undefined,
      utmMedium: undefined,
      utmCampaign: undefined,
      utmTerm: undefined,
      utmContent: undefined,
    });
  });

  it('trims submissionId before forwarding it to lead ingestion', async () => {
    const app = makeApp();
    const response = await call(app, {
      name: 'Submission Lead',
      submissionId: '  provider-submission-123  ',
    }, tenantId, apiKey);

    expect(response.status).toBe(201);
    expect(mocks.ingestLead.mock.calls[0][1]).toMatchObject({
      submissionId: 'provider-submission-123',
    });
  });

  it.each([
    ['pageUrl', { pageUrl: 123 }],
    ['pageURL', { pageURL: false }],
    ['submissionId', { submissionId: 123 }],
    ['utmSource', { utmSource: ['source'] }],
    ['utmMedium', { utmMedium: 42 }],
    ['utmCampaign', { utmCampaign: {} }],
    ['utmTerm', { utmTerm: true }],
    ['utmContent', { utmContent: ['content'] }],
    ['tags', { tags: 42 }],
  ])('rejects invalid %s types before ingestion', async (_field, invalidValue) => {
    const app = makeApp();
    const response = await call(app, {
      name: 'Invalid Lead',
      ...invalidValue,
    }, tenantId, apiKey);

    expect(response.status).toBe(400);
    expect(response.body.message).toContain('Validation failed');
    expect(response.body.details.join(' ')).toContain(`'${_field}'`);
    expect(mocks.ingestLead).not.toHaveBeenCalled();
  });

  it('rejects non-string values in a tags array with a clear error', async () => {
    const app = makeApp();
    const response = await call(app, {
      name: 'Invalid Tags Lead',
      tags: ['valid', 9],
    }, tenantId, apiKey);

    expect(response.status).toBe(400);
    expect(response.body.details.join(' ')).toContain("'tags' array must contain only strings");
    expect(mocks.ingestLead).not.toHaveBeenCalled();
  });
});

describe('POST /api/webhooks/:contractorId/leads authentication and tenant routing', () => {
  it('rejects a missing API key before ingestion', async () => {
    const app = makeApp();
    const response = await call(app, { name: 'Unauthenticated Lead' }, tenantId);

    expect(response.status).toBe(401);
    expect(response.body.error).toBe('Missing API key');
    expect(mocks.ingestLead).not.toHaveBeenCalled();
  });

  it('rejects an API key belonging to another tenant', async () => {
    const app = makeApp();
    const response = await call(app, { name: 'Wrong Tenant Key' }, tenantId, 'different-tenant-key');

    expect(response.status).toBe(401);
    expect(response.body.error).toBe('Invalid API key');
    expect(mocks.ingestLead).not.toHaveBeenCalled();
  });

  it('rejects an unknown tenant without invoking ingestion', async () => {
    const app = makeApp();
    const unknownTenantId = 'tenant-does-not-exist';
    const response = await call(app, { name: 'Unknown Tenant Lead' }, unknownTenantId, apiKey);

    expect(response.status).toBe(404);
    expect(response.body.error).toBe('Contractor not found');
    expect(mocks.ingestLead).not.toHaveBeenCalled();
  });
});