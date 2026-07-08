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
  getWorkflowStepsCached,
  invalidateWorkflowStepsCache,
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
      googleCalendarConnected: false,
      googleCalendarEmail: undefined,
      passkeyCount: 0,
      passkeyPromptDismissedAt: null,
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
      googleCalendarConnected: false,
      googleCalendarEmail: undefined,
      passkeyCount: 0,
      passkeyPromptDismissedAt: null,
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

  it('getWorkflowStepsCached: step update + invalidation makes the very next fetch return new steps (no 5-minute staleness)', async () => {
    const oldSteps = [{ id: 's1', workflowId: 'w1', actionType: 'send_sms', actionConfig: '{"message":"OLD text"}', stepOrder: 0 }];
    const newSteps = [{ id: 's1', workflowId: 'w1', actionType: 'send_sms', actionConfig: '{"message":"NEW text"}', stepOrder: 0 }];
    (storage.getWorkflowSteps as any).mockResolvedValue(oldSteps);

    // Prime the cache (simulates a workflow run reading steps).
    const a = await getWorkflowStepsCached('w1');
    expect(a).toEqual(oldSteps);

    // Without invalidation, the cache serves the stale copy.
    (storage.getWorkflowSteps as any).mockResolvedValue(newSteps);
    const stale = await getWorkflowStepsCached('w1');
    expect(stale).toEqual(oldSteps);
    expect(storage.getWorkflowSteps).toHaveBeenCalledTimes(1);

    // After a step save calls invalidateWorkflowStepsCache, the very next
    // fetch hits the DB and returns the updated steps.
    invalidateWorkflowStepsCache('w1');
    const fresh = await getWorkflowStepsCached('w1');
    expect(fresh).toEqual(newSteps);
    expect(storage.getWorkflowSteps).toHaveBeenCalledTimes(2);

    // Invalidation is scoped: another workflow's cache entry is untouched.
    (storage.getWorkflowSteps as any).mockResolvedValue([{ id: 'x', workflowId: 'w2', stepOrder: 0 }]);
    await getWorkflowStepsCached('w2');
    invalidateWorkflowStepsCache('w1');
    await getWorkflowStepsCached('w2');
    expect(storage.getWorkflowSteps).toHaveBeenCalledTimes(3);
  });

  it('getUserContractorsWithDetailsCached: empty memberships short-circuit', async () => {
    (storage.getUserContractors as any).mockResolvedValue([]);
    const a = await getUserContractorsWithDetailsCached('u-empty');
    expect(a).toEqual([]);
    expect(storage.getContractorsByIds).not.toHaveBeenCalled();
  });
});
