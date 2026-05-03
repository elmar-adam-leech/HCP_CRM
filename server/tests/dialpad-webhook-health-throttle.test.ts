/**
 * Cross-service isolation for the per-(contractor, service, kind) cooldown
 * (Task #712). The HCP and Dialpad health monitors share the same notifier
 * and the same throttle table, but the throttle is keyed on `service` so
 * a cooldown active for one service must NEVER suppress an alert for the
 * other. Both directions are exercised here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

interface AdminUser {
  userId: string;
  role: 'admin' | 'super_admin' | 'sales' | 'booker';
}

const sendHcpEmailMock = vi.fn<
  (params: unknown) => Promise<{ sent: number; attempted: number }>
>();
const sendDialpadEmailMock = vi.fn<
  (params: unknown) => Promise<{ sent: number; attempted: number }>
>();
const getContractorUsersMock = vi.fn<(contractorId: string) => Promise<AdminUser[]>>();
const broadcastMock = vi.fn();

const getLastAlertedAtMock = vi.fn<
  (contractorId: string, service: string, kind: string) => Promise<Date | null>
>();
const stampAlertThrottleMock = vi.fn<
  (contractorId: string, service: string, kind: string) => Promise<void>
>();
const notificationInserts: Array<{ userId: string; contractorId: string; title: string }> = [];

vi.mock('../services/hcp-incident-email', () => ({
  sendHcpIncidentEmail: (params: unknown) => sendHcpEmailMock(params),
}));

vi.mock('../services/dialpad-incident-email', () => ({
  sendDialpadIncidentEmail: (params: unknown) => sendDialpadEmailMock(params),
}));

vi.mock('../services/webhook-alert-throttle', () => ({
  getLastAlertedAt: (c: string, s: string, k: string) => getLastAlertedAtMock(c, s, k),
  stampAlertThrottle: (c: string, s: string, k: string) => stampAlertThrottleMock(c, s, k),
}));

vi.mock('../storage', () => ({
  storage: {
    getContractorUsers: (id: string) => getContractorUsersMock(id),
  },
}));

vi.mock('../websocket', () => ({
  broadcastToContractor: (...args: unknown[]) => broadcastMock(...args),
}));

vi.mock('../utils/logger', () => ({
  logger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

vi.mock('../hcp/index', () => ({ housecallProService: {} }));
vi.mock('../hcp/webhook-subscriptions', () => ({ hcpWebhookSubscriptionsService: {} }));
vi.mock('../sync/hcp-backfill', () => ({
  runHcpWebhookBackfill: vi.fn(),
  summarizeBackfill: vi.fn(),
}));

// Tiny db stub: notifyWebhookIncidentOpened only writes the notifications
// insert + the webhook_incidents.notifiedAt update. Both no-op cleanly here;
// notification rows are recorded for assertions.
vi.mock('../db', () => {
  const insert = () => ({
    values: (vals: Record<string, unknown> | Record<string, unknown>[]) => {
      const arr = Array.isArray(vals) ? vals : [vals];
      for (const v of arr) {
        if ('userId' in v && 'title' in v) {
          notificationInserts.push({
            userId: String(v.userId),
            contractorId: String(v.contractorId),
            title: String(v.title),
          });
        }
      }
      return Promise.resolve();
    },
  });
  const update = () => ({
    set: () => ({ where: () => Promise.resolve() }),
  });
  return { db: { insert, update } };
});

import { notifyIncidentOpened } from '../services/hcp-webhook-health';
import { notifyWebhookIncidentOpened } from '../services/webhook-incident-notifier';

const dialpadParams = {
  contractorId: 'contractor-1',
  incidentId: 'dialpad-incident-1',
  service: 'dialpad' as const,
  kind: 'staleness' as const,
  title: 'Dialpad call events are not arriving',
  message: 'No Dialpad call events received in 7 days.',
  link: '/settings/integrations',
  sendEmail: () => sendDialpadEmailMock({}),
};

const hcpParams = {
  contractorId: 'contractor-1',
  incidentId: 'hcp-incident-1',
  kind: 'staleness' as const,
  title: 'HCP webhooks may be disabled',
  message: 'No HCP events received recently.',
  emailSubject: 'HCP staleness',
  emailBody: 'No HCP events received recently.',
};

beforeEach(() => {
  notificationInserts.length = 0;
  sendHcpEmailMock.mockReset();
  sendDialpadEmailMock.mockReset();
  getContractorUsersMock.mockReset();
  broadcastMock.mockReset();
  getLastAlertedAtMock.mockReset();
  stampAlertThrottleMock.mockReset();
  stampAlertThrottleMock.mockResolvedValue();
  getContractorUsersMock.mockResolvedValue([{ userId: 'admin-1', role: 'admin' }]);
  sendHcpEmailMock.mockResolvedValue({ sent: 1, attempted: 1 });
  sendDialpadEmailMock.mockResolvedValue({ sent: 1, attempted: 1 });
});

describe('webhook incident alert throttle — cross-service isolation', () => {
  it('Dialpad first open fires email + in-app and stamps the dialpad cooldown', async () => {
    getLastAlertedAtMock.mockResolvedValue(null);

    await notifyWebhookIncidentOpened(dialpadParams);

    expect(sendDialpadEmailMock).toHaveBeenCalledTimes(1);
    expect(sendHcpEmailMock).not.toHaveBeenCalled();
    expect(notificationInserts).toEqual([
      { userId: 'admin-1', contractorId: 'contractor-1', title: dialpadParams.title },
    ]);
    expect(stampAlertThrottleMock).toHaveBeenCalledWith(
      'contractor-1', 'dialpad', 'staleness',
    );
  });

  it('an active HCP cooldown does NOT suppress a Dialpad alert', async () => {
    // Throttle returns "recently alerted" only for HCP; Dialpad lookup
    // gets its own (null) result keyed on service.
    getLastAlertedAtMock.mockImplementation(async (_c, service) =>
      service === 'housecall-pro' ? new Date() : null,
    );

    await notifyWebhookIncidentOpened(dialpadParams);

    expect(getLastAlertedAtMock).toHaveBeenCalledWith(
      'contractor-1', 'dialpad', 'staleness',
    );
    expect(sendDialpadEmailMock).toHaveBeenCalledTimes(1);
    expect(notificationInserts).toHaveLength(1);
    expect(stampAlertThrottleMock).toHaveBeenCalledWith(
      'contractor-1', 'dialpad', 'staleness',
    );
  });

  it('an active Dialpad cooldown does NOT suppress an HCP alert', async () => {
    getLastAlertedAtMock.mockImplementation(async (_c, service) =>
      service === 'dialpad' ? new Date() : null,
    );

    await notifyIncidentOpened(hcpParams);

    expect(getLastAlertedAtMock).toHaveBeenCalledWith(
      'contractor-1', 'housecall-pro', 'staleness',
    );
    expect(sendHcpEmailMock).toHaveBeenCalledTimes(1);
    expect(sendDialpadEmailMock).not.toHaveBeenCalled();
    expect(notificationInserts).toHaveLength(1);
    expect(stampAlertThrottleMock).toHaveBeenCalledWith(
      'contractor-1', 'housecall-pro', 'staleness',
    );
  });

  it('a flapping Dialpad outage pages once per 24h per kind (second open suppressed)', async () => {
    // First open inside the cooldown window — shared notifier suppresses
    // both channels (this is the same flap-suppression behaviour HCP gets).
    getLastAlertedAtMock.mockResolvedValue(new Date(Date.now() - 5 * 60 * 1000));

    await notifyWebhookIncidentOpened(dialpadParams);

    expect(sendDialpadEmailMock).not.toHaveBeenCalled();
    expect(notificationInserts).toHaveLength(0);
    expect(stampAlertThrottleMock).not.toHaveBeenCalled();
  });

  it('cooldown is keyed per-kind for Dialpad too (staleness cooldown does not suppress backlog)', async () => {
    getLastAlertedAtMock.mockImplementation(async (_c, _s, kind) =>
      kind === 'staleness' ? new Date() : null,
    );

    await notifyWebhookIncidentOpened({ ...dialpadParams, kind: 'backlog' });

    expect(getLastAlertedAtMock).toHaveBeenCalledWith(
      'contractor-1', 'dialpad', 'backlog',
    );
    expect(sendDialpadEmailMock).toHaveBeenCalledTimes(1);
    expect(stampAlertThrottleMock).toHaveBeenCalledWith(
      'contractor-1', 'dialpad', 'backlog',
    );
  });
});
