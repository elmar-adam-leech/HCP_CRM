import { describe, it, expect, vi, beforeEach } from 'vitest';

// db must be mocked before the module under test imports it.
vi.mock('../db', () => {
  const chain = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([]),
  };
  return { db: chain };
});

import { db } from '../db';
import { buildHcpLineItems, resolveSalespersonForHcpEntity } from '../sync/hcp-mappers';

describe('buildHcpLineItems', () => {
  it('returns undefined when no line items are present anywhere', () => {
    expect(buildHcpLineItems({})).toBeUndefined();
    expect(buildHcpLineItems(null)).toBeUndefined();
    expect(buildHcpLineItems({ line_items: [] })).toBeUndefined();
  });

  it('converts cents to dollars for unit_price and total', () => {
    const result = buildHcpLineItems({
      line_items: [{ id: 'li1', name: 'Labor', unit_price: 12500, total: 25000, quantity: 2, kind: 'labor' }],
    });
    expect(result).toEqual([
      expect.objectContaining({ id: 'li1', name: 'Labor', unit_price: 125, total: 250, quantity: 2, kind: 'labor' }),
    ]);
  });

  it('drops line items missing both id and name', () => {
    const result = buildHcpLineItems({
      line_items: [
        { id: 'good', name: 'OK', total: 1000 },
        { name: 'no-id' } as any,
        { id: 'no-name' } as any,
      ],
    });
    expect(result).toHaveLength(1);
    expect(result?.[0].id).toBe('good');
  });

  it('filters unknown kind enum values to undefined', () => {
    const r = buildHcpLineItems({
      line_items: [{ id: 'a', name: 'A', kind: 'bogus_kind', total: 100 }],
    });
    expect(r?.[0].kind).toBeUndefined();
  });

  it('flattens line items from estimate options', () => {
    const r = buildHcpLineItems({
      options: [
        { line_items: [{ id: 'o1-l1', name: 'Opt1 Item', total: 500 }] },
        { line_items: [{ id: 'o2-l1', name: 'Opt2 Item', total: 700 }] },
      ],
    });
    expect(r).toHaveLength(2);
    expect(r?.map(li => li.id)).toEqual(['o1-l1', 'o2-l1']);
  });
});

describe('resolveSalespersonForHcpEntity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (db.select as any).mockReturnValue({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([]),
    });
  });

  it('returns null when no employee id is present', async () => {
    const r = await resolveSalespersonForHcpEntity('t1', { assigned_employees: [] });
    expect(r).toBeNull();
  });

  it('returns null when entity is null/undefined', async () => {
    expect(await resolveSalespersonForHcpEntity('t1', null)).toBeNull();
    expect(await resolveSalespersonForHcpEntity('t1', undefined)).toBeNull();
  });

  it('returns null when employee row has no userContractorId', async () => {
    (db.select as any).mockReturnValueOnce({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([{ userContractorId: null }]),
    });
    const r = await resolveSalespersonForHcpEntity('t1', { assigned_employees: [{ id: 'emp_1' }] });
    expect(r).toBeNull();
  });

  it('follows employees → user_contractors → users.id chain when linked', async () => {
    // First call: employees lookup
    (db.select as any).mockReturnValueOnce({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([{ userContractorId: 'uc_1' }]),
    });
    // Second call: userContractors lookup
    (db.select as any).mockReturnValueOnce({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([{ userId: 'user_42' }]),
    });
    const r = await resolveSalespersonForHcpEntity('t1', { assigned_employees: [{ id: 'emp_1' }] });
    expect(r).toBe('user_42');
  });

  it('swallows DB errors and returns null instead of failing sync', async () => {
    (db.select as any).mockReturnValueOnce({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockRejectedValue(new Error('boom')),
    });
    const r = await resolveSalespersonForHcpEntity('t1', { employee_id: 'emp_x' });
    expect(r).toBeNull();
  });
});
