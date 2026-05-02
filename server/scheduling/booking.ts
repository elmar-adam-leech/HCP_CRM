import { db } from '../db';
import { contacts, scheduledBookings, userContractors, contractors } from '@shared/schema';
import { eq, and } from 'drizzle-orm';
import type { BookingRequest, BookingResult, SalespersonInfo } from '../types/scheduling';
import { parseAddressString } from '../types/scheduling';
import { logger } from '../utils/logger';
import { getSalespeople } from './queries';
import { selectNextAvailableSalesperson, getAvailabilityForDate } from './availability';
import { invalidateAndRecompute, utcToLocalDateStr } from '../services/availability-cache';
import { resolveHcpCustomer } from './hcp-customer';
import { createOrConvertHcpEstimate } from './hcp-estimate';
import { createCrmEstimate } from './crm-estimate';
import { markContactScheduled } from '../services/contact-status';

const log = logger('HcpSchedulingService');

const SLOT_DURATION_MINUTES = 60;

export async function bookAppointment(tenantId: string, request: BookingRequest): Promise<BookingResult> {
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

  const endTime = new Date(request.startTime.getTime() + SLOT_DURATION_MINUTES * 60 * 1000);

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

  if (request.contactId) {
    await createCrmEstimate(tenantId, request.contactId, selectedSalesperson, request, endTime, hcpEstimateId);
  }

  // Centralized "mark this contact as scheduled" — flips status, fires the workflow
  // trigger exactly once, writes the activity log. Idempotent if the HCP webhook later
  // arrives and hits the same code path.
  if (request.contactId) {
    try {
      await markContactScheduled(request.contactId, tenantId, {
        source: request.scheduleSource ?? 'in_app_booking',
        scheduledByUserId: selectedSalesperson.userId,
        // Attribute the "Status Changed" activity row to the selected salesperson
        // so the activity feed shows their name. For public bookings this is the
        // auto-assigned salesperson; for in-app bookings it is the rep the booker
        // chose. If selectedSalesperson is missing the userId field (defensive),
        // the frontend falls back to the externalSource label below.
        activityUserId: selectedSalesperson.userId,
        activityExternalSource:
          request.scheduleSource === 'public_booking' ? 'public_booking' : undefined,
      });
    } catch (err) {
      log.error('[scheduling] markContactScheduled failed (non-fatal):', err);
    }
  }

  const [booking] = await db.insert(scheduledBookings).values({
    contractorId: tenantId,
    assignedSalespersonId: selectedSalesperson.userId,
    contactId: request.contactId,
    housecallProEventId: hcpEstimateId,
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
    source: request.scheduleSource ?? 'in_app_booking',
    bookingPayload: request.bookingPayload ?? null,
  }).returning();

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
