import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';

interface FakeEstimate {
  id: string;
  status: 'sent' | 'scheduled' | 'in_progress' | 'approved' | 'rejected';
  externalSource: string | null;
  housecallProEstimateId?: string | null;
  statusManuallySet: boolean;
  contactId: string;
  title: string;
}
interface UpdatePayload {
  status?: FakeEstimate['status'];
  statusManuallySet?: boolean;
  [key: string]: unknown;
}

const TENANT = 'tenant-1';

const store = new Map<string, FakeEstimate>();
const getEstimate = vi.fn(async (id: string, _c: string) => store.get(id));
const updateEstimate = vi.fn(async (id: string, data: UpdatePayload, _c: string) => {
  const cur = store.get(id);
  if (!cur) return undefined;
  const next = { ...cur, ...data } as FakeEstimate;
  store.set(id, next);
  return next;
});
const broadcastToContractor = vi.fn();
const triggerWorkflowsForEvent = vi.fn().mockResolvedValue(undefined);

vi.mock('../storage', () => ({
  storage: {
    getEstimate: (id: string, c: string) => getEstimate(id, c),
    updateEstimate: (id: string, d: UpdatePayload, c: string) => updateEstimate(id, d, c),
    getContact: vi.fn(),
    createEstimate: vi.fn(),
    deleteEstimate: vi.fn(),
    getEstimates: vi.fn(),
    getEstimatesPaginated: vi.fn(),
    getEstimatesCount: vi.fn(),
    getEstimatesStatusCounts: vi.fn(),
    getEstimatesWithFollowUp: vi.fn(),
  },
}));
vi.mock('../db', () => ({ db: {} }));
vi.mock('../websocket', () => ({ broadcastToContractor: (cid: string, msg: unknown) => broadcastToContractor(cid, msg) }));
vi.mock('../workflow-engine', () => ({
  workflowEngine: { triggerWorkflowsForEvent: (e: string, ev: unknown, c: string) => triggerWorkflowsForEvent(e, ev, c) },
}));
vi.mock('../utils/workflow/entity-adapter', () => ({ toWorkflowEvent: (e: unknown) => e }));
vi.mock('../utils/logger', () => ({ logger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }) }));
vi.mock('../utils/audit-log', () => ({ auditLog: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../utils/async-handler', () => ({
  asyncHandler: (fn: express.RequestHandler) => (req: express.Request, res: express.Response, next: express.NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  },
}));
vi.mock('../sync/hcp-mappers', async (orig) => orig());

import { registerEstimateRoutes } from '../routes/estimates';

let server: http.Server | undefined;
let baseUrl = '';

async function startApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user: { contractorId: string; id: string } }).user = { contractorId: TENANT, id: 'user-1' };
    next();
  });
  registerEstimateRoutes(app);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server!.listen(0, resolve));
  const addr = server!.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
}

async function patchStatus(id: string, body: unknown) {
  const res = await fetch(`${baseUrl}/api/estimates/${id}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = undefined;
  try { json = text ? JSON.parse(text) : undefined; } catch { /* ignore */ }
  return { status: res.status, body: json as Record<string, unknown> | undefined };
}

beforeEach(async () => {
  store.clear();
  vi.clearAllMocks();
  await startApp();
});

afterEach(async () => {
  if (server) await new Promise<void>((resolve, reject) => server!.close(err => err ? reject(err) : resolve()));
  server = undefined;
});

describe('PATCH /api/estimates/:id/status', () => {
  it('rejects an invalid status value', async () => {
    store.set('e1', {
      id: 'e1', status: 'sent', externalSource: 'housecall-pro', housecallProEstimateId: 'hcp1',
      statusManuallySet: false, contactId: 'c1', title: 't',
    });
    const res = await patchStatus('e1', { status: 'bogus' });
    expect(res.status).toBe(400);
  });

  it('returns 404 when the estimate does not exist', async () => {
    const res = await patchStatus('missing', { status: 'sent' });
    expect(res.status).toBe(404);
  });

  it('updates status on an HCP-synced estimate and sets statusManuallySet=true', async () => {
    store.set('e1', {
      id: 'e1', status: 'scheduled', externalSource: 'housecall-pro', housecallProEstimateId: 'hcp1',
      statusManuallySet: false, contactId: 'c1', title: 't',
    });

    const res = await patchStatus('e1', { status: 'in_progress' });
    expect(res.status).toBe(200);
    expect(res.body?.status).toBe('in_progress');
    expect(res.body?.statusManuallySet).toBe(true);

    const stored = store.get('e1')!;
    expect(stored.status).toBe('in_progress');
    expect(stored.statusManuallySet).toBe(true);
    expect(broadcastToContractor).toHaveBeenCalled();
    expect(triggerWorkflowsForEvent).toHaveBeenCalledWith('estimate_status_changed', expect.anything(), TENANT);
  });

  it('marks status as manually set so a follow-up sync would preserve it', async () => {
    store.set('e2', {
      id: 'e2', status: 'sent', externalSource: 'housecall-pro', housecallProEstimateId: 'hcp2',
      statusManuallySet: false, contactId: 'c2', title: 't2',
    });

    await patchStatus('e2', { status: 'approved' });

    const { resolveHcpEstimateStatus } = await import('../sync/hcp-mappers');
    const stored = store.get('e2')!;
    // A subsequent HCP poll mapping to 'scheduled' must be ignored.
    expect(resolveHcpEstimateStatus('scheduled', stored.status, stored.statusManuallySet)).toBe('approved');
    // But a terminal 'rejected' from HCP must still win.
    expect(resolveHcpEstimateStatus('rejected', stored.status, stored.statusManuallySet)).toBe('rejected');
  });
});
