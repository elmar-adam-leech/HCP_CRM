import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const notifications = new Proxy({}, { get: (_target, property) => String(property) });
  return {
    notifications,
    selectResults: [] as Array<Array<{ id: string }>>,
    getContractorUsers: vi.fn(),
    createNotification: vi.fn(),
    db: {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(() => Promise.resolve(h.selectResults.shift() ?? [])),
          })),
        })),
      })),
    },
  };
});

vi.mock('@shared/schema', () => ({ notifications: h.notifications }));
vi.mock('../db', () => ({ db: h.db }));
vi.mock('../storage', () => ({
  storage: {
    getContractorUsers: h.getContractorUsers,
    createNotification: h.createNotification,
  },
}));
vi.mock('drizzle-orm', () => ({
  and: vi.fn(),
  eq: vi.fn(),
}));

import { notifyLeadIdentityAmbiguity } from './lead-identity-ambiguity';

beforeEach(() => {
  vi.clearAllMocks();
  h.selectResults = [];
  h.getContractorUsers.mockResolvedValue([
    { userId: 'admin-1', role: 'admin' },
    { userId: 'manager-1', role: 'manager' },
    { userId: 'staff-1', role: 'user' },
  ]);
  h.createNotification.mockResolvedValue({ id: 'notification-1' });
});

describe('notifyLeadIdentityAmbiguity', () => {
  it('notifies only people who can resolve duplicate contacts', async () => {
    h.selectResults = [[], []];
    const error = Object.assign(new Error('Resolve duplicate contacts and retry.'), {
      code: 'LEAD_IDENTITY_AMBIGUOUS',
    });

    await notifyLeadIdentityAmbiguity('tenant-1', 'Facebook', 'lead-1', error);

    expect(h.createNotification).toHaveBeenCalledTimes(2);
    expect(h.createNotification).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'admin-1',
      title: 'Lead needs duplicate-contact review',
      link: '/leads',
    }), 'tenant-1');
    expect(h.createNotification).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'manager-1',
      message: expect.stringContaining('Resolve duplicate contacts and retry.'),
    }), 'tenant-1');
  });

  it('does not flood recipients while the same unresolved notification remains unread', async () => {
    h.selectResults = [[{ id: 'existing-admin' }], [{ id: 'existing-manager' }]];

    await notifyLeadIdentityAmbiguity(
      'tenant-1',
      'email-capture',
      'gmail-message-1',
      new Error('Resolve duplicate contacts and retry.'),
    );

    expect(h.createNotification).not.toHaveBeenCalled();
  });
});