// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

// Task #902: the workflow Send SMS "From" picker must be sourced from the
// provider-agnostic aggregated endpoint (Dialpad + Twilio merged), going
// through apiRequest so bearer-fallback auth still works in PWAs.
const apiRequestMock = vi.fn();
vi.mock('@/lib/queryClient', () => ({
  apiRequest: (...args: unknown[]) => apiRequestMock(...args),
}));

import { useAvailableFromNumbers } from './useAvailableFromNumbers';

const mergedNumbers = [
  { id: 'dp-1', phoneNumber: '+15551110001', displayName: 'Dialpad Main' },
  { id: 'tw-1', phoneNumber: '+15552220002', displayName: 'Twilio Office' },
];

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('useAvailableFromNumbers', () => {
  it('fetches merged Dialpad + Twilio numbers from the provider-agnostic endpoint via apiRequest', async () => {
    apiRequestMock.mockResolvedValue({ json: async () => mergedNumbers });

    const { result } = renderHook(() => useAvailableFromNumbers('sms', true), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(apiRequestMock).toHaveBeenCalledWith('GET', '/api/messages/available-from-numbers?action=sms');
    expect(result.current.data).toEqual(mergedNumbers);
    expect(result.current.data?.map((n) => n.displayName)).toEqual(['Dialpad Main', 'Twilio Office']);
  });

  it('does not fetch when disabled (non-admin / dialog closed)', async () => {
    apiRequestMock.mockClear();
    const { result } = renderHook(() => useAvailableFromNumbers('sms', false), { wrapper });
    expect(result.current.fetchStatus).toBe('idle');
    expect(apiRequestMock).not.toHaveBeenCalled();
  });
});
