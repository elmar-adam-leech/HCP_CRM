import type { Express, Request, Response } from "express";
import { storage } from "../storage";
import { publicBookingRateLimiter, publicBookingSubmitRateLimiter } from "../middleware/rate-limiter";
import { broadcastToContractor } from "../websocket";
import { logger } from "../utils/logger";
import { asyncHandler } from "../utils/async-handler";
import { housecallSchedulingService } from "../housecall-scheduling-service";
import { warmAvailabilityCache } from "../services/availability-cache";
import { getAvailabilityForDate } from "../scheduling/availability";
import { logConsent, hashIp } from "../utils/consent-log";
import { parseAddressString } from "../types/scheduling";
import { placesAutocomplete, placesDetails, placesResolveAddressComponents } from "../utils/places-client";
import type { AddressComponents } from "../types/scheduling";
import { createActivityAndBroadcast } from "../utils/activity";
import { markContactScheduled } from "../services/contact-status";
import { sendEmail } from "../emails/client";
import { db } from "../db";
import { users, userContractors } from "@shared/schema";
import { eq, and, inArray } from "drizzle-orm";
import { BOOKER_NOTES_MISSING_TOKEN } from "../scheduling/hcp-estimate";

const log = logger('PublicRoutes');

interface MissingNotesEmailParams {
  contractorId: string;
  contractorName: string;
  customerName: string;
  customerEmail?: string;
  customerPhone?: string;
  hcpEstimateId: string;
  notes: string;
}

// Resolves admin/super-admin emails for a contractor (used to decide whether
// the "our team has been notified" warning copy is honest).
async function getContractorAdminEmails(contractorId: string): Promise<string[]> {
  const rows = await db
    .select({ email: users.email })
    .from(userContractors)
    .innerJoin(users, eq(users.id, userContractors.userId))
    .where(and(
      eq(userContractors.contractorId, contractorId),
      inArray(userContractors.role, ['admin', 'super_admin']),
    ));
  return rows.map((r) => r.email).filter((e): e is string => !!e);
}

// Emails admins when an HCP estimate was created but booker notes failed to
// attach. Caller pre-resolves recipients via getContractorAdminEmails.
async function sendMissingBookerNotesEmail(params: MissingNotesEmailParams & { recipients: string[] }): Promise<void> {
  if (params.recipients.length === 0) return;

  const esc = (s: string): string =>
    s.replace(/&/g, '&amp;')
     .replace(/</g, '&lt;')
     .replace(/>/g, '&gt;')
     .replace(/"/g, '&quot;')
     .replace(/'/g, '&#39;');
  const escMultiline = (s: string): string => esc(s).replace(/\n/g, '<br/>');

  const escapedNotes = escMultiline(params.notes);
  const escContractor = esc(params.contractorName);
  const escEstimateId = esc(params.hcpEstimateId);

  const subject = `Booking notes need to be added to HCP estimate ${params.hcpEstimateId}`;
  const customerLine = [
    esc(params.customerName),
    params.customerEmail ? `&lt;${esc(params.customerEmail)}&gt;` : null,
    params.customerPhone ? esc(params.customerPhone) : null,
  ].filter(Boolean).join(' · ');

  const html = `
    <p>A new public-booking appointment was created for <strong>${escContractor}</strong>, but the customer's typed notes could not be attached to the Housecall Pro estimate automatically.</p>
    <p><strong>Customer:</strong> ${customerLine || '(unknown)'}</p>
    <p><strong>HCP estimate:</strong> ${escEstimateId}</p>
    <p><strong>Notes the customer typed:</strong></p>
    <blockquote style="border-left:3px solid #ccc;padding-left:12px;color:#444;">${escapedNotes}</blockquote>
    <p>Please open the estimate in Housecall Pro and paste these notes into the Notes section so the assigned technician sees them.</p>
  `;

  await Promise.all(
    params.recipients.map((to) =>
      sendEmail({ to, subject, html }).catch((err) =>
        log.error(`[PublicBooking] failed to email ${to} about missing notes:`, err),
      ),
    ),
  );

  log.info(`[PublicBooking] Emailed ${params.recipients.length} admin(s) for contractor ${params.contractorId} about missing booker notes on estimate ${params.hcpEstimateId}`);
}

export function registerPublicRoutes(app: Express): void {
  app.get('/sitemap.xml', (_req, res) => {
    res.status(404).end();
  });

  app.get('/sw-unregister', (_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
          <title>Cache Clear</title>
          <meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate">
          <meta http-equiv="Pragma" content="no-cache">
          <meta http-equiv="Expires" content="0">
      </head>
      <body>
          <h1>Clearing Browser Cache...</h1>
          <p id="status">Unregistering service workers...</p>
          <script>
              async function clearCache() {
                  const status = document.getElementById('status');
                  
                  try {
                      // Unregister all service workers
                      if ('serviceWorker' in navigator) {
                          const registrations = await navigator.serviceWorker.getRegistrations();
                          for (const registration of registrations) {
                              await registration.unregister();
                              log.info('Unregistered service worker:', registration);
                          }
                          status.innerHTML += '<br>✅ Service workers unregistered';
                      }
                      
                      // Clear all caches
                      if ('caches' in window) {
                          const cacheNames = await caches.keys();
                          await Promise.all(
                              cacheNames.map(cacheName => caches.delete(cacheName))
                          );
                          status.innerHTML += '<br>✅ All caches cleared';
                      }
                      
                      // Clear localStorage and sessionStorage
                      if (typeof Storage !== 'undefined') {
                          localStorage.clear();
                          sessionStorage.clear();
                          status.innerHTML += '<br>✅ Storage cleared';
                      }
                      
                      status.innerHTML += '<br><br><strong>✅ Cache clearing complete!</strong>';
                      status.innerHTML += '<br><a href="/">Return to Application</a>';
                      status.innerHTML += '<br><br><em>Note: You may need to hard refresh (Ctrl+Shift+R) after returning to the app.</em>';
                      
                  } catch (error) {
                      log.error('Cache clearing failed:', error);
                      status.innerHTML += '<br>❌ Error: ' + error.message;
                  }
              }
              
              clearCache();
          </script>
      </body>
      </html>
    `);
  });

  // =============================================
  // Public Booking API Routes (no authentication required)
  // =============================================

  // Public Google Places proxy — no auth required (used by public booking page)
  app.get('/api/public/places/autocomplete', publicBookingRateLimiter, asyncHandler(async (req: Request, res: Response) => {
    const { input, sessionToken } = req.query as { input?: string; sessionToken?: string };
    if (!input || input.trim().length < 3) {
      res.json({ suggestions: [] });
      return;
    }
    const result = await placesAutocomplete(input, sessionToken);
    if (!result) {
      res.status(503).json({ error: 'Google Maps API key not configured' });
      return;
    }
    if (!result.ok) {
      res.status(502).json({ error: 'Places API error', details: result.data });
      return;
    }
    res.json({ suggestions: result.data.suggestions || [] });
  }));

  app.get('/api/public/places/details', publicBookingRateLimiter, asyncHandler(async (req: Request, res: Response) => {
    const { placeId, sessionToken } = req.query as { placeId?: string; sessionToken?: string };
    if (!placeId) {
      res.status(400).json({ error: 'placeId is required' });
      return;
    }
    const result = await placesDetails(placeId, sessionToken);
    if (!result) {
      res.status(503).json({ error: 'Google Maps API key not configured' });
      return;
    }
    if (!result.ok) {
      res.status(502).json({ error: 'Places API error', details: result.data });
      return;
    }
    res.json(result.data);
  }));

  // Get contractor info and available slots for public booking page
  app.get("/api/public/book/:slug", publicBookingRateLimiter, asyncHandler(async (req: Request, res: Response) => {
    const { slug } = req.params;
    
    // Find contractor by booking slug
    const contractor = await storage.getContractorBySlug(slug);
    if (!contractor) {
      res.status(404).json({ message: "Booking page not found" });
      return;
    }

    // Return public contractor info (name, slug, and redirect URL — no internal IDs)
    res.json({
      contractor: {
        name: contractor.name,
        bookingSlug: contractor.bookingSlug,
        bookingRedirectUrl: contractor.bookingRedirectUrl || null,
        logoUrl: contractor.logoUrl || null,
        brandColor: contractor.brandColor || null,
      }
    });
  }));

  // Get available time slots for public booking
  app.get("/api/public/book/:slug/availability", publicBookingRateLimiter, asyncHandler(async (req: Request, res: Response) => {
    const { slug } = req.params;
    const { startDate, endDate, date } = req.query;
    
    // Find contractor by booking slug
    const contractor = await storage.getContractorBySlug(slug);
    if (!contractor) {
      res.status(404).json({ message: "Booking page not found" });
      return;
    }

    const timezone = ('timezone' in contractor && typeof contractor.timezone === 'string' ? contractor.timezone : null) ?? 'America/New_York';

    let slots;
    if (date && typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
      // Single-day calendar-date query: generate slots for exactly that TZ day.
      // This avoids UTC-midnight boundary issues where "2026-03-24T00:00:00Z"
      // can map to March 23 in a negative-offset timezone.
      slots = await housecallSchedulingService.getAvailabilityForDate(contractor.id, date, timezone);
    } else {
      // Legacy range query (startDate/endDate as naive ISO strings)
      const start = startDate ? new Date(startDate as string) : new Date();
      const end = endDate ? new Date(endDate as string) : new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
      const now = new Date();
      if (start < now) {
        start.setTime(now.getTime());
      }
      // Clamp the requested range to a maximum of 30 days to prevent
      // unbounded CPU/memory consumption from arbitrarily large date spans.
      const MAX_RANGE_MS = 30 * 24 * 60 * 60 * 1000;
      if (end.getTime() - start.getTime() > MAX_RANGE_MS) {
        end.setTime(start.getTime() + MAX_RANGE_MS);
      }
      slots = await housecallSchedulingService.getUnifiedAvailability(contractor.id, start, end, timezone);
    }
    
    // Return slots without revealing salesperson details (for privacy)
    const publicSlots = slots.map(slot => ({
      start: slot.start.toISOString(),
      end: slot.end.toISOString(),
      available: slot.availableSalespersonIds.length > 0,
    }));

    res.json({ slots: publicSlots });
  }));

  // Warm the availability cache for the next N days for a given booking slug.
  // This is called by the frontend booking calendar on mount to pre-populate
  // the cache so subsequent date selections are instant.
  app.post("/api/public/book/:slug/warm-cache", publicBookingRateLimiter, asyncHandler(async (req: Request, res: Response) => {
    const { slug } = req.params;
    const days = Math.min(Math.max(parseInt(req.body?.days as string || '7', 10) || 7, 1), 30);

    const contractor = await storage.getContractorBySlug(slug);
    if (!contractor) {
      res.status(404).json({ message: "Booking page not found" });
      return;
    }

    const timezone = ('timezone' in contractor && typeof contractor.timezone === 'string' ? contractor.timezone : null) ?? 'America/New_York';

    res.json({ warming: true });

    setImmediate(() => {
      warmAvailabilityCache(
        contractor.id,
        timezone,
        getAvailabilityForDate,
        days
      ).catch(err => log.warn('[PublicRoutes] warm-cache background error:', err));
    });
  }));

  // Get contact info for prefilling public booking form
  app.get("/api/public/book/:slug/contact", publicBookingRateLimiter, asyncHandler(async (req: Request, res: Response) => {
    const { slug } = req.params;
    const bookingCode = req.query.c as string | undefined;

    if (!bookingCode) {
      res.status(400).json({ message: "Missing contact identifier" });
      return;
    }

    // Find contractor by booking slug
    const contractor = await storage.getContractorBySlug(slug);
    if (!contractor) {
      res.status(404).json({ message: "Booking page not found" });
      return;
    }

    // Look up contact by short booking code only — legacy raw UUID params are
    // no longer accepted because possession of an opaque UUID is not proof of
    // identity and such links never expire.
    let contact;
    if (bookingCode) {
      contact = await storage.getContactByBookingCode(bookingCode, contractor.id);
    }

    if (!contact) {
      res.status(404).json({ message: "Contact not found" });
      return;
    }

    res.json({
      prefill: {
        name: contact.name,
        email: contact.emails && contact.emails.length > 0 ? contact.emails[0] : '',
        phone: contact.phones && contact.phones.length > 0 ? contact.phones[0] : '',
        address: contact.address ?? '',
      }
    });
  }));

  // Create a booking from public page (stricter rate limit for submissions)
  app.post("/api/public/book/:slug", publicBookingSubmitRateLimiter, asyncHandler(async (req: Request, res: Response) => {
    const { slug } = req.params;
    const { name, email, phone, address, customerAddressComponents: rawSubmittedComponents, startTime, notes, source, timeZone, bookingCode } = req.body;
    let customerAddressComponents: AddressComponents | undefined =
      rawSubmittedComponents && typeof rawSubmittedComponents === 'object'
        ? (rawSubmittedComponents as AddressComponents)
        : undefined;
    
    // Find contractor by booking slug
    const contractor = await storage.getContractorBySlug(slug);
    if (!contractor) {
      res.status(404).json({ message: "Booking page not found" });
      return;
    }

    // Validate required fields
    if (!name || !startTime) {
      res.status(400).json({ message: "Name and appointment time are required" });
      return;
    }

    if (!email && !phone) {
      res.status(400).json({ message: "Email or phone number is required" });
      return;
    }

    if (!address || typeof address !== 'string' || address.trim().length < 5) {
      res.status(400).json({ message: "A valid address is required" });
      return;
    }

    // If components are missing or partial (e.g. street only), canonicalize
    // the typed address via Places so HCP receives a complete service
    // address. Failures fall through to the loose string parser.
    const componentsComplete = !!(
      customerAddressComponents?.street &&
      customerAddressComponents?.city &&
      customerAddressComponents?.state &&
      customerAddressComponents?.zip
    );
    if (!componentsComplete && address) {
      try {
        const resolved = await placesResolveAddressComponents(address);
        if (resolved) {
          log.info(`[PublicBooking] Server-side Places resolved components for typed address "${address}" → street="${resolved.street}", city="${resolved.city}", state="${resolved.state}", zip="${resolved.zip}" (had partial=${!!customerAddressComponents?.street})`);
          customerAddressComponents = resolved;
        }
      } catch (err) {
        log.warn(`[PublicBooking] Server-side Places resolve threw for "${address}" (non-fatal):`, err instanceof Error ? err.message : err);
      }
    }

    // Parse and validate start time
    const appointmentStart = new Date(startTime);
    if (isNaN(appointmentStart.getTime())) {
      res.status(400).json({ message: "Invalid appointment time" });
      return;
    }

    // Ensure appointment is in the future
    if (appointmentStart < new Date()) {
      res.status(400).json({ message: "Appointment time must be in the future" });
      return;
    }

    // Create or find existing contact
    const emails = email ? [email] : [];
    const phones = phone ? [phone] : [];
    
    // Contact resolution order (authoritative → fallback):
    //   1. Valid bookingCode token → reuse the token's contact regardless of
    //      submitted email/phone. Token possession proves the caller was
    //      given a pre-populated booking link for that exact record; the
    //      identifiers they typed into the form do not override that. This
    //      also means a request that carries a valid token for contact A but
    //      types email/phone for contact B still books against A — the
    //      submitted identifiers are NEVER allowed to redirect the booking
    //      to a different contact than the token holds.
    //   2. Anything else (no token, regardless of whether submitted email
    //      and/or phone happen to match a stored contact) → create a fresh
    //      contact so no status transitions, workflow side-effects, or field
    //      mutations are applied to any pre-existing CRM record.
    //
    // Task #887: the previous implementation also reused (and let the caller
    // mutate the address of) an existing contact when the submitted email AND
    // phone both matched a stored record, on the theory that both identifiers
    // together were "strong enough evidence of ownership". They are not —
    // email addresses and phone numbers are not secrets, and this let anyone
    // who knew a customer's contact details book against that customer's CRM
    // record and overwrite their saved address without ever holding the
    // private booking link. A valid `bookingCode` token is the only accepted
    // proof of ownership for reusing/mutating an existing contact; every other
    // case creates a brand-new contact, exactly like the no-match case always
    // did.
    let tokenContact: Awaited<ReturnType<typeof storage.getContactByBookingCode>> | null = null;
    if (bookingCode) {
      tokenContact = (await storage.getContactByBookingCode(bookingCode as string, contractor.id)) ?? null;
    }

    const reuseContactId: string | null = tokenContact ? tokenContact.id : null;
    const matchedVia: 'token' | 'none' = tokenContact ? 'token' : 'none';

    let contactId: string;
    let createdNewContact = false;
    if (reuseContactId) {
      // Caller either holds a valid booking token for this exact contact, or
      // both submitted identifiers (email AND phone) match the stored contact.
      contactId = reuseContactId;

      // The caller proved ownership of this contact via a valid booking
      // token, and they just typed a fresh address into the form for THIS
      // booking. Treat the submitted address as authoritative — overwrite the
      // contact's address fields with whatever can be parsed, even when the
      // strict `hasRealStreetAddress` heuristic rejects the string. The
      // conservative gate is still appropriate for unverified public
      // submissions (which never reach this branch — they fall through to
      // createContact below). Never overwrite name/emails/phones.
      if (address && address.trim().length > 0) {
        // Prefer resolved/client-supplied components over the loose parser.
        const parsed = customerAddressComponents?.street
          ? customerAddressComponents
          : parseAddressString(address);
        const addressFields: {
          address: string;
          street?: string;
          city?: string;
          state?: string;
          zip?: string;
        } = {
          address,
        };
        // Update components on a best-effort basis: leave existing values in
        // place rather than blanking out fields we couldn't recover.
        if (parsed.street) addressFields.street = parsed.street;
        if (parsed.city) addressFields.city = parsed.city;
        if (parsed.state) addressFields.state = parsed.state;
        if (parsed.zip) addressFields.zip = parsed.zip;

        await storage.updateContact(reuseContactId, { ...addressFields }, contractor.id);
        broadcastToContractor(contractor.id, { type: 'contact_updated', contactId: reuseContactId });
      }
    } else {
      // Either no match was found, or the match was found but the caller could
      // not prove ownership via a valid bookingCode. In both cases, create a
      // fresh contact so that no status transitions, workflow side-effects, or
      // field mutations are applied to any pre-existing CRM record.
      //
      // The status flip to "scheduled" is performed by markContactScheduled()
      // below so the contact_status_changed workflow trigger fires exactly once
      // via the centralized helper.
      const newContact = await storage.createContact({
        name,
        emails,
        phones,
        address,
        type: 'lead',
        source: source || 'public_booking',
      }, contractor.id);
      contactId = newContact.id;
      createdNewContact = true;
      broadcastToContractor(contractor.id, { type: 'contact_created', contactId: newContact.id });
    }

    let result: Awaited<ReturnType<typeof housecallSchedulingService.bookAppointment>>;
    try {
      result = await housecallSchedulingService.bookAppointment(contractor.id, {
        startTime: appointmentStart,
        title: `Estimate Appointment - ${name}`,
        customerName: name,
        customerEmail: email,
        customerPhone: phone,
        customerAddress: address,
        notes: notes || `Booked via public booking page`,
        contactId,
        customerAddressComponents: customerAddressComponents || undefined,
        bookingPayload: req.body as Record<string, unknown>,
        scheduleSource: 'public_booking',
      });
    } catch (err) {
      // Surface the underlying scheduling error so this kind of failure is
      // diagnosable from production logs (previously the log trail just
      // stopped mid-flight).
      log.error('[PublicBooking] bookAppointment threw:', {
        contractorId: contractor.id,
        contactId,
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      if (createdNewContact) {
        const deleted = await storage.deleteContact(contactId, contractor.id).catch(deleteErr => {
          log.error('[PublicBooking] Failed to roll back orphan contact after booking error:', deleteErr);
          return false;
        });
        if (deleted) {
          broadcastToContractor(contractor.id, { type: 'contact_deleted', contactId });
        }
      }
      res.status(502).json({ message: "Failed to book appointment" });
      return;
    }

    if (!result.success) {
      log.error('[PublicBooking] bookAppointment returned failure:', {
        contractorId: contractor.id,
        contactId,
        error: result.error,
      });
      if (createdNewContact) {
        const deleted = await storage.deleteContact(contactId, contractor.id).catch(deleteErr => {
          log.error('[PublicBooking] Failed to roll back orphan contact after booking failure:', deleteErr);
          return false;
        });
        if (deleted) {
          broadcastToContractor(contractor.id, { type: 'contact_deleted', contactId });
        }
      }
      res.status(400).json({ message: result.error || "Failed to book appointment" });
      return;
    }

    // Defensive: also call the centralized helper here. If bookAppointment already
    // flipped the contact to scheduled (it does), this is an idempotent no-op for
    // the workflow trigger. If a future refactor changes the booking flow, the
    // public widget still guarantees the status flip + workflow dispatch.
    //
    // Mirror the attribution rules used inside bookAppointment for the
    // public-booking case (task #698): the customer self-scheduled, so the
    // status_change activity has no actor and is tagged with
    // external_source = 'public_booking' so getActorLabel renders it as
    // "Online Booking" instead of "System" in this fallback path too.
    await markContactScheduled(contactId, contractor.id, {
      source: 'public_booking',
      activityExternalSource: 'public_booking',
    }).catch(err => log.error('markContactScheduled (public booking) failed (non-fatal):', err));

    // Log booking to activity feed
    const tz = typeof timeZone === 'string' && timeZone ? timeZone : 'UTC';
    const tzOptions = { timeZone: tz };
    const formattedDate = appointmentStart.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', ...tzOptions });
    const formattedTime = appointmentStart.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, ...tzOptions })
      + (timeZone ? '' : ' UTC');
    // Attach the assigned salesperson in metadata so the activity feed can
    // surface a secondary "Assigned to Pat" hint. The auto-assigned salesperson
    // did NOT actually do the scheduling — the customer self-scheduled through
    // the public booking link — so they are an assignee, not the actor. The
    // primary author is left unset and the externalSource below lets the
    // frontend render an "Online Booking" attribution (task #698).
    const publicBookingMetadata: Record<string, unknown> = {};
    if (result.assignedSalespersonId) publicBookingMetadata.assignedSalespersonId = result.assignedSalespersonId;
    if (result.assignedSalespersonName) publicBookingMetadata.assignedSalespersonName = result.assignedSalespersonName;
    createActivityAndBroadcast(
      contractor.id,
      {
        type: 'meeting',
        contactId,
        content: `Appointment booked for ${formattedDate} at ${formattedTime} — ${address}`,
        // Intentionally no userId: the customer self-scheduled, so the
        // assigned salesperson is the assignee (rendered via the metadata
        // hint), not the actor. externalSource drives the "Online Booking"
        // primary author label in ActivityList.getActorLabel.
        externalSource: 'public_booking',
        metadata: Object.keys(publicBookingMetadata).length > 0 ? publicBookingMetadata : undefined,
      },
      { type: 'activity_created', contactId }
    ).catch(err => log.error('Failed to log booking activity (non-fatal):', err));

    logConsent({
      contractorId: contractor.id,
      contactId,
      source: 'public_booking',
      optInType: 'implied',
      ipHash: hashIp(req.ip),
      metadata: { bookingSlug: slug, source: source || 'public_booking' },
    }).catch(err => log.error('Consent log error (non-fatal):', err));

    // Surface booker-notes failure to the booker + contractor admins.
    const customerNotesText = (notes || '').trim();
    const bookerNotesMissing =
      !!result.scheduleError &&
      customerNotesText.length > 0 &&
      result.scheduleError.includes(BOOKER_NOTES_MISSING_TOKEN);

    let warningPayload:
      | { kind: 'notes_not_attached'; message: string; notesEcho: string }
      | undefined;

    if (bookerNotesMissing && result.housecallProEventId) {
      const adminEmails = await getContractorAdminEmails(contractor.id).catch((err) => {
        log.error('[PublicBooking] failed to look up admin recipients (non-fatal):', err);
        return [] as string[];
      });

      if (adminEmails.length > 0) {
        sendMissingBookerNotesEmail({
          contractorId: contractor.id,
          contractorName: contractor.name,
          customerName: name,
          customerEmail: email,
          customerPhone: phone,
          hcpEstimateId: result.housecallProEventId,
          notes: customerNotesText,
          recipients: adminEmails,
        }).catch((err) => log.error('[PublicBooking] failed to email contractor about missing notes (non-fatal):', err));

        warningPayload = {
          kind: 'notes_not_attached',
          message: "Your booking is confirmed, but we couldn't attach your notes to your file automatically. Our team has been notified by email and will follow up.",
          notesEcho: customerNotesText,
        };
      } else {
        log.warn(`[PublicBooking] Booker notes failed for contractor ${contractor.id} estimate ${result.housecallProEventId}, but contractor has no admin users to notify.`);
        warningPayload = {
          kind: 'notes_not_attached',
          message: "Your booking is confirmed, but we couldn't attach your notes to your file automatically. Please share them with your technician when they arrive.",
          notesEcho: customerNotesText,
        };
      }
    }

    // Task #792 — structured outcome log so production can audit whether a
    // booking submission reused an existing contact (via token vs.
    // email+phone) or created a fresh one. `createdNewLead` is an alias for
    // `createdNewContact` because in the public booking flow a newly-created
    // contact IS the lead (contact.type = 'lead'); we surface both names so
    // log consumers don't have to know that. `estimatePath` records whether
    // the booking went through HCP (which internally picks convertLead →
    // createEstimate based on whether the contact already has an HCP lead
    // id; see server/scheduling/hcp-estimate.ts) or stayed CRM-only. The
    // exact HCP convertLead-vs-createEstimate choice is not exposed by
    // BookingResult, but `hcpEstimateId` proves the HCP path ran.
    log.info('[PublicBooking] submit', {
      contractorId: contractor.id,
      slug,
      matchedVia,
      hadBookingCode: !!bookingCode,
      createdNewContact,
      createdNewLead: createdNewContact,
      contactId,
      bookingId: result.bookingId,
      hcpEstimateId: result.housecallProEventId ?? null,
      estimatePath: result.housecallProEventId ? 'hcp' : 'crm-only',
      assignedSalespersonId: result.assignedSalespersonId ?? null,
    });

    res.json({
      success: true,
      message: "Appointment booked successfully",
      booking: {
        id: result.bookingId,
        startTime: appointmentStart.toISOString(),
        contactId,
      },
      warning: warningPayload,
    });
  }));


  // Version endpoint
  app.get('/api/version', (_req, res) => {
    const BUILD_VERSION = process.env.REPLIT_DEPLOYMENT_ID || process.env.REPL_ID || Date.now().toString();
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.json({ 
      version: BUILD_VERSION,
      timestamp: Date.now()
    });
  });
}
