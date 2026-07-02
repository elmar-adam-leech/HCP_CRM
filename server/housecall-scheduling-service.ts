import { syncHousecallUsers } from './scheduling/hcp-user-sync';
import { getSalespeople, getTeamMembers, getBookings } from './scheduling/queries';
import {
  getAvailabilityForDate,
  getUnifiedAvailability,
  getCalendarEvents,
  selectNextAvailableSalesperson,
} from './scheduling/availability';
import { bookAppointment, cancelBooking } from './scheduling/booking';
import type { TimeSlot, BusyWindow, AvailableSlot, AddressComponents, BookingRequest, BookingResult, SalespersonInfo } from './types/scheduling';

export type { TimeSlot, BusyWindow, AvailableSlot, AddressComponents, BookingRequest, BookingResult, SalespersonInfo };

/**
 * Thin facade that composes the scheduling sub-modules and exposes their
 * functions as prototype methods so that all existing callers continue to work
 * via `housecallSchedulingService.method(...)` without modification.
 *
 * Sub-module responsibilities:
 *   - hcp-user-sync  : HCPEmployee interface, syncHousecallUsers
 *   - queries        : getSalespeople, getTeamMembers, getBookings
 *   - availability   : getAvailabilityForDate, getUnifiedAvailability,
 *                      selectNextAvailableSalesperson
 *   - booking        : bookAppointment
 */
export class HousecallSchedulingService {
  syncHousecallUsers(tenantId: string) { return syncHousecallUsers(tenantId); }

  getSalespeople(tenantId: string) { return getSalespeople(tenantId); }
  getTeamMembers(tenantId: string) { return getTeamMembers(tenantId); }
  getBookings(tenantId: string, startDate?: Date, endDate?: Date) { return getBookings(tenantId, startDate, endDate); }

  getAvailabilityForDate(tenantId: string, dateStr: string, timezone?: string) {
    return getAvailabilityForDate(tenantId, dateStr, timezone);
  }
  getUnifiedAvailability(tenantId: string, startDate: Date, endDate: Date, timezone?: string) {
    return getUnifiedAvailability(tenantId, startDate, endDate, timezone);
  }
  getCalendarEvents(tenantId: string, startDate: Date, endDate: Date, salespersonId?: string) {
    return getCalendarEvents(tenantId, startDate, endDate, salespersonId);
  }
  selectNextAvailableSalesperson(tenantId: string, startTime: Date, timezone?: string) {
    return selectNextAvailableSalesperson(tenantId, startTime, timezone);
  }

  bookAppointment(tenantId: string, request: BookingRequest) { return bookAppointment(tenantId, request); }
  cancelBooking(tenantId: string, bookingId: string) { return cancelBooking(tenantId, bookingId); }
}

export const housecallSchedulingService = new HousecallSchedulingService();
