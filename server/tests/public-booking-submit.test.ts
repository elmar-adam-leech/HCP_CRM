/**
 * Public booker submit endpoint — duplicate-contact and orphan-rollback tests.
 *
 * Covers Task #639:
 *   (a) short-code link reuses the existing matched contact
 *   (b) legacy `?contactId=<uuid>` link also reuses the existing matched contact
 *   (c) no link at all + matching email/phone still creates a fresh contact
 *       (security guardrail preserved)
 *   (d) booking failure after fresh-contact creation rolls back the orphan
 *       contact and broadcasts contact_deleted
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { type Express } from 'express';

const {
  broadcastSpy,
  bookAppointmentMock,
  markContactScheduledMock,
  createActivityMock,
  logConsentMock,
  storageMock,
} = vi.hoisted(() => ({
  broadcastSpy: vi.fn(),
  bookAppointmentMock: vi.fn(),
  markContactScheduledMock: vi.fn().mockResolvedValue(undefined),
  createActivityMock: vi.fn().mockResolvedValue(undefined),
  logConsentMock: vi.fn().mockResolvedValue(undefined),
  storageMock: {
    getContractorBySlug: vi.fn(),
    getContact: vi.fn(),
    getContactByBookingCode: vi.fn(),
    findMatchingContact: vi.fn(),
    createContact: vi.fn(),
    updateContact: vi.fn(),
    deleteContact: vi.fn(),
  },
}));

vi.mock('../websocket', () => ({
  broadcastToContractor: (...args: unknown[]) => broadcastSpy(...args),
}));

vi.mock('../middleware/rate-limiter', () => ({
  publicBookingRateLimiter: (_req: any, _res: any, next: any) => next(),
  publicBookingSubmitRateLimiter: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('../housecall-scheduling-service', () => ({
  housecallSchedulingService: {
    bookAppointment: (...args: unknown[]) => bookAppointmentMock(...args),
  },
}));

vi.mock('../services/availability-cache', () => ({
  warmAvailabilityCache: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../scheduling/availability', () => ({
  getAvailabilityForDate: vi.fn(),
}));
vi.mock('../utils/consent-log', () => ({
  logConsent: (...args: unknown[]) => logConsentMock(...args),
  hashIp: () => 'hashed-ip',
}));
vi.mock('../utils/places-client', () => ({
  placesAutocomplete: vi.fn(),
  placesDetails: vi.fn(),
}));
vi.mock('../utils/activity', () => ({
  createActivityAndBroadcast: (...args: unknown[]) => createActivityMock(...args),
}));
vi.mock('../services/contact-status', () => ({
  markContactScheduled: (...args: unknown[]) => markContactScheduledMock(...args),
}));

vi.mock('../storage', () => ({ storage: storageMock }));

import { registerPublicRoutes } from '../routes/public';

const TENANT_ID = 'tenant-001';
const SLUG = 'acme-co';

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  registerPublicRoutes(app);
  return app;
}

async function postBook(app: Express, body: Record<string, unknown>) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req: any = {
      method: 'POST',
      url: `/api/public/book/${SLUG}`,
      body,
      headers: { 'content-type': 'application/json' },
      query: {},
      params: { slug: SLUG },
      ip: '127.0.0.1',
      get: () => undefined,
    };
    const res: any = {
      statusCode: 200,
      headers: {} as Record<string, string>,
      setHeader(k: string, v: string) { this.headers[k] = v; },
      getHeader(k: string) { return this.headers[k]; },
      removeHeader(k: string) { delete this.headers[k]; },
      status(c: number) { this.statusCode = c; return this; },
      json(payload: any) { resolve({ status: this.statusCode, body: payload }); return this; },
      send(payload: any) { resolve({ status: this.statusCode, body: payload }); return this; },
      end() { resolve({ status: this.statusCode, body: undefined }); },
    };
    const stack: any[] = (app as any)._router.stack;
    const matchPath = `/api/public/book/:slug`;
    for (const layer of stack) {
      if (
        layer.route &&
        layer.route.path === matchPath &&
        layer.route.methods.post
      ) {
        const handlers = layer.route.stack.map((s: any) => s.handle);
        let h = 0;
        const next = (err?: any) => {
          if (err) return reject(err);
          const fn = handlers[h++];
          if (!fn) return;
          try { Promise.resolve(fn(req, res, next)).catch(reject); } catch (e) { reject(e); }
        };
        next();
        return;
      }
    }
    resolve({ status: 404, body: { error: 'no route' } });
  });
}

const FUTURE_TIME = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

const baseBody = {
  name: 'Reema Saeed',
  email: 'reema@example.com',
  phone: '555-111-2222',
  address: '123 Maple St, Springfield, IL 62701',
  startTime: FUTURE_TIME,
  notes: 'Hello',
  source: 'public_booking',
  timeZone: 'America/New_York',
};

beforeEach(() => {
  vi.clearAllMocks();
  storageMock.getContractorBySlug.mockResolvedValue({
    id: TENANT_ID,
    slug: SLUG,
    timezone: 'America/New_York',
  });
  bookAppointmentMock.mockResolvedValue({ success: true, bookingId: 'booking-1' });
  storageMock.updateContact.mockResolvedValue({ id: 'existing-1' });
});

describe('POST /api/public/book/:slug — duplicate-contact prevention', () => {
  it('(a) short-code link reuses the existing matched contact (no new contact)', async () => {
    storageMock.findMatchingContact.mockResolvedValue('existing-1');
    storageMock.getContactByBookingCode.mockResolvedValue({
      id: 'existing-1',
      name: 'Reema Saeed',
      address: '123 Maple St, Springfield, IL 62701',
      street: '123 Maple St',
    });
    const app = makeApp();
    const r = await postBook(app, { ...baseBody, bookingCode: 'short-code-xyz' });
    expect(r.status).toBe(200);
    expect(r.body.booking.contactId).toBe('existing-1');
    expect(storageMock.createContact).not.toHaveBeenCalled();
    expect(bookAppointmentMock).toHaveBeenCalledTimes(1);
    expect(bookAppointmentMock.mock.calls[0][1].contactId).toBe('existing-1');
  });

  it('(b) legacy ?contactId=<uuid> link reuses the existing matched contact', async () => {
    storageMock.findMatchingContact.mockResolvedValue('existing-1');
    // No bookingCode lookup hits — legacy path is via getContact(uuid).
    storageMock.getContactByBookingCode.mockResolvedValue(undefined);
    storageMock.getContact.mockResolvedValue({
      id: 'existing-1',
      name: 'Reema Saeed',
      address: '123 Maple St, Springfield, IL 62701',
      street: '123 Maple St',
    });
    const app = makeApp();
    const r = await postBook(app, { ...baseBody, contactId: 'existing-1' });
    expect(r.status).toBe(200);
    expect(r.body.booking.contactId).toBe('existing-1');
    expect(storageMock.createContact).not.toHaveBeenCalled();
    expect(storageMock.getContact).toHaveBeenCalledWith('existing-1', TENANT_ID);
    expect(bookAppointmentMock.mock.calls[0][1].contactId).toBe('existing-1');
  });

  it('(c) no link + matching email/phone still creates a fresh contact (security guardrail)', async () => {
    storageMock.findMatchingContact.mockResolvedValue('existing-1');
    storageMock.createContact.mockResolvedValue({ id: 'new-2', name: 'Reema Saeed' });
    const app = makeApp();
    const r = await postBook(app, { ...baseBody });
    expect(r.status).toBe(200);
    expect(r.body.booking.contactId).toBe('new-2');
    expect(storageMock.createContact).toHaveBeenCalledTimes(1);
    expect(storageMock.getContactByBookingCode).not.toHaveBeenCalled();
    expect(storageMock.getContact).not.toHaveBeenCalled();
  });

  it('(d) booking failure after fresh-contact creation rolls back the orphan contact', async () => {
    storageMock.findMatchingContact.mockResolvedValue(null);
    storageMock.createContact.mockResolvedValue({ id: 'orphan-3', name: 'Reema Saeed' });
    storageMock.deleteContact.mockResolvedValue(true);
    bookAppointmentMock.mockResolvedValue({ success: false, error: 'HCP scheduling unavailable' });
    const app = makeApp();
    const r = await postBook(app, { ...baseBody });
    expect(r.status).toBe(400);
    expect(storageMock.createContact).toHaveBeenCalledTimes(1);
    expect(storageMock.deleteContact).toHaveBeenCalledWith('orphan-3', TENANT_ID);
    // contact_deleted broadcast went out so any open CRM clients drop the orphan from view.
    const deletedBroadcast = broadcastSpy.mock.calls.find(
      ([_tid, msg]: any[]) => msg && msg.type === 'contact_deleted',
    );
    expect(deletedBroadcast).toBeTruthy();
    expect(deletedBroadcast![1].contactId).toBe('orphan-3');
  });

  it('(d2) booking thrown error after fresh-contact creation also rolls back the orphan', async () => {
    storageMock.findMatchingContact.mockResolvedValue(null);
    storageMock.createContact.mockResolvedValue({ id: 'orphan-4', name: 'Reema Saeed' });
    storageMock.deleteContact.mockResolvedValue(true);
    bookAppointmentMock.mockRejectedValue(new Error('HCP returned HTML error page'));
    const app = makeApp();
    const r = await postBook(app, { ...baseBody });
    expect(r.status).toBe(502);
    expect(storageMock.deleteContact).toHaveBeenCalledWith('orphan-4', TENANT_ID);
  });

  it('(d3) booking failure does NOT delete a reused (existing) contact', async () => {
    storageMock.findMatchingContact.mockResolvedValue('existing-5');
    storageMock.getContactByBookingCode.mockResolvedValue({
      id: 'existing-5',
      name: 'Reema Saeed',
      address: '123 Maple St, Springfield, IL 62701',
      street: '123 Maple St',
    });
    bookAppointmentMock.mockResolvedValue({ success: false, error: 'HCP scheduling unavailable' });
    const app = makeApp();
    const r = await postBook(app, { ...baseBody, bookingCode: 'short-code-xyz' });
    expect(r.status).toBe(400);
    expect(storageMock.deleteContact).not.toHaveBeenCalled();
  });
});
