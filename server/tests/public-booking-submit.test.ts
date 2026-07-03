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
  logInfoSpy,
  storageMock,
} = vi.hoisted(() => ({
  broadcastSpy: vi.fn(),
  bookAppointmentMock: vi.fn(),
  markContactScheduledMock: vi.fn().mockResolvedValue(undefined),
  createActivityMock: vi.fn().mockResolvedValue(undefined),
  logConsentMock: vi.fn().mockResolvedValue(undefined),
  logInfoSpy: vi.fn(),
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

vi.mock('../utils/logger', () => ({
  logger: () => ({
    info: (...args: unknown[]) => logInfoSpy(...args),
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
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
const placesResolveAddressComponentsMock = vi.fn();
vi.mock('../utils/places-client', () => ({
  placesAutocomplete: vi.fn(),
  placesDetails: vi.fn(),
  placesResolveAddressComponents: (...args: unknown[]) =>
    placesResolveAddressComponentsMock(...args),
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
  // Default: no Places fallback resolution (preserves prior test
  // expectations — those bodies all carry full `123 Maple St, Springfield,
  // IL 62701` strings that the parser can already split).
  placesResolveAddressComponentsMock.mockResolvedValue(undefined);
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
    bookAppointmentMock.mockResolvedValueOnce({
      success: true,
      bookingId: 'booking-1',
      housecallProEventId: 'hcp-est-42',
      assignedSalespersonId: 'sp-7',
    });
    const app = makeApp();
    const r = await postBook(app, { ...baseBody, bookingCode: 'short-code-xyz' });
    expect(r.status).toBe(200);
    expect(r.body.booking.contactId).toBe('existing-1');
    expect(storageMock.createContact).not.toHaveBeenCalled();
    expect(bookAppointmentMock).toHaveBeenCalledTimes(1);
    expect(bookAppointmentMock.mock.calls[0][1].contactId).toBe('existing-1');

    // Task #792 structured outcome log — pin the full payload shape so
    // production telemetry consumers (matchedVia / createdNewLead /
    // estimatePath / hcpEstimateId / assignedSalespersonId) stay stable.
    const submitLog = logInfoSpy.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('[PublicBooking] submit'),
    );
    expect(submitLog).toBeDefined();
    expect(submitLog?.[1]).toMatchObject({
      matchedVia: 'token',
      hadBookingCode: true,
      createdNewContact: false,
      createdNewLead: false,
      contactId: 'existing-1',
      bookingId: 'booking-1',
      hcpEstimateId: 'hcp-est-42',
      estimatePath: 'hcp',
      assignedSalespersonId: 'sp-7',
    });
  });

  it('(a2) valid token for contact A + submitted identifiers of contact B still books against A', async () => {
    // Token authority: the bookingCode resolves to contact-A. The submitted
    // email+phone happen to match a DIFFERENT stored contact (contact-B).
    // The booking MUST attach to contact-A; the submitted identifiers are
    // never allowed to redirect the booking to contact-B, and no new
    // contact is created.
    storageMock.getContactByBookingCode.mockResolvedValue({
      id: 'contact-A',
      name: 'Reema Saeed',
      address: '123 Maple St, Springfield, IL 62701',
      street: '123 Maple St',
    });
    // If consulted (it should not be when a token is present), this would
    // point at contact-B — proving via the assertions below that the
    // email+phone fallback path never runs.
    storageMock.findMatchingContact.mockResolvedValue('contact-B');
    storageMock.getContact.mockResolvedValue({
      id: 'contact-B',
      name: 'Someone Else',
      emails: ['reema@example.com'],
      phones: ['+1 (555) 111-2222'],
    });
    const app = makeApp();
    const r = await postBook(app, { ...baseBody, bookingCode: 'short-code-xyz' });
    expect(r.status).toBe(200);
    expect(r.body.booking.contactId).toBe('contact-A');
    expect(storageMock.createContact).not.toHaveBeenCalled();
    expect(storageMock.findMatchingContact).not.toHaveBeenCalled();
    expect(storageMock.getContact).not.toHaveBeenCalled();
    expect(bookAppointmentMock.mock.calls[0][1].contactId).toBe('contact-A');
  });

  it('(b) no token + both email AND phone match the same stored contact still creates a fresh contact (task #887)', async () => {
    // Task #887: email+phone are not proof of ownership on this unauthenticated
    // public route. Even when both submitted identifiers match a stored
    // contact, without a valid bookingCode token the request MUST create a
    // fresh contact rather than reuse/mutate the existing CRM record.
    storageMock.findMatchingContact.mockResolvedValue('existing-1');
    storageMock.getContactByBookingCode.mockResolvedValue(undefined);
    storageMock.getContact.mockResolvedValue({
      id: 'existing-1',
      name: 'Reema Saeed',
      emails: ['reema@example.com'],
      phones: ['+1 (555) 111-2222'],
      address: '123 Maple St, Springfield, IL 62701',
      street: '123 Maple St',
    });
    storageMock.createContact.mockResolvedValue({ id: 'new-1', name: 'Reema Saeed' });
    const app = makeApp();
    const r = await postBook(app, { ...baseBody });
    expect(r.status).toBe(200);
    expect(r.body.booking.contactId).toBe('new-1');
    expect(storageMock.createContact).toHaveBeenCalledTimes(1);
    expect(storageMock.updateContact).not.toHaveBeenCalled();
    expect(bookAppointmentMock.mock.calls[0][1].contactId).toBe('new-1');
  });

  it('(c) no link + ONLY email matches (phone does not) still creates a fresh contact (security guardrail)', async () => {
    // Single-identifier match must NOT reuse the contact — that would let an
    // attacker who knows just the email attach bookings/status changes to a
    // victim's record. Stored contact has a different phone than submitted.
    storageMock.findMatchingContact.mockResolvedValue('existing-1');
    storageMock.getContactByBookingCode.mockResolvedValue(undefined);
    storageMock.getContact.mockResolvedValue({
      id: 'existing-1',
      name: 'Reema Saeed',
      emails: ['reema@example.com'],
      phones: ['+1 (555) 999-0000'], // different phone
      address: '123 Maple St, Springfield, IL 62701',
      street: '123 Maple St',
    });
    storageMock.createContact.mockResolvedValue({ id: 'new-2', name: 'Reema Saeed' });
    const app = makeApp();
    const r = await postBook(app, { ...baseBody });
    expect(r.status).toBe(200);
    expect(r.body.booking.contactId).toBe('new-2');
    expect(storageMock.createContact).toHaveBeenCalledTimes(1);
    expect(storageMock.getContactByBookingCode).not.toHaveBeenCalled();
  });

  it('(c2) no link + matched contact has no overlap on either identifier still creates a fresh contact', async () => {
    // findMatchingContact returns an id (e.g. a fuzzy hit) but the fetched
    // contact has neither the submitted email nor the submitted phone —
    // never reuse.
    storageMock.findMatchingContact.mockResolvedValue('existing-1');
    storageMock.getContact.mockResolvedValue({
      id: 'existing-1',
      name: 'Someone Else',
      emails: ['other@example.com'],
      phones: ['+1 (555) 999-0000'],
    });
    storageMock.createContact.mockResolvedValue({ id: 'new-3', name: 'Reema Saeed' });
    const app = makeApp();
    const r = await postBook(app, { ...baseBody });
    expect(r.status).toBe(200);
    expect(r.body.booking.contactId).toBe('new-3');
    expect(storageMock.createContact).toHaveBeenCalledTimes(1);
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

describe('POST /api/public/book/:slug — activity attribution (Task #698)', () => {
  it('logs the meeting activity with no userId so getActorLabel falls back to "Online Booking"', async () => {
    // The auto-assigned salesperson did NOT actually do the scheduling — the
    // customer self-scheduled — so the meeting activity must NOT be attributed
    // to them as the actor. The frontend's getActorLabel uses externalSource
    // = 'public_booking' to render "Online Booking" only when no userName is
    // present, which only happens when userId is left blank here.
    storageMock.findMatchingContact.mockResolvedValue('existing-actor');
    storageMock.getContactByBookingCode.mockResolvedValue({
      id: 'existing-actor',
      name: 'Reema Saeed',
      address: '123 Maple St, Springfield, IL 62701',
      street: '123 Maple St',
    });
    bookAppointmentMock.mockResolvedValue({
      success: true,
      bookingId: 'booking-actor',
      assignedSalespersonId: 'salesperson-7',
      assignedSalespersonName: 'Pat Salesperson',
    });

    const app = makeApp();
    const r = await postBook(app, { ...baseBody, bookingCode: 'short-code-xyz' });
    expect(r.status).toBe(200);

    expect(createActivityMock).toHaveBeenCalledTimes(1);
    const [contractorArg, activityArg] = createActivityMock.mock.calls[0];
    expect(contractorArg).toBe(TENANT_ID);
    expect(activityArg.type).toBe('meeting');
    expect(activityArg.contactId).toBe('existing-actor');
    // The fix: no actor attribution — userId must be unset/undefined.
    expect(activityArg.userId).toBeUndefined();
    // Source still drives the "Online Booking" label on the frontend.
    expect(activityArg.externalSource).toBe('public_booking');
    // The assigned-salesperson hint is still preserved via metadata so the
    // activity row can render "Assigned to Pat Salesperson" alongside the
    // "Online Booking" actor label.
    expect(activityArg.metadata).toEqual({
      assignedSalespersonId: 'salesperson-7',
      assignedSalespersonName: 'Pat Salesperson',
    });
  });

  it('defensive markContactScheduled fallback also tags external_source = public_booking so it renders as "Online Booking"', async () => {
    // The post-booking defensive call to markContactScheduled is normally a
    // no-op (bookAppointment already wrote the status_change row), but if a
    // future refactor moves the source-of-truth, this fallback must still
    // attribute the activity correctly. Without externalSource the row would
    // fall through getActorLabel to "System" instead of "Online Booking".
    storageMock.findMatchingContact.mockResolvedValue('existing-fallback');
    storageMock.getContactByBookingCode.mockResolvedValue({
      id: 'existing-fallback',
      name: 'Reema Saeed',
      address: '123 Maple St, Springfield, IL 62701',
      street: '123 Maple St',
    });
    bookAppointmentMock.mockResolvedValue({
      success: true,
      bookingId: 'booking-fallback',
      assignedSalespersonId: 'salesperson-11',
      assignedSalespersonName: 'Pat Salesperson',
    });

    const app = makeApp();
    const r = await postBook(app, { ...baseBody, bookingCode: 'short-code-xyz' });
    expect(r.status).toBe(200);

    expect(markContactScheduledMock).toHaveBeenCalledTimes(1);
    const [contactArg, tenantArg, opts] = markContactScheduledMock.mock.calls[0];
    expect(contactArg).toBe('existing-fallback');
    expect(tenantArg).toBe(TENANT_ID);
    expect(opts.source).toBe('public_booking');
    expect(opts.activityExternalSource).toBe('public_booking');
  });

  it('forwards scheduleSource = public_booking to bookAppointment so the booking row + status_change activity are tagged correctly', async () => {
    storageMock.findMatchingContact.mockResolvedValue('existing-src');
    storageMock.getContactByBookingCode.mockResolvedValue({
      id: 'existing-src',
      name: 'Reema Saeed',
      address: '123 Maple St, Springfield, IL 62701',
      street: '123 Maple St',
    });
    bookAppointmentMock.mockResolvedValue({
      success: true,
      bookingId: 'booking-src',
      assignedSalespersonId: 'salesperson-9',
      assignedSalespersonName: 'Sam Salesperson',
    });

    const app = makeApp();
    const r = await postBook(app, { ...baseBody, bookingCode: 'short-code-xyz' });
    expect(r.status).toBe(200);

    expect(bookAppointmentMock).toHaveBeenCalledTimes(1);
    const [, schedulingArgs] = bookAppointmentMock.mock.calls[0];
    // scheduleSource is the trigger that makes booking.ts:
    //   - persist scheduled_bookings.source = 'public_booking' (so the
    //     Self-Scheduled vs Sales-Scheduled report counts it correctly)
    //   - leave activityUserId unset on the status_change activity
    expect(schedulingArgs.scheduleSource).toBe('public_booking');
    // The raw payload preserves the booker-supplied source so the
    // schema-drift backfill can recover historical rows by inspecting
    // booking_payload->>'source'.
    expect(schedulingArgs.bookingPayload?.source).toBe('public_booking');
  });
});

describe('POST /api/public/book/:slug — submitted address propagation (Task #690)', () => {
  it('(e) verified caller with NEW typed address overwrites contact fields and forwards new address to scheduling', async () => {
    // Existing contact has the OLD address; the caller (verified via
    // bookingCode) submits a NEW typed address. The submitted address must
    // win — both in the contact write-back and in the scheduling payload.
    const OLD_ADDR = '123 Maple St, Springfield, IL 62701';
    const NEW_ADDR = '987 Oak Ave, Shelbyville, IL 62565';

    storageMock.findMatchingContact.mockResolvedValue('existing-6');
    storageMock.getContactByBookingCode.mockResolvedValue({
      id: 'existing-6',
      name: 'Reema Saeed',
      address: OLD_ADDR,
      street: '123 Maple St',
      city: 'Springfield',
      state: 'IL',
      zip: '62701',
    });

    const app = makeApp();
    const r = await postBook(app, {
      ...baseBody,
      address: NEW_ADDR,
      bookingCode: 'short-code-xyz',
    });

    expect(r.status).toBe(200);
    expect(r.body.booking.contactId).toBe('existing-6');

    // 1. The contact was updated with the NEW typed address (canonical text +
    //    parsed components) — no longer gated by the old hasRealStreetAddress
    //    check.
    expect(storageMock.updateContact).toHaveBeenCalledTimes(1);
    const [updateContactId, updatedFields, updateTenantId] =
      storageMock.updateContact.mock.calls[0];
    expect(updateContactId).toBe('existing-6');
    expect(updateTenantId).toBe(TENANT_ID);
    expect(updatedFields.address).toBe(NEW_ADDR);
    expect(updatedFields.street).toBe('987 Oak Ave');
    expect(updatedFields.city).toBe('Shelbyville');
    expect(updatedFields.state).toBe('IL');
    expect(updatedFields.zip).toBe('62565');
    // Never overwrite identity fields on a verified-reuse path.
    expect(updatedFields.name).toBeUndefined();
    expect(updatedFields.emails).toBeUndefined();
    expect(updatedFields.phones).toBeUndefined();

    // 2. The scheduling call carries the NEW typed address as the canonical
    //    customerAddress so downstream HCP customer + estimate sync sees the
    //    new street, not the old one.
    expect(bookAppointmentMock).toHaveBeenCalledTimes(1);
    const [, schedulingArgs] = bookAppointmentMock.mock.calls[0];
    expect(schedulingArgs.contactId).toBe('existing-6');
    expect(schedulingArgs.customerAddress).toBe(NEW_ADDR);
  });
});

describe('POST /api/public/book/:slug — server-side Places auto-resolve fallback', () => {
  it('(f) submission without components triggers placesResolveAddressComponents and enriches the scheduling payload', async () => {
    // Caller posts a typed address but no `customerAddressComponents` —
    // server fallback must canonicalize and forward to scheduling.
    placesResolveAddressComponentsMock.mockResolvedValue({
      street: '987 Oak Avenue',
      city: 'Shelbyville',
      state: 'IL',
      zip: '62565',
      country: 'US',
    });
    storageMock.findMatchingContact.mockResolvedValue('existing-7');
    storageMock.getContactByBookingCode.mockResolvedValue({
      id: 'existing-7',
      name: 'Reema Saeed',
      address: '123 Maple St, Springfield, IL 62701',
      street: '123 Maple St',
    });

    const app = makeApp();
    const r = await postBook(app, {
      ...baseBody,
      address: '987 Oak Ave Shelbyville', // partial — no zip
      bookingCode: 'short-code-xyz',
      // explicitly NO customerAddressComponents
    });

    expect(r.status).toBe(200);
    expect(placesResolveAddressComponentsMock).toHaveBeenCalledTimes(1);
    expect(placesResolveAddressComponentsMock).toHaveBeenCalledWith('987 Oak Ave Shelbyville');

    // Resolved components are forwarded to the scheduling layer.
    expect(bookAppointmentMock).toHaveBeenCalledTimes(1);
    const [, schedulingArgs] = bookAppointmentMock.mock.calls[0];
    expect(schedulingArgs.customerAddressComponents).toEqual({
      street: '987 Oak Avenue',
      city: 'Shelbyville',
      state: 'IL',
      zip: '62565',
      country: 'US',
    });

    // And used to overwrite the verified contact's structured fields rather
    // than running the partial address through the loose string parser.
    expect(storageMock.updateContact).toHaveBeenCalledTimes(1);
    const [, updatedFields] = storageMock.updateContact.mock.calls[0];
    expect(updatedFields.street).toBe('987 Oak Avenue');
    expect(updatedFields.city).toBe('Shelbyville');
    expect(updatedFields.state).toBe('IL');
    expect(updatedFields.zip).toBe('62565');
  });

  it('(f2) submission with PARTIAL components (street only, no city/state/zip) still triggers the Places fallback', async () => {
    // Synthetic partial components (street only) must NOT be treated as
    // authoritative — the fallback must run and replace them.
    placesResolveAddressComponentsMock.mockResolvedValue({
      street: '987 Oak Avenue',
      city: 'Shelbyville',
      state: 'IL',
      zip: '62565',
      country: 'US',
    });
    storageMock.findMatchingContact.mockResolvedValue('existing-7p');
    storageMock.getContactByBookingCode.mockResolvedValue({
      id: 'existing-7p',
      name: 'Reema Saeed',
      address: '123 Maple St, Springfield, IL 62701',
      street: '123 Maple St',
    });

    const app = makeApp();
    const r = await postBook(app, {
      ...baseBody,
      address: '987 Oak Ave Shelbyville',
      bookingCode: 'short-code-xyz',
      // Synthetic partial set — what the client emits on details failure.
      customerAddressComponents: {
        street: '987 Oak Ave Shelbyville',
        city: '',
        state: '',
        zip: '',
        country: 'US',
      },
    });

    expect(r.status).toBe(200);
    expect(placesResolveAddressComponentsMock).toHaveBeenCalledTimes(1);

    // The fully-resolved components — not the partial input — reach scheduling.
    const [, schedulingArgs] = bookAppointmentMock.mock.calls[0];
    expect(schedulingArgs.customerAddressComponents).toEqual({
      street: '987 Oak Avenue',
      city: 'Shelbyville',
      state: 'IL',
      zip: '62565',
      country: 'US',
    });
  });

  it('(g) submission WITH complete client-supplied components skips the Places fallback', async () => {
    // When the client already auto-resolved, we must not waste a Places
    // call on the server.
    storageMock.findMatchingContact.mockResolvedValue('existing-8');
    storageMock.getContactByBookingCode.mockResolvedValue({
      id: 'existing-8',
      name: 'Reema Saeed',
      address: '123 Maple St, Springfield, IL 62701',
      street: '123 Maple St',
    });

    const app = makeApp();
    const r = await postBook(app, {
      ...baseBody,
      bookingCode: 'short-code-xyz',
      customerAddressComponents: {
        street: '987 Oak Ave',
        city: 'Shelbyville',
        state: 'IL',
        zip: '62565',
        country: 'US',
      },
    });

    expect(r.status).toBe(200);
    expect(placesResolveAddressComponentsMock).not.toHaveBeenCalled();

    // The client-supplied components are what reach scheduling.
    const [, schedulingArgs] = bookAppointmentMock.mock.calls[0];
    expect(schedulingArgs.customerAddressComponents.street).toBe('987 Oak Ave');
  });

  it('(h) Places fallback failure is non-fatal — booking still proceeds with parsed components', async () => {
    // If Google Places is down or returns nothing, the booking must still
    // go through; the existing best-effort string parser handles it.
    placesResolveAddressComponentsMock.mockResolvedValue(undefined);
    storageMock.findMatchingContact.mockResolvedValue('existing-9');
    storageMock.getContactByBookingCode.mockResolvedValue({
      id: 'existing-9',
      name: 'Reema Saeed',
      address: '123 Maple St, Springfield, IL 62701',
      street: '123 Maple St',
    });

    const app = makeApp();
    const r = await postBook(app, {
      ...baseBody,
      bookingCode: 'short-code-xyz',
    });

    expect(r.status).toBe(200);
    expect(placesResolveAddressComponentsMock).toHaveBeenCalledTimes(1);
    // No structured components reach scheduling (the body had none and the
    // fallback resolved to undefined). resolveAddressComponents inside the
    // scheduling layer will then run its own parser path.
    const [, schedulingArgs] = bookAppointmentMock.mock.calls[0];
    expect(schedulingArgs.customerAddressComponents).toBeUndefined();
  });
});
