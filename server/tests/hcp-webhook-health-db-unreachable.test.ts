/**
 * Task #788 — when the HCP webhook health checker fails because the
 * underlying DB pool is unreachable (Neon connect timeout, pool acquire
 * timeout, statement timeout, ECONNRESET, etc.), we must NOT open a
 * `health-check-failure` incident and we must NOT page admins. The
 * degraded state should be surfaced via getWebhookStatus so the admin UI
 * can show "health checker degraded" instead of a false "webhook is
 * down" alert.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const integrationsRows = [{ contractorId: 'contractor-1' }];

const insertCalls: Array<{ table: string; values: unknown }> = [];

vi.mock('../db', () => {
  const select = () => ({
    from: () => ({
      where: () => ({
        limit: () => Promise.resolve(integrationsRows),
        orderBy: () => ({ limit: () => Promise.resolve([]) }),
      }),
    }),
  });
  const insert = (table: { _?: { name?: string } } | unknown) => {
    const tableName =
      (table as { _?: { name?: string } })?._?.name ?? 'unknown';
    return {
      values: (vals: unknown) => {
        insertCalls.push({ table: tableName, values: vals });
        const chain: any = {
          onConflictDoNothing: () => ({ returning: () => Promise.resolve([]) }),
          returning: () => Promise.resolve([]),
        };
        return Object.assign(Promise.resolve(), chain);
      },
    };
  };
  const update = () => ({ set: () => ({ where: () => Promise.resolve() }) });
  return { db: { select, insert, update } };
});

vi.mock('../storage', () => ({
  storage: {
    getContractorUsers: () => Promise.resolve([]),
    getHousecallProSyncStartDate: () => Promise.resolve(null),
  },
}));

vi.mock('../websocket', () => ({ broadcastToContractor: () => {} }));

vi.mock('../utils/logger', () => ({
  logger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

vi.mock('../utils/db-error', () => ({
  formatDbError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

vi.mock('../hcp/index', () => ({ housecallProService: { getEmployees: () => Promise.resolve({ success: false }) } }));
vi.mock('../hcp/webhook-subscriptions', () => ({
  hcpWebhookSubscriptionsService: {
    getWebhookSubscriptions: () => Promise.resolve({ kind: 'inconclusive', reason: 'mocked' }),
  },
}));
vi.mock('../sync/hcp-backfill', () => ({
  runHcpWebhookBackfill: vi.fn(),
  summarizeBackfill: vi.fn(() => ''),
}));
vi.mock('../services/hcp-incident-email', () => ({
  sendHcpIncidentEmail: vi.fn(() => Promise.resolve({ sent: 0, attempted: 0 })),
}));
vi.mock('../services/webhook-incident-notifier', () => ({
  notifyWebhookIncidentOpened: vi.fn(),
  ALERT_THROTTLE_WINDOW_MS: 24 * 60 * 60 * 1000,
}));
vi.mock('../services/webhook-alert-throttle', () => ({
  getLastAlertedAt: vi.fn(() => Promise.resolve(null)),
  stampAlertThrottle: vi.fn(() => Promise.resolve()),
}));

let healthMod: typeof import('../services/hcp-webhook-health');
let notifierMod: typeof import('../services/webhook-incident-notifier');

beforeEach(async () => {
  insertCalls.length = 0;
  vi.resetModules();
  healthMod = await import('../services/hcp-webhook-health');
  notifierMod = await import('../services/webhook-incident-notifier');
  healthMod.__resetDbDegradedStateForTests();
  (notifierMod.notifyWebhookIncidentOpened as ReturnType<typeof vi.fn>).mockClear();
});

describe('Task #788 — DB-unreachable suppression', () => {
  it('classifies a Neon pool acquire timeout as DB-unreachable and does NOT open an incident', async () => {
    // Force the per-contractor check to throw the well-known pool-acquire
    // timeout message that production was seeing every 5 minutes.
    const original = await import('../services/hcp-webhook-health');
    // We can't easily monkey-patch checkContractorHealth directly because
    // it's not exported. Instead, trigger via the `db.select` chain
    // raising the timeout error.
    const dbMod = await import('../db');
    (dbMod.db as { select: unknown }).select = () => ({
      from: () => ({
        where: () => ({
          limit: () => {
            // First call (enabledIntegrations fetch) succeeds.
            (dbMod.db as { select: unknown }).select = () => ({
              from: () => ({
                where: () => {
                  throw new Error('timeout exceeded when trying to connect');
                },
              }),
            });
            return Promise.resolve(integrationsRows);
          },
        }),
      }),
    });

    await original.checkHcpWebhookHealth();

    // No `health-check-failure` incident was opened, no notify call.
    const incidentInserts = insertCalls.filter(c =>
      JSON.stringify(c.values).includes('health-check-failure'),
    );
    expect(incidentInserts).toHaveLength(0);
    expect(notifierMod.notifyWebhookIncidentOpened).not.toHaveBeenCalled();

    // The degraded flag is set for the contractor.
    expect(original.isCheckerDegradedByDb('contractor-1')).toBe(true);
  });

  it('isCheckerDegradedByDb returns false for unknown contractors', async () => {
    expect(healthMod.isCheckerDegradedByDb('never-seen')).toBe(false);
  });
});
