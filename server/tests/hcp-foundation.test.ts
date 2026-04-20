import { describe, it, expect, vi } from 'vitest';

// Mock storage + db so the modules under test don't try to touch the
// database. Only the pure helpers are exercised here.
vi.mock('../db', () => ({ db: {} }));
vi.mock('../storage', () => ({ storage: {} }));
vi.mock('../hcp/index', () => ({ housecallProService: {} }));

import { buildHcpOptions } from '../sync/hcp-estimates';
import { pickLatestPayment } from '../routes/webhooks/housecall-pro/handlers/jobs';

describe('buildHcpOptions approval timestamp diff', () => {
  it('stamps approval_status_changed_at when an option transitions from pending → approved', () => {
    const now = new Date('2026-04-19T10:00:00.000Z');
    const result = buildHcpOptions(
      { id: 'e1', options: [{ id: 'opt1', approval_status: 'approved' }] } as any,
      [{ id: 'opt1', approval_status: 'pending', approval_status_changed_at: null }],
      now,
    );
    expect(result?.[0].approval_status_changed_at).toBe(now.toISOString());
  });

  it('preserves existing timestamp when status is unchanged', () => {
    const previous = '2026-01-01T00:00:00.000Z';
    const now = new Date('2026-04-19T10:00:00.000Z');
    const result = buildHcpOptions(
      { id: 'e1', options: [{ id: 'opt1', approval_status: 'approved' }] } as any,
      [{ id: 'opt1', approval_status: 'approved', approval_status_changed_at: previous }],
      now,
    );
    expect(result?.[0].approval_status_changed_at).toBe(previous);
  });

  it('does not stamp pending → pending', () => {
    const result = buildHcpOptions(
      { id: 'e1', options: [{ id: 'opt1', approval_status: 'pending' }] } as any,
      null,
      new Date('2026-04-19T10:00:00.000Z'),
    );
    expect(result?.[0].approval_status_changed_at).toBeNull();
  });

  it('only stamps the option whose status flipped, not its siblings', () => {
    const now = new Date('2026-04-19T10:00:00.000Z');
    const result = buildHcpOptions(
      {
        id: 'e1',
        options: [
          { id: 'a', approval_status: 'approved' },
          { id: 'b', approval_status: 'pending' },
        ],
      } as any,
      [
        { id: 'a', approval_status: 'pending', approval_status_changed_at: null },
        { id: 'b', approval_status: 'pending', approval_status_changed_at: null },
      ],
      now,
    );
    expect(result?.find(o => o.id === 'a')?.approval_status_changed_at).toBe(now.toISOString());
    expect(result?.find(o => o.id === 'b')?.approval_status_changed_at).toBeNull();
  });
});

describe('buildHcpOptions timestamp advancement semantics', () => {
  it('uses the supplied "now" for newly-decided options (simulating webhook occurred_at)', () => {
    const occurredAt = new Date('2026-04-19T08:30:00.000Z');
    const result = buildHcpOptions(
      { id: 'e1', options: [{ id: 'opt1', approval_status: 'rejected' }] } as any,
      [{ id: 'opt1', approval_status: 'pending', approval_status_changed_at: null }],
      occurredAt,
    );
    // The webhook timestamp wins over wall-clock time so the recorded
    // approval_status_changed_at matches when HCP saw the change.
    expect(result?.[0].approval_status_changed_at).toBe(occurredAt.toISOString());
  });

  it('does not regress an existing approval timestamp on subsequent unchanged syncs', () => {
    const original = '2026-04-19T08:30:00.000Z';
    // First webhook stamped the change at 08:30. A later sync at 12:00 with
    // the same approval_status must NOT overwrite the original timestamp.
    const result = buildHcpOptions(
      { id: 'e1', options: [{ id: 'opt1', approval_status: 'approved' }] } as any,
      [{ id: 'opt1', approval_status: 'approved', approval_status_changed_at: original }],
      new Date('2026-04-19T12:00:00.000Z'),
    );
    expect(result?.[0].approval_status_changed_at).toBe(original);
  });
});

describe('pickLatestPayment', () => {
  it('returns null for no payments', () => {
    expect(pickLatestPayment(undefined)).toBeNull();
    expect(pickLatestPayment([])).toBeNull();
  });

  it('returns the latest payment by created_at', () => {
    const payments = [
      { id: 'p1', amount: 1000, created_at: '2026-01-01T00:00:00.000Z' },
      { id: 'p2', amount: 5000, created_at: '2026-04-01T00:00:00.000Z' },
      { id: 'p3', amount: 2000, created_at: '2026-02-01T00:00:00.000Z' },
    ];
    expect(pickLatestPayment(payments)?.id).toBe('p2');
  });

  it('falls back to paid_at when created_at is missing', () => {
    const payments = [
      { id: 'p1', amount: 1000, paid_at: '2026-04-01T00:00:00.000Z' },
      { id: 'p2', amount: 5000, paid_at: '2026-01-01T00:00:00.000Z' },
    ];
    expect(pickLatestPayment(payments)?.id).toBe('p1');
  });
});
