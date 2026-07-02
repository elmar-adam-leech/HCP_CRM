/**
 * Regression coverage for HCP internal flexible scheduling (task #859 → #871).
 *
 * `getEstimatorTimeCandidates` is the HCP-backed sibling of
 * `getSalespersonDaySlots`: it returns EVERY candidate start time across
 * business hours for each estimator, flagging times that overlap an existing
 * scheduled estimate with `conflict: true` — WITHOUT dropping them. This keeps
 * "Booked" times visible-and-selectable in the staff modal (intentional
 * double-booking). These tests pin that behaviour.
 *
 * Note on timezones: the production code's `isoToMinutes` uses
 * `Date#getHours()` (local time). To keep the assertions deterministic
 * regardless of the machine's timezone, estimate times are provided WITHOUT a
 * `Z`/offset so `new Date(...)` parses them as local wall-clock time.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HcpSchedulingModule } from './scheduling';

const TENANT = 'tenant-1';
const DATE = '2027-07-08';

function employeesResponse() {
  return {
    success: true as const,
    data: {
      employees: [
        {
          id: 'emp-1',
          role: 'Estimator',
          is_active: true,
          first_name: 'Alex',
          last_name: 'Estimator',
        },
        {
          // Inactive estimator — must be filtered out.
          id: 'emp-2',
          role: 'Estimator',
          is_active: false,
          first_name: 'Ina',
          last_name: 'Ctive',
        },
      ],
      total_pages: 1,
    },
  };
}

function estimatesResponse() {
  return {
    success: true as const,
    data: {
      estimates: [
        {
          // 10:00–11:00 local for emp-1 → busy window 600–660 minutes.
          employee_id: 'emp-1',
          scheduled_start: '2027-07-08T10:00:00',
          scheduled_end: '2027-07-08T11:00:00',
        },
        {
          // Belongs to a different employee — must not affect emp-1's slots.
          employee_id: 'emp-999',
          scheduled_start: '2027-07-08T13:00:00',
          scheduled_end: '2027-07-08T14:00:00',
        },
      ],
    },
  };
}

function makeModuleWithStubbedRequests() {
  const mod = new HcpSchedulingModule();
  vi.spyOn(mod, 'makeRequest').mockImplementation(async (endpoint: string) => {
    if (endpoint.startsWith('/employees')) return employeesResponse() as any;
    if (endpoint.startsWith('/estimates')) return estimatesResponse() as any;
    throw new Error(`unexpected endpoint ${endpoint}`);
  });
  return mod;
}

beforeEach(() => vi.clearAllMocks());

describe('getEstimatorTimeCandidates — conflict flagging (task #871)', () => {
  it('returns EVERY candidate time per estimator and flags overlaps with conflict:true (no omission)', async () => {
    const mod = makeModuleWithStubbedRequests();

    const result = await mod.getEstimatorTimeCandidates(TENANT, DATE);
    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();

    // Only the active estimator is returned.
    expect(result.data!.length).toBe(1);
    const estimator = result.data![0];
    expect(estimator.employee_id).toBe('emp-1');
    expect(estimator.employee_name).toBe('Alex Estimator');

    // 08:00–17:00 business hours, 60-min slots stepped every 30 min: last slot
    // that fits is 16:00–17:00 → 17 candidate times, none omitted.
    expect(estimator.slots.length).toBe(17);

    // Must contain BOTH conflicting and free times.
    const conflicting = estimator.slots.filter(s => s.conflict);
    const free = estimator.slots.filter(s => !s.conflict);
    expect(conflicting.length).toBeGreaterThan(0);
    expect(free.length).toBeGreaterThan(0);

    // The 10:00 slot overlaps emp-1's booking → conflict:true, still present.
    const tenAm = estimator.slots.find(s => s.start_time === '10:00');
    expect(tenAm).toBeDefined();
    expect(tenAm!.conflict).toBe(true);
    expect(tenAm!.end_time).toBe('11:00');

    // Exactly the slots overlapping 10:00–11:00 are flagged: 09:30, 10:00, 10:30.
    expect(conflicting.map(s => s.start_time)).toEqual(['09:30', '10:00', '10:30']);

    // The 08:00 slot does not overlap → conflict:false.
    const eightAm = estimator.slots.find(s => s.start_time === '08:00');
    expect(eightAm).toBeDefined();
    expect(eightAm!.conflict).toBe(false);
  });

  it('flags no conflicts when the estimator has no scheduled estimates', async () => {
    const mod = new HcpSchedulingModule();
    vi.spyOn(mod, 'makeRequest').mockImplementation(async (endpoint: string) => {
      if (endpoint.startsWith('/employees')) return employeesResponse() as any;
      if (endpoint.startsWith('/estimates')) return { success: true, data: { estimates: [] } } as any;
      throw new Error(`unexpected endpoint ${endpoint}`);
    });

    const result = await mod.getEstimatorTimeCandidates(TENANT, DATE);
    expect(result.success).toBe(true);
    const estimator = result.data![0];
    expect(estimator.slots.length).toBe(17);
    expect(estimator.slots.every(s => s.conflict === false)).toBe(true);
  });

  it('restricts to the requested estimatorIds', async () => {
    const mod = makeModuleWithStubbedRequests();
    const result = await mod.getEstimatorTimeCandidates(TENANT, DATE, ['emp-999']);
    expect(result.success).toBe(true);
    // No active estimator matches emp-999 → empty availability list.
    expect(result.data).toEqual([]);
  });

  it('propagates an employees fetch failure', async () => {
    const mod = new HcpSchedulingModule();
    vi.spyOn(mod, 'makeRequest').mockImplementation(async (endpoint: string) => {
      if (endpoint.startsWith('/employees')) return { success: false, error: 'boom' } as any;
      throw new Error(`unexpected endpoint ${endpoint}`);
    });

    const result = await mod.getEstimatorTimeCandidates(TENANT, DATE);
    expect(result.success).toBe(false);
    expect(result.error).toBe('boom');
  });
});
