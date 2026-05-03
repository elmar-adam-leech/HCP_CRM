// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { createRef } from 'react';
import { render, fireEvent, act } from '@testing-library/react';
import { AddressAutocomplete, type AddressAutocompleteRef } from './AddressAutocomplete';

const TYPED = '987 Oak Ave Shelbyville';
const RESOLVED = '987 Oak Avenue, Shelbyville, IL 62565, USA';

const SUGGESTION_RESPONSE = {
  suggestions: [
    {
      placePrediction: {
        placeId: 'place-987-oak',
        text: { text: '987 Oak Avenue, Shelbyville, IL, USA' },
      },
    },
  ],
};

const DETAILS_RESPONSE = {
  formattedAddress: RESOLVED,
  addressComponents: [
    { types: ['street_number'], longText: '987' },
    { types: ['route'], longText: 'Oak Avenue' },
    { types: ['locality'], longText: 'Shelbyville' },
    { types: ['administrative_area_level_1'], shortText: 'IL' },
    { types: ['postal_code'], longText: '62565' },
  ],
};

interface MockResponses {
  autocomplete?: unknown;
  details?: unknown | '__error__';
}

function makeFetch(routeMap: MockResponses) {
  return vi.fn(async (url: string) => {
    const u = new URL(url, 'http://localhost');
    if (u.pathname.endsWith('/autocomplete')) {
      return { ok: true, json: async () => routeMap.autocomplete ?? SUGGESTION_RESPONSE } as Response;
    }
    if (u.pathname.endsWith('/details')) {
      const detailsValue = routeMap.details;
      if (detailsValue === '__error__') {
        return { ok: false, json: async () => ({}) } as Response;
      }
      return { ok: true, json: async () => detailsValue ?? DETAILS_RESPONSE } as Response;
    }
    return { ok: false, json: async () => ({}) } as Response;
  });
}

interface WrapperProps {
  initial?: string;
  onChange: (v: string) => void;
  onAddressSelect: (formatted: string, components: unknown) => void;
  refObj: React.Ref<AddressAutocompleteRef>;
}

function Wrapper({ initial = '', onChange, onAddressSelect, refObj }: WrapperProps) {
  return React.createElement(AddressAutocomplete, {
    ref: refObj,
    value: initial,
    onChange,
    onAddressSelect,
    endpoint: '/api/places',
    'data-testid': 'addr',
  });
}

describe('AddressAutocomplete.resolvePending', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('typed-without-pick: resolvePending() fetches suggestions + details and emits structured components', async () => {
    const fetchMock = makeFetch({});
    vi.stubGlobal('fetch', fetchMock);

    const onChange = vi.fn();
    const onAddressSelect = vi.fn();
    const ref = createRef<AddressAutocompleteRef>();

    const { getByTestId, rerender } = render(
      React.createElement(Wrapper, { initial: '', onChange, onAddressSelect, refObj: ref }),
    );

    const input = getByTestId('addr') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: TYPED } });
    });
    rerender(React.createElement(Wrapper, { initial: TYPED, onChange, onAddressSelect, refObj: ref }));

    let result: Awaited<ReturnType<AddressAutocompleteRef['resolvePending']>> | undefined;
    await act(async () => {
      result = await ref.current!.resolvePending();
    });

    expect(result).toBeDefined();
    expect(result!.formatted).toBe(RESOLVED);
    expect(result!.components).toEqual({
      street: '987 Oak Avenue',
      city: 'Shelbyville',
      state: 'IL',
      zip: '62565',
      country: 'US',
    });
    expect(onAddressSelect).toHaveBeenCalledWith(RESOLVED, result!.components);

    const calledUrls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(calledUrls.some((u) => u.includes('/autocomplete'))).toBe(true);
    expect(calledUrls.some((u) => u.includes('/details'))).toBe(true);
  });

  it('blur auto-resolves typed-without-pick addresses', async () => {
    const fetchMock = makeFetch({});
    vi.stubGlobal('fetch', fetchMock);

    const onChange = vi.fn();
    const onAddressSelect = vi.fn();
    const ref = createRef<AddressAutocompleteRef>();

    const { getByTestId, rerender } = render(
      React.createElement(Wrapper, { initial: '', onChange, onAddressSelect, refObj: ref }),
    );

    const input = getByTestId('addr') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: TYPED } });
    });
    rerender(React.createElement(Wrapper, { initial: TYPED, onChange, onAddressSelect, refObj: ref }));

    await act(async () => {
      fireEvent.blur(input);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onAddressSelect).toHaveBeenCalledTimes(1);
    const [, components] = onAddressSelect.mock.calls[0];
    expect(components).toMatchObject({ street: '987 Oak Avenue', city: 'Shelbyville', state: 'IL', zip: '62565' });
  });

  it('Places details failure: resolvePending returns the fallback (street-only) result without throwing', async () => {
    const fetchMock = makeFetch({ details: '__error__' });
    vi.stubGlobal('fetch', fetchMock);

    const onChange = vi.fn();
    const onAddressSelect = vi.fn();
    const ref = createRef<AddressAutocompleteRef>();

    const { getByTestId, rerender } = render(
      React.createElement(Wrapper, { initial: '', onChange, onAddressSelect, refObj: ref }),
    );
    const input = getByTestId('addr') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: TYPED } });
    });
    rerender(React.createElement(Wrapper, { initial: TYPED, onChange, onAddressSelect, refObj: ref }));

    let result: Awaited<ReturnType<AddressAutocompleteRef['resolvePending']>> | undefined;
    await act(async () => {
      result = await ref.current!.resolvePending();
    });

    // Even on details failure the helper still returns *something* and emits
    // it so the parent can decide what to do — but the city/state/zip will
    // be blank. The server-side Places fallback fills them in.
    expect(result).toBeDefined();
    expect(result!.components.city).toBe('');
    expect(result!.components.state).toBe('');
    expect(result!.components.zip).toBe('');
    expect(onAddressSelect).toHaveBeenCalledTimes(1);
  });

  it('short-circuits on a second call when the input has not changed', async () => {
    const fetchMock = makeFetch({});
    vi.stubGlobal('fetch', fetchMock);

    const onChange = vi.fn();
    const onAddressSelect = vi.fn();
    const ref = createRef<AddressAutocompleteRef>();

    const { getByTestId, rerender } = render(
      React.createElement(Wrapper, { initial: '', onChange, onAddressSelect, refObj: ref }),
    );
    const input = getByTestId('addr') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: TYPED } });
    });
    rerender(React.createElement(Wrapper, { initial: TYPED, onChange, onAddressSelect, refObj: ref }));

    await act(async () => {
      await ref.current!.resolvePending();
    });
    rerender(React.createElement(Wrapper, { initial: RESOLVED, onChange, onAddressSelect, refObj: ref }));

    onAddressSelect.mockClear();
    fetchMock.mockClear();

    await act(async () => {
      await ref.current!.resolvePending();
    });
    expect(onAddressSelect).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns undefined for inputs shorter than 3 chars', async () => {
    const fetchMock = makeFetch({});
    vi.stubGlobal('fetch', fetchMock);

    const onChange = vi.fn();
    const onAddressSelect = vi.fn();
    const ref = createRef<AddressAutocompleteRef>();

    const { getByTestId, rerender } = render(
      React.createElement(Wrapper, { initial: '', onChange, onAddressSelect, refObj: ref }),
    );
    const input = getByTestId('addr') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: 'ab' } });
    });
    rerender(React.createElement(Wrapper, { initial: 'ab', onChange, onAddressSelect, refObj: ref }));

    let result: Awaited<ReturnType<AddressAutocompleteRef['resolvePending']>> | undefined;
    await act(async () => {
      result = await ref.current!.resolvePending();
    });
    expect(result).toBeUndefined();
    expect(onAddressSelect).not.toHaveBeenCalled();
  });
});
