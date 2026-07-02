/**
 * Route-level coverage for internal flexible scheduling (task #859 → #871).
 *
 * Two endpoints back the staff-facing "Booked but selectable" time picker:
 *   - GET /api/scheduling/day-slots            (local availability path)
 *   - GET /api/housecall-pro/availability?includeConflicts=true (HCP path)
 *
 * Both must return conflicting candidate times WITH `conflict: true` rather
 * than omitting them. These tests exercise the handlers against mocked
 * services and pin that response contract.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { type Express } from 'express';

// --- mocks -----------------------------------------------------------------

const {
  getSalespersonDaySlotsMock,
  getAppointmentSettingsMock,
  getContractorMock,
  isIntegrationEnabledCachedMock,
  getEstimatorTimeCandidatesMock,
} = vi.hoisted(() => ({
  getSalespersonDaySlotsMock: vi.fn(),
  getAppointmentSettingsMock: vi.fn(),
  getContractorMock: vi.fn(),
  isIntegrationEnabledCachedMock: vi.fn(),
  getEstimatorTimeCandidatesMock: vi.fn(),
}));

vi.mock('../../scheduling/availability', () => ({
  getSalespersonDaySlots: (...args: unknown[]) => getSalespersonDaySlotsMock(...args),
  getAppointmentSettings: (...args: unknown[]) => getAppointmentSettingsMock(...args),
}));

vi.mock('../../storage', () => ({
  storage: {
    getContractor: (...args: unknown[]) => getContractorMock(...args),
    // Unused by these routes but referenced elsewhere in the module graph.
    getContractorCredential: vi.fn(),
  },
}));

vi.mock('../../services/cache', () => ({
  isIntegrationEnabledCached: (...args: unknown[]) => isIntegrationEnabledCachedMock(...args),
}));

vi.mock('../../hcp/index', () => ({
  housecallProService: {
    getEstimatorTimeCandidates: (...args: unknown[]) => getEstimatorTimeCandidatesMock(...args),
    getEstimatorAvailability: vi.fn(),
  },
}));

// The HCP-scheduling route module imports several heavy singletons at load
// time; stub them so importing the register fn stays cheap and side-effect
// free. Only the day-slots handler is exercised here.
vi.mock('../../housecall-scheduling-service', () => ({
  housecallSchedulingService: {},
}));
vi.mock('../../credential-service', () => ({
  CredentialService: {},
  credentialService: {},
}));
vi.mock('../../services/hcp-webhook-health', () => ({
  getWebhookHealthStatus: vi.fn(),
  getWebhookStatus: vi.fn(),
  triggerManualBackfill: vi.fn(),
}));
vi.mock('../../utils/activity', () => ({
  createActivityAndBroadcast: vi.fn(),
}));
// housecall-pro.ts also pulls in these at load time.
vi.mock('../../sync/housecall-pro', () => ({ syncHcpLeadSources: vi.fn() }));

import { registerHcpSchedulingRoutes } from './hcp-scheduling';
import { registerHousecallProRoutes } from './housecall-pro';

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { contractorId: 'tenant-1', userId: 'user-1' };
    next();
  });
  registerHcpSchedulingRoutes(app);
  registerHousecallProRoutes(app);
  return app;
}

// Minimal in-process route invoker (walks the express router stack) — mirrors
// the pattern used by sales-process.test.ts; avoids a supertest dependency.
async function call(app: Express, method: string, url: string, body?: any) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const [pathOnly, queryString] = url.split('?');
    const query: Record<string, string> = {};
    if (queryString) {
      for (const [k, v] of new URLSearchParams(queryString)) query[k] = v;
    }
    const req: any = {
      method, url, body: body ?? {},
      headers: {}, query, params: {},
      get: () => undefined,
    };
    void pathOnly;
    const res: any = {
      statusCode: 200,
      setHeader() {}, getHeader() {}, removeHeader() {},
      status(c: number) { this.statusCode = c; return this; },
      json(payload: any) { resolve({ status: this.statusCode, body: payload }); return this; },
      send(payload: any) { resolve({ status: this.statusCode, body: payload }); return this; },
      end() { resolve({ status: this.statusCode, body: undefined }); },
    };
    const matchUrl = url.split('?')[0];
    const stack: any[] = (app as any)._router.stack;
    const handle = (i: number) => {
      if (i >= stack.length) return resolve({ status: 404, body: { error: 'no route' } });
      const layer = stack[i];
      if (layer.route && layer.route.path === matchUrl && layer.route.methods[method.toLowerCase()]) {
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
      if (!layer.route && layer.handle.length === 3) {
        layer.handle(req, res, () => handle(i + 1));
        return;
      }
      handle(i + 1);
    };
    handle(0);
  });
}

beforeEach(() => vi.clearAllMocks());

describe('GET /api/scheduling/day-slots (task #871)', () => {
  it('returns every candidate time with conflict flags (conflicts NOT omitted)', async () => {
    getContractorMock.mockResolvedValue({ timezone: 'America/New_York' });
    getSalespersonDaySlotsMock.mockResolvedValue({
      durationMinutes: 60,
      bufferMinutes: 30,
      slots: [
        { start: new Date('2027-07-08T12:00:00.000Z'), end: new Date('2027-07-08T13:00:00.000Z'), conflict: false },
        { start: new Date('2027-07-08T14:00:00.000Z'), end: new Date('2027-07-08T15:00:00.000Z'), conflict: true },
      ],
    });

    const app = makeApp();
    const r = await call(app, 'GET', '/api/scheduling/day-slots?date=2027-07-08&salespersonId=sp-1');

    expect(r.status).toBe(200);
    expect(r.body.date).toBe('2027-07-08');
    expect(r.body.slotDurationMinutes).toBe(60);
    expect(r.body.bufferMinutes).toBe(30);
    expect(r.body.slots).toHaveLength(2);
    // The conflicting slot is present and serialized with conflict:true.
    const booked = r.body.slots.find((s: any) => s.start === '2027-07-08T14:00:00.000Z');
    expect(booked).toBeDefined();
    expect(booked.conflict).toBe(true);
    expect(r.body.slots.some((s: any) => s.conflict === false)).toBe(true);

    // Handler passed the resolved timezone through to the service.
    expect(getSalespersonDaySlotsMock).toHaveBeenCalledWith('tenant-1', '2027-07-08', 'sp-1', 'America/New_York');
  });

  it('defaults timezone to America/New_York when the contractor has none', async () => {
    getContractorMock.mockResolvedValue({ timezone: null });
    getSalespersonDaySlotsMock.mockResolvedValue({ durationMinutes: 60, bufferMinutes: 30, slots: [] });

    const app = makeApp();
    const r = await call(app, 'GET', '/api/scheduling/day-slots?date=2027-07-08&salespersonId=sp-1');
    expect(r.status).toBe(200);
    expect(getSalespersonDaySlotsMock).toHaveBeenCalledWith('tenant-1', '2027-07-08', 'sp-1', 'America/New_York');
  });

  it('rejects a missing/invalid date with 400', async () => {
    const app = makeApp();
    const r = await call(app, 'GET', '/api/scheduling/day-slots?date=07-08-2027&salespersonId=sp-1');
    expect(r.status).toBe(400);
    expect(getSalespersonDaySlotsMock).not.toHaveBeenCalled();
  });

  it('rejects a missing salespersonId with 400', async () => {
    const app = makeApp();
    const r = await call(app, 'GET', '/api/scheduling/day-slots?date=2027-07-08');
    expect(r.status).toBe(400);
    expect(getSalespersonDaySlotsMock).not.toHaveBeenCalled();
  });
});

describe('GET /api/housecall-pro/availability?includeConflicts=true (task #871)', () => {
  it('returns candidate times with conflict flags via getEstimatorTimeCandidates', async () => {
    isIntegrationEnabledCachedMock.mockResolvedValue(true);
    getEstimatorTimeCandidatesMock.mockResolvedValue({
      success: true,
      data: [
        {
          employee_id: 'emp-1',
          employee_name: 'Alex Estimator',
          slots: [
            { start_time: '08:00', end_time: '09:00', conflict: false },
            { start_time: '10:00', end_time: '11:00', conflict: true },
          ],
        },
      ],
    });

    const app = makeApp();
    const r = await call(app, 'GET', '/api/housecall-pro/availability?date=2027-07-08&includeConflicts=true');

    expect(r.status).toBe(200);
    expect(r.body).toHaveLength(1);
    const slots = r.body[0].slots;
    expect(slots).toHaveLength(2);
    const booked = slots.find((s: any) => s.start_time === '10:00');
    expect(booked).toBeDefined();
    expect(booked.conflict).toBe(true);
    expect(slots.some((s: any) => s.conflict === false)).toBe(true);

    // The includeConflicts branch must call the candidate method, not the
    // free-gap availability method.
    expect(getEstimatorTimeCandidatesMock).toHaveBeenCalledWith('tenant-1', '2027-07-08', undefined);
  });

  it('forwards a comma-separated estimatorIds filter', async () => {
    isIntegrationEnabledCachedMock.mockResolvedValue(true);
    getEstimatorTimeCandidatesMock.mockResolvedValue({ success: true, data: [] });

    const app = makeApp();
    const r = await call(
      app,
      'GET',
      '/api/housecall-pro/availability?date=2027-07-08&includeConflicts=true&estimatorIds=emp-1,emp-2',
    );
    expect(r.status).toBe(200);
    expect(getEstimatorTimeCandidatesMock).toHaveBeenCalledWith('tenant-1', '2027-07-08', ['emp-1', 'emp-2']);
  });

  it('returns 403 when the HCP integration is disabled', async () => {
    isIntegrationEnabledCachedMock.mockResolvedValue(false);
    const app = makeApp();
    const r = await call(app, 'GET', '/api/housecall-pro/availability?date=2027-07-08&includeConflicts=true');
    expect(r.status).toBe(403);
    expect(getEstimatorTimeCandidatesMock).not.toHaveBeenCalled();
  });

  it('propagates a candidate-fetch failure as 400', async () => {
    isIntegrationEnabledCachedMock.mockResolvedValue(true);
    getEstimatorTimeCandidatesMock.mockResolvedValue({ success: false, error: 'HCP down' });
    const app = makeApp();
    const r = await call(app, 'GET', '/api/housecall-pro/availability?date=2027-07-08&includeConflicts=true');
    expect(r.status).toBe(400);
    expect(r.body.message).toBe('HCP down');
  });
});
