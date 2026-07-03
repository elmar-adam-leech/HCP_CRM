import { logger } from '../utils/logger';
import { HcpBaseClient, extractHcpList } from './base-client';
import type { HousecallProEstimate, HousecallProJob, HousecallProResponse, HcpDispatchedEmployee, HcpEstimateRaw, HcpEstimateOption, HousecallProEvent, HcpPageEnvelope } from './types';
import { isHcpExcludedEstimateStatus } from '../sync/hcp-mappers';

const log = logger('HcpService');

export class HcpSchedulingModule extends HcpBaseClient {
  async getEstimatorAvailability(
    tenantId: string,
    date: string,
    estimatorIds?: string[]
  ): Promise<HousecallProResponse<{
    employee_id: string;
    employee_name: string;
    available_slots: Array<{
      start_time: string;
      end_time: string;
      duration_minutes: number;
    }>;
  }[]>> {
    try {
      const employeesResult = await this.getEmployeesForScheduling(tenantId);
      if (!employeesResult.success || !employeesResult.data) {
        return {
          success: false,
          error: employeesResult.error || 'Failed to fetch employees',
        };
      }

      const estimators = employeesResult.data.filter(emp => {
        const isEstimator = emp.role.toLowerCase().includes('estimator') || emp.role.toLowerCase().includes('sales');
        const isSpecific = !estimatorIds || estimatorIds.includes(emp.id);
        return emp.is_active && isEstimator && isSpecific;
      });

      const availability = [];

      for (const estimator of estimators) {
        const startOfDay = `${date}T00:00:00Z`;
        const endOfDay = `${date}T23:59:59Z`;
        
        const estimatesResult = await this.getEstimatesForScheduling(tenantId, {
          scheduled_start_min: startOfDay,
          scheduled_start_max: endOfDay,
          work_status: 'scheduled',
        });

        if (!estimatesResult.success) {
          continue;
        }

        const estimatorSchedule = (estimatesResult.data || []).filter((est: any) =>
          est.employee_id === estimator.id && est.scheduled_start && est.scheduled_end
        );

        const businessHours = {
          start: '08:00',
          end: '17:00',
        };

        const availableSlots = this.calculateAvailableSlots(
          businessHours,
          estimatorSchedule.map((est: any) => ({
            start: est.scheduled_start!,
            end: est.scheduled_end!,
          }))
        );

        availability.push({
          employee_id: estimator.id,
          employee_name: `${estimator.first_name} ${estimator.last_name}`,
          available_slots: availableSlots,
        });
      }

      return {
        success: true,
        data: availability,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get availability',
      };
    }
  }

  /**
   * Internal (staff-facing) flexible scheduling for the HCP modal (task #859).
   * Returns EVERY candidate start time across business hours at a fixed
   * interval for each estimator, flagging times that overlap an existing
   * scheduled estimate. Unlike getEstimatorAvailability (which returns only
   * free gaps), conflicting times are still returned so the UI can render an
   * inline "Booked" badge while keeping them selectable — intentional
   * double-booking is permitted internally. The public booking flow does not
   * use this method.
   */
  async getEstimatorTimeCandidates(
    tenantId: string,
    date: string,
    estimatorIds?: string[],
    timezone: string = 'America/New_York'
  ): Promise<HousecallProResponse<{
    employee_id: string;
    employee_name: string;
    slots: Array<{
      start_time: string;
      end_time: string;
      conflict: boolean;
    }>;
  }[]>> {
    try {
      const employeesResult = await this.getEmployeesForScheduling(tenantId);
      if (!employeesResult.success || !employeesResult.data) {
        return {
          success: false,
          error: employeesResult.error || 'Failed to fetch employees',
        };
      }

      const estimators = employeesResult.data.filter(emp => {
        const isEstimator = emp.role.toLowerCase().includes('estimator') || emp.role.toLowerCase().includes('sales');
        const isSpecific = !estimatorIds || estimatorIds.includes(emp.id);
        return emp.is_active && isEstimator && isSpecific;
      });

      const businessHours = { start: '08:00', end: '17:00' };
      const intervalMinutes = 30;
      const durationMinutes = 60;

      // Same-day handling (task #877): when the requested date is *today* in the
      // contractor's timezone, drop candidate slots whose start time has already
      // passed so staff aren't offered times in the past. `nowMinutes` is null
      // on any other day (all slots are offered).
      const { dateStr: todayStr, minutes: nowMinutes } = this.nowInTimezone(timezone);
      const minStartMinutes = date === todayStr ? nowMinutes : null;

      const availability = [];

      for (const estimator of estimators) {
        const startOfDay = `${date}T00:00:00Z`;
        const endOfDay = `${date}T23:59:59Z`;

        const estimatesResult = await this.getEstimatesForScheduling(tenantId, {
          scheduled_start_min: startOfDay,
          scheduled_start_max: endOfDay,
          work_status: 'scheduled',
        });

        const estimatorSchedule = estimatesResult.success
          ? (estimatesResult.data || []).filter((est: any) =>
              est.employee_id === estimator.id && est.scheduled_start && est.scheduled_end
            )
          : [];

        const busyWindows = estimatorSchedule.map((est: any) => ({
          start: this.isoToMinutes(est.scheduled_start!),
          end: this.isoToMinutes(est.scheduled_end!),
        }));

        const businessStart = this.timeToMinutes(businessHours.start);
        const businessEnd = this.timeToMinutes(businessHours.end);

        const slots: Array<{ start_time: string; end_time: string; conflict: boolean }> = [];
        for (let t = businessStart; t + durationMinutes <= businessEnd; t += intervalMinutes) {
          const slotStart = t;
          const slotEnd = t + durationMinutes;
          // Skip already-passed times when the requested day is today.
          if (minStartMinutes !== null && slotStart < minStartMinutes) {
            continue;
          }
          const conflict = busyWindows.some(w => slotStart < w.end && slotEnd > w.start);
          slots.push({
            start_time: this.minutesToTime(slotStart),
            end_time: this.minutesToTime(slotEnd),
            conflict,
          });
        }

        availability.push({
          employee_id: estimator.id,
          employee_name: `${estimator.first_name} ${estimator.last_name}`,
          slots,
        });
      }

      return {
        success: true,
        data: availability,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get availability',
      };
    }
  }

  async getEmployeeScheduledEstimates(
    tenantId: string,
    employeeId: string,
    startDate: Date,
    endDate: Date
  ): Promise<HousecallProResponse<HcpEstimateRaw[]>> {
    try {
      const params = new URLSearchParams();
      params.append('scheduled_start_min', startDate.toISOString());
      params.append('scheduled_start_max', endDate.toISOString());
      params.append('page_size', '100');
      params.append('sort_by', 'created_at');
      params.append('sort_direction', 'desc');
      
      const result = await this.makeRequest<unknown>(`/estimates?${params.toString()}`, tenantId, 'GET', undefined, 3, 'application/json');
      
      if (result.success && result.data) {
        const allEstimates: HcpEstimateRaw[] = extractHcpList<HcpEstimateRaw>(result.data, 'estimates');
        
        log.info(`[HCP] Fetched ${allEstimates.length} total estimates for date range`);
        
        // NOTE: The HCP /estimates endpoint does not support filtering by employee_id.
        // We fetch all estimates for the date range and filter in-memory here.
        // Do not add an employee_id API param — HCP will silently ignore it.
        const employeeEstimates = allEstimates.filter((est: HcpEstimateRaw) => {
          if (isHcpExcludedEstimateStatus(est.work_status) || isHcpExcludedEstimateStatus(est.status)) {
            return false;
          }
          // Also exclude when every option indicates a rejection-like state
          // (covers `pro declined` etc. that don't appear in top-level status).
          if (Array.isArray(est.options) && est.options.length > 0) {
            const allDeclined = est.options.every(o => isHcpExcludedEstimateStatus((o as { approval_status?: string }).approval_status));
            if (allDeclined) return false;
          }
          
          if (est.employee_id === employeeId || est.assigned_employee_id === employeeId) {
            return true;
          }
          
          if (est.options && Array.isArray(est.options)) {
            for (const opt of est.options) {
              if ((opt as HcpEstimateOption).schedule?.dispatched_employees?.some((emp: HcpDispatchedEmployee) => emp.id === employeeId)) {
                return true;
              }
              if ((opt as HcpEstimateOption).dispatched_employees?.some((emp: HcpDispatchedEmployee) => emp.id === employeeId)) {
                return true;
              }
            }
          }
          
          if (est.assigned_employees?.some((emp) => emp.id === employeeId)) {
            return true;
          }
          
          return false;
        });
        
        log.info(`[HCP] Found ${employeeEstimates.length} estimates for employee ${employeeId}`);
        return { success: true, data: employeeEstimates };
      }
      
      return { success: false, error: result.error || 'Failed to fetch estimates' };
    } catch (error: any) {
      log.error(`[HCP] Error fetching employee estimates:`, error);
      return { success: false, error: error.message };
    }
  }

  private resolveEventTime(evt: HousecallProEvent, field: 'start' | 'end'): string | undefined {
    if (field === 'start') {
      return evt.schedule?.start_time
        || evt.start_time
        || evt.starts_at
        || evt.start_at
        || evt.start as string | undefined
        || evt.scheduled_start;
    }
    return evt.schedule?.end_time
      || evt.end_time
      || evt.ends_at
      || evt.end_at
      || evt.end as string | undefined
      || evt.scheduled_end;
  }

  private eventAssignedToEmployee(evt: HousecallProEvent, employeeId: string): boolean {
    // HCP API docs confirm `assigned_employees`; also support `employees` as fallback
    const assignedList = evt.assigned_employees ?? evt.employees;
    if (!assignedList || !Array.isArray(assignedList) || assignedList.length === 0) {
      return false;
    }
    return assignedList.some((emp) => emp.id === employeeId);
  }

  async getEmployeeScheduledEvents(
    tenantId: string,
    employeeId: string,
    startDate: Date,
    endDate: Date
  ): Promise<HousecallProResponse<HousecallProEvent[]>> {
    try {
      // The HCP /events API does not support date-range or employee_id query filters.
      // Supported params: page, page_size, sort_by, sort_direction, location_ids only.
      // All filtering (date range + employee) is performed in-memory after fetching all pages.
      const pageSize = 100;
      let page = 1;
      let totalPages = 1;
      const allEvents: HousecallProEvent[] = [];

      while (page <= totalPages) {
        const result = await this.makeRequest<unknown>(`/events?page=${page}&page_size=${pageSize}&sort_by=created_at&sort_direction=desc`, tenantId);
        if (!result.success || !result.data) {
          if (page === 1) {
            return { success: false, error: result.error || 'Failed to fetch events' };
          }
          break;
        }
        const envelope = result.data as HcpPageEnvelope<HousecallProEvent>;
        if (typeof envelope.total_pages === 'number') {
          totalPages = envelope.total_pages;
        }
        const pageEvents: HousecallProEvent[] = extractHcpList<HousecallProEvent>(result.data, 'events');
        allEvents.push(...pageEvents);

        page++;
        if (page > 20) {
          log.warn(`[HCP] Reached page limit fetching events, stopping pagination`);
          break;
        }
      }

      const cancelledStatuses = ['cancelled', 'canceled', 'inactive', 'deleted'];
      const activeEvents = allEvents.filter((evt: HousecallProEvent) => {
        const status = (evt.status || '').toLowerCase();
        if (cancelledStatuses.some(s => status.includes(s))) return false;

        const resolvedStart = this.resolveEventTime(evt, 'start');
        const resolvedEnd = this.resolveEventTime(evt, 'end');
        if (!resolvedStart || !resolvedEnd) return false;

        // In-memory date range filter: keep only events that overlap [startDate, endDate)
        const evtStart = new Date(resolvedStart);
        const evtEnd = new Date(resolvedEnd);
        if (evtEnd <= startDate || evtStart >= endDate) return false;

        return this.eventAssignedToEmployee(evt, employeeId);
      }).map((evt: HousecallProEvent) => ({
        ...evt,
        start_time: this.resolveEventTime(evt, 'start'),
        end_time: this.resolveEventTime(evt, 'end'),
      }));

      log.info(`[HCP] Fetched ${allEvents.length} total events, ${activeEvents.length} active for employee ${employeeId}`);
      return { success: true, data: activeEvents };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error(`[HCP] Error fetching employee events:`, error);
      return { success: false, error: msg };
    }
  }

  async getEmployeeScheduledJobs(
    tenantId: string,
    employeeId: string,
    startDate: Date,
    endDate: Date
  ): Promise<HousecallProResponse<HousecallProJob[]>> {
    try {
      const params = new URLSearchParams();
      params.append('employee_ids[]', employeeId);
      params.append('scheduled_start_min', startDate.toISOString());
      params.append('scheduled_start_max', endDate.toISOString());
      params.append('page_size', '100');
      
      const result = await this.makeRequest<unknown>(`/jobs?${params.toString()}`, tenantId);
      
      if (result.success && result.data) {
        const allJobs: HousecallProJob[] = extractHcpList<HousecallProJob>(result.data, 'jobs');
        type HcpJobExtended = HousecallProJob & {
          employee_id?: string;
          employee_ids?: string[];
          lead_source?: { employee_id?: string };
        };
        const employeeJobs = allJobs.filter((job: HousecallProJob) => {
          const j = job as HcpJobExtended;
          const assignedEmployees: string[] = j.employee_ids || [];
          return assignedEmployees.includes(employeeId) ||
                 j.employee_id === employeeId ||
                 j.lead_source?.employee_id === employeeId ||
                 job.assigned_employees?.some(emp => emp.id === employeeId);
        });
        // Return only the jobs matched to this employee.
        // Returning allJobs on no-match would treat every tenant job as a busy window
        // for this employee, blocking all their availability.
        log.info(`[HCP] Fetched ${allJobs.length} total jobs, ${employeeJobs.length} for employee ${employeeId}`);
        return { success: true, data: employeeJobs };
      }
      
      return { success: false, error: result.error || 'Failed to fetch jobs' };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error(`[HCP] Error fetching employee jobs:`, error);
      return { success: false, error: msg };
    }
  }

  calculateAvailableSlots(
    businessHours: { start: string; end: string },
    appointments: Array<{ start: string; end: string }>
  ): Array<{ start_time: string; end_time: string; duration_minutes: number }> {
    const slots = [];
    
    const businessStartMinutes = this.timeToMinutes(businessHours.start);
    const businessEndMinutes = this.timeToMinutes(businessHours.end);
    
    const appointmentSlots = appointments
      .map(apt => ({
        start: this.isoToMinutes(apt.start),
        end: this.isoToMinutes(apt.end),
      }))
      .sort((a, b) => a.start - b.start);

    let currentTime = businessStartMinutes;
    
    for (const appointment of appointmentSlots) {
      if (currentTime < appointment.start) {
        const duration = appointment.start - currentTime;
        if (duration >= 60) {
          slots.push({
            start_time: this.minutesToTime(currentTime),
            end_time: this.minutesToTime(appointment.start),
            duration_minutes: duration,
          });
        }
      }
      currentTime = Math.max(currentTime, appointment.end);
    }
    
    if (currentTime < businessEndMinutes) {
      const duration = businessEndMinutes - currentTime;
      if (duration >= 60) {
        slots.push({
          start_time: this.minutesToTime(currentTime),
          end_time: this.minutesToTime(businessEndMinutes),
          duration_minutes: duration,
        });
      }
    }
    
    return slots;
  }

  private timeToMinutes(time: string): number {
    const [hours, minutes] = time.split(':').map(Number);
    return hours * 60 + minutes;
  }

  /**
   * Current wall-clock date + minutes-of-day in the given IANA timezone.
   * Used by same-day scheduling (task #877) to determine whether the requested
   * date is "today" for the contractor and, if so, which slots have passed.
   */
  private nowInTimezone(timezone: string): { dateStr: string; minutes: number } {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(new Date());
    const map: Record<string, string> = {};
    for (const p of parts) map[p.type] = p.value;
    let hour = parseInt(map.hour ?? '0', 10);
    if (hour === 24) hour = 0; // some runtimes emit "24" for midnight
    const minutes = hour * 60 + parseInt(map.minute ?? '0', 10);
    return { dateStr: `${map.year}-${map.month}-${map.day}`, minutes };
  }

  private isoToMinutes(isoString: string): number {
    const date = new Date(isoString);
    return date.getHours() * 60 + date.getMinutes();
  }

  private minutesToTime(minutes: number): string {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}`;
  }

  private async getEmployeesForScheduling(tenantId: string): Promise<HousecallProResponse<any[]>> {
    const allEmployees: any[] = [];
    let page = 1;
    const pageSize = 100;
    let totalPages = 1;
    
    while (page <= totalPages) {
      const response = await this.makeRequest<any>(`/employees?page=${page}&page_size=${pageSize}`, tenantId);
      
      if (!response.success || !response.data) {
        if (page === 1) return response;
        break;
      }
      
      const responseData = response.data;
      if (responseData.total_pages) totalPages = responseData.total_pages;

      const employees = extractHcpList<any>(responseData, 'employees');
      allEmployees.push(...employees);
      page++;
      
      if (page > 50) break;
    }
    
    return { success: true, data: allEmployees };
  }

  private async getEstimatesForScheduling(tenantId: string, params: Record<string, string>): Promise<HousecallProResponse<HousecallProEstimate[]>> {
    const queryParams = new URLSearchParams(params);
    const endpoint = `/estimates?${queryParams.toString()}`;
    const response = await this.makeRequest<unknown>(endpoint, tenantId, 'GET', undefined, 3, 'application/json');
    
    if (response.success && response.data) {
      const estimates = extractHcpList<HousecallProEstimate>(response.data, 'estimates');
      return { success: true, data: estimates };
    }
    
    return response as HousecallProResponse<HousecallProEstimate[]>;
  }
}
