import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../storage', () => {
  const storage: any = {
    getUserContractor: vi.fn(),
    getUserContractors: vi.fn(),
    getContractor: vi.fn(),
    getContractorsByIds: vi.fn(),
    getTerminologySettings: vi.fn(),
    getBusinessTargets: vi.fn(),
    getUser: vi.fn(),
    getEnabledIntegrations: vi.fn(),
    getWorkflowSteps: vi.fn(),
    isIntegrationEnabled: vi.fn(),
    getContact: vi.fn(),
  };
  return { storage };
});

vi.mock('../credential-service', () => ({
  CredentialService: { getCredential: vi.fn() },
}));

import { storage } from '../storage';
import {
  getContractorCached,
  getUserSupplementalCached,
  getUserContractorsWithDetailsCached,
  getEnabledIntegrationsCached,
  invalidateUserCache,
  invalidateContractorCache,
  cacheInvalidation,
} from './cache';

describe('cache service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cacheInvalidation.clearAll();
  });

  afterEach(() => {
    cacheInvalidation.clearAll();
  });

  it('getContractorCached: hit/miss + invalidation', async () => {
    (storage.getContractor as any).mockResolvedValue({ id: 'c1', name: 'Acme' });

    const a = await getContractorCached('c1');
    const b = await getContractorCached('c1');
    expect(a).toEqual({ id: 'c1', name: 'Acme' });
    expect(b).toEqual({ id: 'c1', name: 'Acme' });
    expect(storage.getContractor).toHaveBeenCalledTimes(1);

    invalidateContractorCache('c1');
    (storage.getContractor as any).mockResolvedValue({ id: 'c1', name: 'Acme 2' });
    const c = await getContractorCached('c1');
    expect(c).toEqual({ id: 'c1', name: 'Acme 2' });
    expect(storage.getContractor).toHaveBeenCalledTimes(2);
  });

  it('getUserSupplementalCached: maps fields, caches, and invalidates', async () => {
    (storage.getUser as any).mockResolvedValue({
      id: 'u1',
      dialpadDefaultNumber: '+15551234567',
      gmailConnected: true,
      gmailEmail: 'u@example.com',
    });

    const a = await getUserSupplementalCached('u1');
    expect(a).toEqual({
      dialpadDefaultNumber: '+15551234567',
      gmailConnected: true,
      gmailEmail: 'u@example.com',
    });
    await getUserSupplementalCached('u1');
    expect(storage.getUser).toHaveBeenCalledTimes(1);

    invalidateUserCache('u1');
    (storage.getUser as any).mockResolvedValue({
      id: 'u1',
      dialpadDefaultNumber: null,
      gmailConnected: false,
      gmailEmail: null,
    });
    const b = await getUserSupplementalCached('u1');
    expect(b).toEqual({
      dialpadDefaultNumber: undefined,
      gmailConnected: false,
      gmailEmail: undefined,
    });
    expect(storage.getUser).toHaveBeenCalledTimes(2);
  });

  it('getUserSupplementalCached: returns null when user is missing', async () => {
    (storage.getUser as any).mockResolvedValue(undefined);
    const result = await getUserSupplementalCached('missing');
    expect(result).toBeNull();
  });

  it('getEnabledIntegrationsCached: caches and is invalidated by contractor invalidation', async () => {
    (storage.getEnabledIntegrations as any).mockResolvedValue([{ id: 'i1' }]);

    const a = await getEnabledIntegrationsCached('c1');
    const b = await getEnabledIntegrationsCached('c1');
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(storage.getEnabledIntegrations).toHaveBeenCalledTimes(1);

    invalidateContractorCache('c1');
    (storage.getEnabledIntegrations as any).mockResolvedValue([]);
    const c = await getEnabledIntegrationsCached('c1');
    expect(c).toHaveLength(0);
    expect(storage.getEnabledIntegrations).toHaveBeenCalledTimes(2);
  });

  it('getEnabledIntegrationsCached: swallows errors and returns []', async () => {
    (storage.getEnabledIntegrations as any).mockRejectedValue(new Error('boom'));
    const a = await getEnabledIntegrationsCached('c-err');
    expect(a).toEqual([]);
  });

  it('getUserContractorsWithDetailsCached: joins memberships with contractors and invalidates per user', async () => {
    (storage.getUserContractors as any).mockResolvedValue([
      { userId: 'u1', contractorId: 'c1', role: 'admin' },
      { userId: 'u1', contractorId: 'c2', role: 'user' },
    ]);
    (storage.getContractorsByIds as any).mockResolvedValue([
      { id: 'c1', name: 'Acme' },
      { id: 'c2', name: 'Globex' },
    ]);

    const a = await getUserContractorsWithDetailsCached('u1');
    expect(a).toHaveLength(2);
    expect(a[0].contractor?.name).toBe('Acme');

    await getUserContractorsWithDetailsCached('u1');
    expect(storage.getUserContractors).toHaveBeenCalledTimes(1);

    invalidateUserCache('u1');
    await getUserContractorsWithDetailsCached('u1');
    expect(storage.getUserContractors).toHaveBeenCalledTimes(2);
  });

  it('getUserContractorsWithDetailsCached: empty memberships short-circuit', async () => {
    (storage.getUserContractors as any).mockResolvedValue([]);
    const a = await getUserContractorsWithDetailsCached('u-empty');
    expect(a).toEqual([]);
    expect(storage.getContractorsByIds).not.toHaveBeenCalled();
  });
});
