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
import { parseAddressString, hasRealStreetAddress } from "../types/scheduling";
import { placesAutocomplete, placesDetails } from "../utils/places-client";
import { createActivityAndBroadcast } from "../utils/activity";
import { markContactScheduled } from "../services/contact-status";

const log = logger('PublicRoutes');

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
    const contactId = req.query.contactId as string | undefined;
    const bookingCode = req.query.c as string | undefined;

    if (!contactId && !bookingCode) {
      res.status(400).json({ message: "Missing contact identifier" });
      return;
    }

    // Find contractor by booking slug
    const contractor = await storage.getContractorBySlug(slug);
    if (!contractor) {
      res.status(404).json({ message: "Booking page not found" });
      return;
    }

    // Look up contact by short code (preferred) or legacy UUID
    let contact;
    if (bookingCode) {
      contact = await storage.getContactByBookingCode(bookingCode, contractor.id);
    } else if (contactId) {
      contact = await storage.getContact(contactId, contractor.id);
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
    const { name, email, phone, address, customerAddressComponents, startTime, notes, source, timeZone, bookingCode } = req.body;
    
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
    
    // Check for existing contact by email or phone.
    // IMPORTANT: An email or phone match alone does not prove the caller
    // controls that identity. An attacker who knows a victim's phone or email
    // could otherwise attach bookings and trigger status/workflow transitions
    // on the victim's CRM record, and redirect automated communications to
    // themselves by overwriting stored contact fields.
    //
    // We only reuse an existing contact when the request carries a signed
    // booking token (bookingCode) that resolves to the same contact — this
    // proves the caller was given a pre-populated booking link for that record.
    //
    // Without a verified token, we create a new contact from the submitted
    // data. This isolates the new booking from the existing record entirely:
    // no status transitions, no workflow events, and no field mutations are
    // applied to the pre-existing contact.
    const existingContactId = await storage.findMatchingContact(contractor.id, emails, phones);

    // Verify ownership via bookingCode when a matching contact is found.
    const tokenContact = (existingContactId && bookingCode)
      ? await storage.getContactByBookingCode(bookingCode as string, contractor.id)
      : null;
    const callerOwnsContact = tokenContact?.id === existingContactId;

    let contactId: string;
    if (existingContactId && callerOwnsContact) {
      // Caller holds a valid booking token for this exact contact.
      contactId = existingContactId;

      // Update address fields only when the submitted address is more
      // complete than what is already stored. Never overwrite name/emails/phones.
      const existingContact = tokenContact!;
      const parsed = parseAddressString(address);
      const submittedHasStreet = hasRealStreetAddress(address);
      const existingHasStreet = !!(existingContact.street)
        || hasRealStreetAddress(existingContact.address || '');

      const addressFields: {
        address?: string;
        street?: string;
        city?: string;
        state?: string;
        zip?: string;
      } = {};

      if (submittedHasStreet) {
        addressFields.address = address;
        addressFields.street = parsed.street;
        addressFields.city = parsed.city;
        addressFields.state = parsed.state;
        addressFields.zip = parsed.zip;
      } else if (!existingHasStreet) {
        addressFields.address = address;
        if (parsed.city) addressFields.city = parsed.city;
        if (parsed.state) addressFields.state = parsed.state;
        if (parsed.zip) addressFields.zip = parsed.zip;
      }

      if (Object.keys(addressFields).length > 0) {
        await storage.updateContact(existingContactId, { ...addressFields }, contractor.id);
        broadcastToContractor(contractor.id, { type: 'contact_updated', contactId: existingContactId });
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
      broadcastToContractor(contractor.id, { type: 'contact_created', contactId: newContact.id });
    }

    const result = await housecallSchedulingService.bookAppointment(contractor.id, {
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

    if (!result.success) {
      res.status(400).json({ message: result.error || "Failed to book appointment" });
      return;
    }

    // Defensive: also call the centralized helper here. If bookAppointment already
    // flipped the contact to scheduled (it does), this is an idempotent no-op for
    // the workflow trigger. If a future refactor changes the booking flow, the
    // public widget still guarantees the status flip + workflow dispatch.
    await markContactScheduled(contactId, contractor.id, {
      source: 'public_booking',
    }).catch(err => log.error('markContactScheduled (public booking) failed (non-fatal):', err));

    // Log booking to activity feed
    const tz = typeof timeZone === 'string' && timeZone ? timeZone : 'UTC';
    const tzOptions = { timeZone: tz };
    const formattedDate = appointmentStart.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', ...tzOptions });
    const formattedTime = appointmentStart.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, ...tzOptions })
      + (timeZone ? '' : ' UTC');
    createActivityAndBroadcast(
      contractor.id,
      {
        type: 'meeting',
        contactId,
        content: `Appointment booked for ${formattedDate} at ${formattedTime} — ${address}`,
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

    res.json({ 
      success: true,
      message: "Appointment booked successfully",
      booking: {
        id: result.bookingId,
        startTime: appointmentStart.toISOString(),
        contactId,
      }
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
