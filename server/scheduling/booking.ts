import { db } from '../db';
import { contacts, scheduledBookings, userContractors, contractors } from '@shared/schema';
import { eq, and } from 'drizzle-orm';
import type { BookingRequest, BookingResult, SalespersonInfo } from '../types/scheduling';
import { parseAddressString, hasRealStreetAddress } from '../types/scheduling';
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
      const storedHasStreet = !!(stored.street)
        || hasRealStreetAddress(stored.address || '');
      const requestHasStreet = request.customerAddressComponents?.street
        ? true
        : request.customerAddress
          ? hasRealStreetAddress(request.customerAddress)
          : false;

      if (!storedHasStreet || requestHasStreet) {
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
      } else {
        log.info(`[scheduling] Skipping address writeback for contact ${request.contactId}: existing address is more complete than submitted`);
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
        resolved.serviceAddressId
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
