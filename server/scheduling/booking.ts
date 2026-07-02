import { db } from '../db';
import { contacts, scheduledBookings, userContractors, contractors } from '@shared/schema';
import { eq, and } from 'drizzle-orm';
import type { BookingRequest, BookingResult, SalespersonInfo } from '../types/scheduling';
import { parseAddressString } from '../types/scheduling';
import { logger } from '../utils/logger';
import { getSalespeople } from './queries';
import { selectNextAvailableSalesperson, getAvailabilityForDate, getAppointmentSettings } from './availability';
import { invalidateAndRecompute, utcToLocalDateStr } from '../services/availability-cache';
import { resolveHcpCustomer } from './hcp-customer';
import { createOrConvertHcpEstimate } from './hcp-estimate';
import { createCrmEstimate } from './crm-estimate';
import { markContactScheduled } from '../services/contact-status';
import { createActivityAndBroadcast } from '../utils/activity';
import { storage } from '../storage';
import { placesResolveAddressComponents } from '../utils/places-client';
import { users } from '@shared/schema';
import { googleCalendarService, GoogleCalendarAuthError } from '../google-calendar-service';

const log = logger('HcpSchedulingService');

export async function bookAppointment(tenantId: string, request: BookingRequest): Promise<BookingResult> {
  // If components are missing or partial, try to canonicalize via Places
  // before we hand off to HCP. Non-fatal — falls through to the parser
  // inside resolveAddressComponents.
  const componentsComplete = !!(
    request.customerAddressComponents?.street &&
    request.customerAddressComponents?.city &&
    request.customerAddressComponents?.state &&
    request.customerAddressComponents?.zip
  );
  if (!componentsComplete && request.customerAddress) {
    try {
      const resolved = await placesResolveAddressComponents(request.customerAddress);
      if (resolved) {
        log.info(`[scheduling] Server-side Places fallback resolved components for "${request.customerAddress}" → street="${resolved.street}", city="${resolved.city}", state="${resolved.state}", zip="${resolved.zip}"`);
        request = { ...request, customerAddressComponents: resolved };
      }
    } catch (err) {
      log.warn(`[scheduling] Server-side Places resolve threw for "${request.customerAddress}" (non-fatal):`, err instanceof Error ? err.message : err);
    }
  }

  let selectedSalesperson: SalespersonInfo | null = null;

  if (request.salespersonId) {
    const salespeople = await getSalespeople(tenantId);
    selectedSalesperson = salespeople.find(sp => sp.userId === request.salespersonId) || null;
    if (selectedSalesperson && request.housecallProEmployeeId) {
      selectedSalesperson.housecallProUserId = request.housecallProEmployeeId;
    }
  } else {
    const timezone = request.timezone || 'America/New_York';
    selectedSalesperson = await selectNextAvailableSalesperson(tenantId, request.startTime, timezone);
  }

  if (!selectedSalesperson) {
    return { success: false, error: 'No available salespeople for the requested time slot' };
  }

  const { durationMinutes } = await getAppointmentSettings(tenantId);
  const endTime = new Date(request.startTime.getTime() + durationMinutes * 60 * 1000);

  // Write a real event to the salesperson's Google Calendar when they've
  // connected it (task #858). This is additive and independent of HCP: a
  // salesperson may use Google Calendar, HCP, or both — provider selection is
  // per-user, driven by what each rep has connected, so HCP behavior is
  // unchanged for reps who don't use Google Calendar.
  //
  // This runs FIRST — before any HCP/CRM estimate, contact-status change, or
  // activity write — precisely because booking writes must fail loudly. If the
  // calendar write fails (e.g. a revoked/expired token) we throw here, before
  // any irreversible local or external side effect has occurred, so a failed
  // booking never leaves an orphaned HCP estimate or a contact flipped to
  // "scheduled" with no corresponding calendar event.
  let googleCalendarEventId: string | undefined;
  if (selectedSalesperson.googleCalendarConnected && selectedSalesperson.googleCalendarRefreshToken) {
    const eventTimezone = request.timezone
      || await (async () => {
        const [cRow] = await db.select({ timezone: contractors.timezone })
          .from(contractors)
          .where(eq(contractors.id, tenantId))
          .limit(1);
        return cRow?.timezone || 'America/New_York';
      })();
    const descriptionParts = [
      request.customerName ? `Customer: ${request.customerName}` : null,
      request.customerPhone ? `Phone: ${request.customerPhone}` : null,
      request.customerEmail ? `Email: ${request.customerEmail}` : null,
      request.notes ? `\nNotes:\n${request.notes}` : null,
    ].filter(Boolean) as string[];
    try {
      googleCalendarEventId = await googleCalendarService.createEvent(
        selectedSalesperson.googleCalendarRefreshToken,
        {
          summary: request.title,
          description: descriptionParts.join('\n') || undefined,
          location: request.customerAddress || undefined,
          startTime: request.startTime,
          endTime,
          timezone: eventTimezone,
          attendees: request.customerEmail ? [request.customerEmail] : undefined,
        },
      );
      log.info(`[scheduling] Created Google Calendar event ${googleCalendarEventId} for salesperson ${selectedSalesperson.name}`);
    } catch (err) {
      if (err instanceof GoogleCalendarAuthError) {
        // Token revoked/expired — mark the user disconnected so the UI prompts
        // a reconnect, then fail loudly.
        try {
          await db.update(users)
            .set({ googleCalendarConnected: false })
            .where(eq(users.id, selectedSalesperson.userId));
        } catch (updateErr) {
          log.error('[scheduling] Failed to flag Google Calendar as disconnected:', updateErr);
        }
        throw new Error(`${selectedSalesperson.name}'s Google Calendar connection has expired. Please reconnect Google Calendar in Settings and try again.`);
      }
      log.error('[scheduling] Failed to create Google Calendar event:', err);
      throw new Error('Failed to create the event in Google Calendar. Please try again.');
    }
  }

  let hcpEstimateId: string | undefined;
  let scheduleError: string | undefined;

  // Fetch stored contact address fields before HCP sync (used for estimate and writeback).
  let storedContactAddress: {
    address?: string | null;
    street?: string | null;
    city?: string | null;
    state?: string | null;
    zip?: string | null;
  } | undefined;

  if (request.contactId) {
    const [contactRow] = await db.select({
      address: contacts.address,
      street: contacts.street,
      city: contacts.city,
      state: contacts.state,
      zip: contacts.zip,
    })
      .from(contacts)
      .where(eq(contacts.id, request.contactId))
      .limit(1);
    storedContactAddress = contactRow;
  }

  if (request.contactId && storedContactAddress !== undefined) {
    const requestOnlyAddress = request.customerAddressComponents?.street
      ? {
          street: request.customerAddressComponents.street,
          city: request.customerAddressComponents.city || '',
          state: request.customerAddressComponents.state || '',
          zip: request.customerAddressComponents.zip || '',
        }
      : request.customerAddress
        ? parseAddressString(request.customerAddress)
        : undefined;

    if (requestOnlyAddress) {
      const stored = storedContactAddress;
      // The internal booker is staff-authenticated; the public path only
      // reaches `bookAppointment` after `callerOwnsContact` was verified
      // upstream. In both cases, treat any non-empty submitted address as
      // authoritative — the user just typed it for THIS booking and we should
      // never silently substitute the prior stored address. (Public-path
      // unverified submissions never share a contact id with an existing
      // record, so they don't reach this writeback at all.)
      const submittedAddressNonEmpty = !!(
        request.customerAddressComponents?.street
        || (request.customerAddress && request.customerAddress.trim().length > 0)
      );

      if (submittedAddressNonEmpty) {
        const addressUpdate: Record<string, string> = {};
        if (requestOnlyAddress.street && requestOnlyAddress.street !== (stored.street ?? '')) {
          addressUpdate.street = requestOnlyAddress.street;
        }
        if (requestOnlyAddress.city && requestOnlyAddress.city !== (stored.city ?? '')) {
          addressUpdate.city = requestOnlyAddress.city;
        }
        if (requestOnlyAddress.state && requestOnlyAddress.state !== (stored.state ?? '')) {
          addressUpdate.state = requestOnlyAddress.state;
        }
        if (requestOnlyAddress.zip && requestOnlyAddress.zip !== (stored.zip ?? '')) {
          addressUpdate.zip = requestOnlyAddress.zip;
        }
        const canonicalAddress = request.customerAddress
          || [requestOnlyAddress.street, requestOnlyAddress.city, requestOnlyAddress.state, requestOnlyAddress.zip]
              .filter(Boolean).join(', ');
        if (canonicalAddress && canonicalAddress !== (stored.address ?? '')) {
          addressUpdate.address = canonicalAddress;
        }
        if (Object.keys(addressUpdate).length > 0) {
          log.info(`[scheduling] Writing address fields to contact ${request.contactId} BEFORE HCP sync:`, addressUpdate);
          await db.update(contacts)
            .set(addressUpdate)
            .where(eq(contacts.id, request.contactId));
          Object.assign(storedContactAddress, addressUpdate);
        }
      }
    }
  }

  if (selectedSalesperson.housecallProUserId && request.contactId) {
    const resolved = await resolveHcpCustomer(tenantId, request.contactId, request);
    if (resolved?.customerId) {
      const hcpResult = await createOrConvertHcpEstimate(
        tenantId,
        resolved.customerId,
        selectedSalesperson,
        request,
        endTime,
        storedContactAddress?.address,
        storedContactAddress,
        resolved.serviceAddressId,
        resolved.serviceAddressRecreated ?? false,
      );
      if (hcpResult) {
        hcpEstimateId = hcpResult.hcpEstimateId;
        scheduleError = hcpResult.scheduleError;
      } else {
        throw new Error('Failed to create estimate in HousecallPro. Please check the HCP integration and try again.');
      }
    } else {
      throw new Error('Failed to find or create the customer in HousecallPro. Please check the HCP integration and try again.');
    }
  }

  let crmEstimateId: string | undefined;
  if (request.contactId) {
    crmEstimateId = await createCrmEstimate(tenantId, request.contactId, selectedSalesperson, request, endTime, hcpEstimateId);
  }

  // Surface the customer's booking note in the CRM activity feed and lead
  // Notes panel. Writing this AFTER createCrmEstimate (and unconditionally —
  // independent of HCP push success/failure) means the note always lands in
  // the CRM even when `addEstimateNote` retries to HCP fail. Linking to both
  // contactId and the local crmEstimateId keeps the row visible in the lead
  // activity timeline AND on the estimate's own detail page.
  //
  // Dedup is double-guarded:
  //   1. A deterministic `externalId` of `booking-note-<contactId>-<startMs>`
  //      makes the activities table's `(contractorId, externalSource,
  //      externalId)` unique partial index reject duplicate rows on retry.
  //   2. A pre-insert lookup avoids hitting the unique-violation on the
  //      common case (cleaner logs + lets us log the skip).
  if (request.contactId) {
    const customerNoteText = (request.notes || '').trim();
    if (customerNoteText.length > 0) {
      const customerOriginated = request.scheduleSource === 'public_booking'
        || request.scheduleSource === 'ai_agent';
      const prefix = customerOriginated ? 'Booking note from customer' : 'Booking note';
      const noteContent = `${prefix}:\n${customerNoteText}`;
      const externalSource = request.scheduleSource === 'public_booking'
        ? 'public_booking'
        : request.scheduleSource === 'ai_agent'
          ? 'ai_agent'
          : 'in_app_booking';
      const externalId = `booking-note-${request.contactId}-${request.startTime.getTime()}`;

      try {
        const existing = await storage.getActivities(tenantId, {
          contactId: request.contactId,
          type: 'note',
          limit: 100,
        });
        const alreadyWritten = existing.some(
          (a) => a.externalSource === externalSource && a.externalId === externalId,
        );
        if (alreadyWritten) {
          log.info(`[scheduling] Skipping duplicate booker-note activity for contact ${request.contactId} (externalId=${externalId})`);
        } else {
          await createActivityAndBroadcast(
            tenantId,
            {
              type: 'note',
              contactId: request.contactId,
              estimateId: crmEstimateId,
              content: noteContent,
              externalSource,
              externalId,
            },
            { type: 'activity_created', contactId: request.contactId },
          );
          log.info(`[scheduling] Wrote booker-note activity for contact ${request.contactId} (estimate=${crmEstimateId ?? '<none>'}, source=${externalSource})`);
        }
      } catch (err) {
        log.warn(`[scheduling] Failed to write booker-note activity (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // Centralized "mark this contact as scheduled" — flips status, fires the workflow
  // trigger exactly once, writes the activity log. Idempotent if the HCP webhook later
  // arrives and hits the same code path.
  const customerOriginated = request.scheduleSource === 'public_booking'
    || request.scheduleSource === 'ai_agent';
  const activityExternalSource = request.scheduleSource === 'public_booking'
    ? 'public_booking'
    : request.scheduleSource === 'ai_agent'
      ? 'ai_agent'
      : undefined;
  if (request.contactId) {
    try {
      await markContactScheduled(request.contactId, tenantId, {
        source: request.scheduleSource ?? 'in_app_booking',
        scheduledByUserId: selectedSalesperson.userId,
        // Customer-originated bookings (public widget, AI agent) — the
        // auto-assigned salesperson is the assignee, not the actor. Leave
        // activityUserId unset so the frontend's getActorLabel falls through
        // to the externalSource branch ("Online Booking" / "AI Scheduling
        // Agent") instead of crediting the salesperson. For in-app bookings,
        // attribute the status_change row to the rep who scheduled it.
        activityUserId: customerOriginated ? undefined : selectedSalesperson.userId,
        activityExternalSource,
      });
    } catch (err) {
      log.error('[scheduling] markContactScheduled failed (non-fatal):', err);
    }
  }

  const persistedSource = request.scheduleSource ?? 'in_app_booking';
  const [booking] = await db.insert(scheduledBookings).values({
    contractorId: tenantId,
    assignedSalespersonId: selectedSalesperson.userId,
    contactId: request.contactId,
    housecallProEventId: hcpEstimateId,
    googleCalendarEventId,
    title: request.title,
    startTime: request.startTime,
    endTime,
    customerName: request.customerName,
    customerEmail: request.customerEmail,
    customerPhone: request.customerPhone,
    notes: request.notes,
    status: 'confirmed',
    // Persist the booking origin so the Reports → Leads → Self-Scheduled vs
    // Sales-Scheduled report can split totals without joining the activity
    // log on every request (task #694). Defaults to 'in_app_booking' to match
    // the column default for any caller that omits scheduleSource.
    source: persistedSource,
    bookingPayload: request.bookingPayload ?? null,
  }).returning();

  // Surface any drift between the source the caller passed and the source we
  // actually persisted (or what the raw payload claims). The
  // scheduled_bookings.source column drives the Self-Scheduled vs
  // Sales-Scheduled report, so a silent mismatch quietly skews that chart —
  // the symptom we hit in task #698 with at least one public booking being
  // counted as in-app. Logging here makes future drift visible without
  // requiring a manual DB query.
  const payloadSource = typeof request.bookingPayload?.source === 'string'
    ? (request.bookingPayload.source as string)
    : null;
  log.info(
    `[scheduling] Inserted scheduled_booking ${booking.id} contractor=${tenantId} contact=${request.contactId ?? 'null'} source=${persistedSource} scheduleSource=${request.scheduleSource ?? 'unset'} payloadSource=${payloadSource ?? 'unset'}`,
  );
  if (payloadSource && payloadSource !== persistedSource) {
    log.warn(
      `[scheduling] scheduled_booking ${booking.id} source drift: persisted=${persistedSource} but bookingPayload.source=${payloadSource}`,
    );
  }

  await db.update(userContractors)
    .set({ lastAssignmentAt: new Date() })
    .where(and(
      eq(userContractors.userId, selectedSalesperson.userId),
      eq(userContractors.contractorId, tenantId)
    ));


  // Invalidate and immediately recompute the availability cache for the booked date.
  const timezone = request.timezone || await (async () => {
    const [cRow] = await db.select({ timezone: contractors.timezone })
      .from(contractors)
      .where(eq(contractors.id, tenantId))
      .limit(1);
    return cRow?.timezone || 'America/New_York';
  })();
  const bookedDateStr = utcToLocalDateStr(request.startTime, timezone);
  invalidateAndRecompute(tenantId, timezone, getAvailabilityForDate, [bookedDateStr]);

  return {
    success: true,
    bookingId: booking.id,
    assignedSalespersonId: selectedSalesperson.userId,
    assignedSalespersonName: selectedSalesperson.name,
    housecallProEventId: hcpEstimateId,
    googleCalendarEventId,
    scheduleError,
  };
}

/**
 * Cancel a scheduled booking by its ID.
 * Updates the local status to 'cancelled' and invalidates + recomputes the
 * availability cache for the affected date so freed slots are immediately
 * visible to other customers.
 *
 * Returns true when the booking was found and cancelled, false otherwise.
 */
export async function cancelBooking(tenantId: string, bookingId: string): Promise<boolean> {
  const [existing] = await db.select({
    id: scheduledBookings.id,
    startTime: scheduledBookings.startTime,
    contractorId: scheduledBookings.contractorId,
  })
    .from(scheduledBookings)
    .where(and(
      eq(scheduledBookings.id, bookingId),
      eq(scheduledBookings.contractorId, tenantId)
    ))
    .limit(1);

  if (!existing) return false;

  await db.update(scheduledBookings)
    .set({ status: 'cancelled' as const })
    .where(eq(scheduledBookings.id, bookingId));

  const [cRow] = await db.select({ timezone: contractors.timezone })
    .from(contractors)
    .where(eq(contractors.id, tenantId))
    .limit(1);
  const timezone = cRow?.timezone || 'America/New_York';

  const cancelledDateStr = utcToLocalDateStr(existing.startTime, timezone);
  log.info(`[scheduling] Cancelled booking ${bookingId} — invalidating cache for date ${cancelledDateStr}`);
  invalidateAndRecompute(tenantId, timezone, getAvailabilityForDate, [cancelledDateStr]);

  return true;
}
