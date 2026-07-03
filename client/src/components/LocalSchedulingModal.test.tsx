// @vitest-environment jsdom
/**
 * UI coverage for internal flexible scheduling (task #859 → #871).
 *
 * The staff-facing scheduling modal must render times that overlap an existing
 * appointment with an inline "Booked" badge AND keep them selectable, then
 * submit a booking for the chosen (conflicting) time. This test drives the
 * modal against a mocked /api/scheduling/day-slots response containing one
 * conflicting slot and asserts it can be picked and submitted.
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// --- jsdom polyfills required by Radix Select / react-day-picker -----------
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  (Element.prototype as any).hasPointerCapture = vi.fn(() => false);
  (Element.prototype as any).releasePointerCapture = vi.fn();
  (Element.prototype as any).setPointerCapture = vi.fn();
  (window as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  if (!window.matchMedia) {
    (window as any).matchMedia = () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
    });
  }
});

// --- mock the network layer ------------------------------------------------

const apiRequestMock = vi.fn();
vi.mock('@/lib/queryClient', () => ({
  apiRequest: (...args: unknown[]) => apiRequestMock(...args),
}));

// Toasts / address autocomplete / day-schedule panel are not under test here.
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/components/DaySchedulePanel', () => ({ DaySchedulePanel: () => null }));
vi.mock('@/components/ui/AddressAutocomplete', () => ({
  AddressAutocomplete: ({ value }: { value?: string }) => (
    <input data-testid="input-schedule-address" defaultValue={value} />
  ),
  AddressComponents: {},
  AddressAutocompleteRef: {},
}));

import { LocalSchedulingModal } from './LocalSchedulingModal';

const SALESPERSON = {
  userId: 'sp-1',
  name: 'Pat Salesperson',
  email: 'pat@example.com',
  housecallProUserId: null,
  lastAssignmentAt: null,
  calendarColor: null,
  isSalesperson: true,
  workingDays: [0, 1, 2, 3, 4, 5, 6],
  workingHoursStart: '08:00',
  workingHoursEnd: '17:00',
  hasCustomSchedule: false,
};

// One free slot and one conflicting ("Booked") slot, in the local timezone so
// the modal's Date#getHours() formatting is deterministic regardless of the
// machine tz.
function daySlotsResponse() {
  return {
    date: '2099-01-02',
    slotDurationMinutes: 60,
    bufferMinutes: 30,
    slots: [
      { start: '2099-01-02T09:00:00', end: '2099-01-02T10:00:00', conflict: false },
      { start: '2099-01-02T10:00:00', end: '2099-01-02T11:00:00', conflict: true },
    ],
  };
}

const LEAD = {
  id: 'lead-1',
  name: 'Jamie Customer',
  email: 'jamie@example.com',
  phone: '+15555550100',
  address: '123 Main St, Springfield, IL',
} as any;

function renderModal() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  // Seed the salespeople query so no fetch is needed for it.
  queryClient.setQueryData(['/api/scheduling/salespeople'], [SALESPERSON]);
  // Seed the booking-slug query (contractor timezone for the calendar boundary).
  queryClient.setQueryData(['/api/booking-slug'], { timezone: null });

  return render(
    <QueryClientProvider client={queryClient}>
      <LocalSchedulingModal lead={LEAD} isOpen={true} onClose={vi.fn()} onScheduled={vi.fn()} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apiRequestMock.mockReset();
  apiRequestMock.mockImplementation((method: string, url: string) => {
    if (method === 'GET' && url.startsWith('/api/scheduling/day-slots')) {
      return Promise.resolve({ json: async () => daySlotsResponse() });
    }
    // book + contact PATCH both resolve with an empty body.
    return Promise.resolve({ json: async () => ({}) });
  });
});

afterEach(() => cleanup());

describe('LocalSchedulingModal — Booked slot selectable + submits (task #871)', () => {
  it('renders a "Booked" badge on the conflicting slot, lets it be selected, and submits that time', async () => {
    renderModal();

    // 1) Select the salesperson.
    fireEvent.click(await screen.findByTestId('select-salesperson'));
    fireEvent.click(await screen.findByText('Pat Salesperson'));

    // 2) Pick a date. Navigate to next month so every day is in the future
    //    (the current month's earlier days are disabled by the modal), then
    //    click the 15th — a value that never appears as an outside-day.
    fireEvent.click(screen.getByRole('button', { name: /next month/i }));
    fireEvent.click(await screen.findByText('15'));

    // 3) The modal fetches day-slots once both salesperson + date are set.
    await waitFor(() => {
      expect(apiRequestMock).toHaveBeenCalledWith(
        'GET',
        expect.stringContaining('/api/scheduling/day-slots'),
      );
    });

    // 4) Open the time picker.
    fireEvent.click(await screen.findByTestId('select-time-slot'));

    // The conflicting 10:00 slot must show a "Booked" badge (still selectable).
    const bookedBadge = await screen.findByTestId('badge-booked-10:00');
    expect(bookedBadge.textContent).toContain('Booked');

    // 5) Select the Booked slot (click its option row).
    fireEvent.click(screen.getByRole('option', { name: /10:00 - 11:00/ }));

    // 6) Submit the form.
    fireEvent.click(screen.getByTestId('button-confirm-schedule'));

    // The booking POST fires with the chosen conflicting time (10:00 local).
    await waitFor(() => {
      const bookCall = apiRequestMock.mock.calls.find(
        (c) => c[0] === 'POST' && c[1] === '/api/scheduling/book',
      );
      expect(bookCall).toBeDefined();
      const payload = bookCall![2] as { startTime: string };
      expect(new Date(payload.startTime).getHours()).toBe(10);
    });
  });
});
