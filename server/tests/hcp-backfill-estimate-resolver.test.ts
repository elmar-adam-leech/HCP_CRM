import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock db so backfillEstimateSalespeople can be exercised without a real DB.
vi.mock('../db', () => {
  const dbMock: any = {
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
  };
  return { db: dbMock };
});

// Mock the HCP service so the test controls what live HCP data the resolver
// path sees during backfill.
vi.mock('../hcp/index', () => ({
  housecallProService: {
    getEstimate: vi.fn(),
  },
}));

import { db } from '../db';
import { housecallProService } from '../hcp/index';
import { backfillEstimateSalespeople } from '../sync/hcp-backfill-foundation';

describe('backfillEstimateSalespeople routes through the multi-assignee resolver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes the user whose most recent prior estimate is latest, not the first listed assignee', async () => {
    // 1) Initial scan: one estimate row with no salesperson yet.
    (db.select as any).mockReturnValueOnce({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([
        {
          id: 'est_1',
          externalId: 'hcp_est_1',
          externalSource: 'housecall-pro',
          scheduledEmployeeId: null,
        },
      ]),
    });

    // 2) HCP returns a live estimate with two assigned employees.
    (housecallProService.getEstimate as any).mockResolvedValue({
      success: true,
      data: { assigned_employees: [{ id: 'emp_a' }, { id: 'emp_b' }] },
    });

    // 3) Resolver: batch employees lookup
    (db.select as any).mockReturnValueOnce({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([
        { externalId: 'emp_a', userContractorId: 'uc_a' },
        { externalId: 'emp_b', userContractorId: 'uc_b' },
      ]),
    });
    // 4) Resolver: batch userContractors lookup
    (db.select as any).mockReturnValueOnce({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([
        { id: 'uc_a', userId: 'user_a' },
        { id: 'uc_b', userId: 'user_b' },
      ]),
    });
    // 5) Resolver: tiebreak — user_b's most recent estimate is newer.
    (db.select as any).mockReturnValueOnce({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      groupBy: vi.fn().mockResolvedValue([
        { salespersonUserId: 'user_a', lastAt: new Date('2024-01-01T00:00:00Z') },
        { salespersonUserId: 'user_b', lastAt: new Date('2025-06-01T00:00:00Z') },
      ]),
    });

    // 6) Final UPDATE — capture the value being written.
    const setSpy = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    (db.update as any).mockReturnValue({ set: setSpy });

    const updated = await backfillEstimateSalespeople('t1');

    expect(updated).toBe(1);
    expect(housecallProService.getEstimate).toHaveBeenCalledWith('t1', 'hcp_est_1');
    expect(setSpy).toHaveBeenCalledWith({ salespersonUserId: 'user_b' });
  });
});
