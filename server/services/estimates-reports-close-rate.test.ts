import { describe, it, expect, vi, beforeEach } from 'vitest';

const executeMock = vi.fn();
vi.mock('../db', () => ({ db: { execute: (...args: any[]) => executeMock(...args) } }));

import { getCloseRateBySalesperson, getCloseRateBySource } from './estimates-reports';

const filters = {
  startDate: new Date('2026-01-01T00:00:00Z'),
  endDate: new Date('2026-05-01T00:00:00Z'),
};

beforeEach(() => {
  executeMock.mockReset();
});

describe('getCloseRate (won / sent formula)', () => {
  it('computes per-row and total close rate as won / sent', async () => {
    executeMock.mockResolvedValueOnce({
      rows: [
        {
          rows: [
            { key: 'u1', name: 'Alice', sent: 150, won: 37, lost: 28, open: 85 },
            { key: 'u2', name: 'Bob', sent: 10, won: 3, lost: 2, open: 5 },
          ],
          totals: { sent: 160, won: 40, lost: 30, open: 90 },
        },
      ],
    });
    const result = await getCloseRateBySalesperson('tenant-1', filters);
    expect(result.rows[0].closeRate).toBe(24.7);
    expect(result.rows[1].closeRate).toBe(30);
    expect(result.totals.closeRate).toBe(25);
    expect(result.totals.sent).toBe(160);
    expect(result.totals.won).toBe(40);
  });

  it('returns 0 close rate when sent = 0', async () => {
    executeMock.mockResolvedValueOnce({
      rows: [
        {
          rows: [{ key: 'u1', name: 'Alice', sent: 0, won: 0, lost: 0, open: 0 }],
          totals: { sent: 0, won: 0, lost: 0, open: 0 },
        },
      ],
    });
    const result = await getCloseRateBySalesperson('tenant-1', filters);
    expect(result.rows[0].closeRate).toBe(0);
    expect(result.totals.closeRate).toBe(0);
  });

  it('counts open estimates against the rate (10 sent / 3 won / 2 lost / 5 open => 30%)', async () => {
    executeMock.mockResolvedValueOnce({
      rows: [
        {
          rows: [{ key: 'u1', name: 'Alice', sent: 10, won: 3, lost: 2, open: 5 }],
          totals: { sent: 10, won: 3, lost: 2, open: 5 },
        },
      ],
    });
    const result = await getCloseRateBySalesperson('tenant-1', filters);
    expect(result.rows[0].closeRate).toBe(30);
    expect(result.totals.closeRate).toBe(30);
  });

  it('applies the same formula for the by-source variant', async () => {
    executeMock.mockResolvedValueOnce({
      rows: [
        {
          rows: [{ key: 'google', name: 'Google', sent: 50, won: 10, lost: 5, open: 35 }],
          totals: { sent: 50, won: 10, lost: 5, open: 35 },
        },
      ],
    });
    const result = await getCloseRateBySource('tenant-1', filters);
    expect(result.rows[0].closeRate).toBe(20);
    expect(result.totals.closeRate).toBe(20);
  });
});
