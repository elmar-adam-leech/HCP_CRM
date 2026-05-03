/**
 * Per-(contractor, service, kind) cooldown gates for HCP webhook health
 * alerts. Each test asserts a single, well-defined behaviour of the
 * notifier; the throttle module is mocked at the module boundary so the
 * test exercises real notifier code without hand-rolling a Drizzle stub.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

interface AdminUser {
  userId: string;
  role: 'admin' | 'super_admin' | 'sales' | 'booker';
}

const sendEmailMock = vi.fn<
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
const incidentNotifiedIds: string[] = [];

vi.mock('../services/hcp-incident-email', () => ({
  sendHcpIncidentEmail: (params: unknown) => sendEmailMock(params),
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

// Tiny db stub: notifyIncidentOpened only does write-side ops on the db
// (notifications insert + webhook_incidents update). Both are recorded
// into module-level arrays so tests can assert on what was attempted.
vi.mock('../db', () => {
  const insert = (table: { _: { name?: string } } | unknown) => ({
    values: (vals: Record<string, unknown> | Record<string, unknown>[]) => {
      const arr = Array.isArray(vals) ? vals : [vals];
      // The notifier only inserts into the `notifications` table directly
      // (the throttle insert path is mocked above). Identify by shape.
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
    set: (vals: Record<string, unknown>) => ({
      where: () => {
        // notifyIncidentOpened only updates webhook_incidents.notifiedAt.
        if ('notifiedAt' in vals) incidentNotifiedIds.push('marked');
        return Promise.resolve();
      },
    }),
  });
  return { db: { insert, update } };
});

import {
  notifyIncidentOpened,
  ALERT_THROTTLE_WINDOW_MS,
} from '../services/hcp-webhook-health';

const baseParams = {
  contractorId: 'contractor-1',
  incidentId: 'incident-1',
  kind: 'health-check-failure' as const,
  title: 'Webhook health monitor is failing',
  message: 'msg',
  emailSubject: 'subj',
  emailBody: 'body',
};

beforeEach(() => {
  notificationInserts.length = 0;
  incidentNotifiedIds.length = 0;
  sendEmailMock.mockReset();
  getContractorUsersMock.mockReset();
  broadcastMock.mockReset();
  getLastAlertedAtMock.mockReset();
  stampAlertThrottleMock.mockReset();
  // Default: no prior alert, one admin recipient, email succeeds.
  getLastAlertedAtMock.mockResolvedValue(null);
  stampAlertThrottleMock.mockResolvedValue();
  getContractorUsersMock.mockResolvedValue([{ userId: 'admin-1', role: 'admin' }]);
  sendEmailMock.mockResolvedValue({ sent: 1, attempted: 1 });
});

describe('webhook incident alert throttle', () => {
  it('first open fires email + in-app and stamps the cooldown', async () => {
    await notifyIncidentOpened(baseParams);

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(notificationInserts).toEqual([
      { userId: 'admin-1', contractorId: 'contractor-1', title: baseParams.title },
    ]);
    expect(stampAlertThrottleMock).toHaveBeenCalledWith(
      'contractor-1', 'housecall-pro', 'health-check-failure',
    );
  });

  it('subsequent open inside the cooldown window suppresses BOTH email and in-app', async () => {
    getLastAlertedAtMock.mockResolvedValue(new Date(Date.now() - 5 * 60 * 1000));

    await notifyIncidentOpened(baseParams);

    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(notificationInserts).toHaveLength(0);
    expect(stampAlertThrottleMock).not.toHaveBeenCalled();
    // Incident is still marked notified so the next tick doesn't keep retrying.
    expect(incidentNotifiedIds).toHaveLength(1);
  });

  it('after the cooldown window expires both channels resume', async () => {
    getLastAlertedAtMock.mockResolvedValue(new Date(Date.now() - ALERT_THROTTLE_WINDOW_MS - 1000));

    await notifyIncidentOpened(baseParams);

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(notificationInserts).toHaveLength(1);
    expect(stampAlertThrottleMock).toHaveBeenCalled();
  });

  it('cooldown is keyed per-kind — staleness cooldown does not suppress a rejection alert', async () => {
    // Lookup is parameterised on kind, so a rejection lookup gets its own
    // (null) result regardless of what is stamped for staleness.
    getLastAlertedAtMock.mockImplementation(async (_c, _s, kind) =>
      kind === 'staleness' ? new Date() : null,
    );

    await notifyIncidentOpened({ ...baseParams, kind: 'rejection' });

    expect(getLastAlertedAtMock).toHaveBeenCalledWith(
      'contractor-1', 'housecall-pro', 'rejection',
    );
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(stampAlertThrottleMock).toHaveBeenCalledWith(
      'contractor-1', 'housecall-pro', 'rejection',
    );
  });

  it('email attempted-but-fully-bounced with no in-app delivery does NOT consume the cooldown', async () => {
    // SendGrid had recipients but every single send failed — the existing
    // SMTP-retry guard skips the in-app insert and bails. The cooldown
    // must remain unset so the next health-check tick can retry.
    sendEmailMock.mockResolvedValue({ sent: 0, attempted: 2 });

    await notifyIncidentOpened(baseParams);

    expect(notificationInserts).toHaveLength(0);
    expect(stampAlertThrottleMock).not.toHaveBeenCalled();
  });

  it('successful in-app insert with no email recipients DOES consume the cooldown', async () => {
    // No admin email addresses available → email impossible (attempted = 0)
    // → falls through to in-app, which succeeds. The user has been paged
    // in-app, so the cooldown must be consumed.
    sendEmailMock.mockResolvedValue({ sent: 0, attempted: 0 });

    await notifyIncidentOpened(baseParams);

    expect(notificationInserts).toHaveLength(1);
    expect(stampAlertThrottleMock).toHaveBeenCalledTimes(1);
  });

  it('reopen inside the 24h window remains suppressed even after a long open + close', async () => {
    // Simulate the full alert -> long open -> close -> reopen sequence
    // inside one 24h window. The first open pages once and stamps the
    // cooldown. A subsequent reopen — regardless of how long the prior
    // incident stayed open before closing — must NOT page again until
    // the 24h window naturally expires.

    // 1) First open: nothing stamped yet, fires.
    await notifyIncidentOpened(baseParams);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(stampAlertThrottleMock).toHaveBeenCalledTimes(1);

    // 2) Reopen 6 hours later (well after the prior incident's close,
    //    but still well inside the 24h cooldown). Stub the throttle to
    //    return the original stamp time.
    const stampedAt = new Date(Date.now() - 6 * 60 * 60 * 1000);
    getLastAlertedAtMock.mockResolvedValue(stampedAt);
    sendEmailMock.mockClear();
    stampAlertThrottleMock.mockClear();
    notificationInserts.length = 0;
    incidentNotifiedIds.length = 0;

    await notifyIncidentOpened(baseParams);

    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(notificationInserts).toHaveLength(0);
    expect(stampAlertThrottleMock).not.toHaveBeenCalled();
    // Still mark the incident notified so the next tick doesn't keep retrying.
    expect(incidentNotifiedIds).toHaveLength(1);
  });

  it('partial in-app failure (every admin insert throws) with no email does NOT consume the cooldown', async () => {
    // Email impossible AND every in-app insert fails. Nothing was
    // delivered — the cooldown must NOT be consumed.
    sendEmailMock.mockResolvedValue({ sent: 0, attempted: 0 });
    // Replace the db insert with one that throws so inAppInsertedCount stays 0.
    const dbModule = await import('../db');
    const originalInsert = dbModule.db.insert;
    (dbModule.db as { insert: unknown }).insert = () => ({
      values: () => Promise.reject(new Error('insert failed')),
    });
    try {
      await notifyIncidentOpened(baseParams);
    } finally {
      (dbModule.db as { insert: unknown }).insert = originalInsert;
    }

    expect(stampAlertThrottleMock).not.toHaveBeenCalled();
  });
});
