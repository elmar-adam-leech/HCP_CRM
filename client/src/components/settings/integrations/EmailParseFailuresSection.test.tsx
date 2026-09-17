// @vitest-environment jsdom
import React, { type ReactNode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  apiRequest: vi.fn(),
  invalidateQueries: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@/lib/queryClient", () => ({
  apiRequest: (...args: unknown[]) => mocks.apiRequest(...args),
  queryClient: { invalidateQueries: (...args: unknown[]) => mocks.invalidateQueries(...args) },
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mocks.toast }),
}));

import { EmailParseFailuresSection } from "./EmailParseFailuresSection";

const failure = {
  id: "failure-1",
  inboxId: "inbox-1",
  messageId: "message-1",
  email: {
    from: "customer@example.com",
    subject: "Estimate request",
    body: '<img src=x onerror="alert(1)">\nPlease call me.',
    date: "2025-01-02T10:00:00.000Z",
  },
  errorCode: "AI_PARSE_FAILED",
  errorMessage: "The model did not return usable contact details.",
  attempts: 2,
  failedAt: "2025-01-02T10:01:00.000Z",
  lastAttemptAt: "2025-01-02T10:02:00.000Z",
  resolvedAt: null,
};

function renderSection(queryFn: () => unknown) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { queryFn, retry: false },
      mutations: { retry: false },
    },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return render(<EmailParseFailuresSection />, { wrapper });
}

beforeEach(() => {
  mocks.apiRequest.mockReset();
  mocks.invalidateQueries.mockReset();
  mocks.toast.mockReset();
});

describe("EmailParseFailuresSection", () => {
  it("shows failure details and renders an HTML-looking body only as text", async () => {
    const view = renderSection(async () => ({ entries: [failure], total: 1 }));

    expect(await screen.findByText("Needs review — AI parsing failed")).toBeTruthy();
    expect(screen.getByText("Attempts:").parentElement?.textContent).toContain("2");
    expect(view.container.querySelector("pre")?.textContent).toContain(failure.email.body);
    expect(view.container.querySelector("img")).toBeNull();
    expect(screen.getByText(/did not classify this email as spam or create a lead/)).toBeTruthy();
    expect(screen.getByText(/retried during sync/)).toBeTruthy();
  });

  it("retries successfully and invalidates related data", async () => {
    mocks.apiRequest.mockResolvedValue({ json: async () => ({ success: true, processed: 1 }) });
    renderSection(async () => ({ entries: [failure], total: 1 }));

    fireEvent.click(await screen.findByTestId("button-retry-parse-failure-failure-1"));

    await waitFor(() => expect(mocks.apiRequest).toHaveBeenCalledWith(
      "POST",
      "/api/settings/lead-capture-inbox/parse-failures/failure-1/retry",
    ));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({
      title: "Email reprocessed",
    })));
    expect(mocks.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["/api/settings/lead-capture-inbox/parse-failures"],
    });
    expect(mocks.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["/api/leads"] });
  });

  it("keeps a 422 parsing failure visible inline", async () => {
    mocks.apiRequest.mockRejectedValue(new Error(
      '422: {"status":"failed","message":"AI parsing failed again. The email is still saved for review and has not been marked as spam."}',
    ));
    renderSection(async () => ({ entries: [failure], total: 1 }));

    fireEvent.click(await screen.findByTestId("button-retry-parse-failure-failure-1"));

    expect(await screen.findByText(
      "AI parsing failed again. The email is still saved for review and has not been marked as spam.",
    )).toBeTruthy();
  });

  it("shows the server's retained-manual-review guidance for a disconnected inbox", async () => {
    mocks.apiRequest.mockRejectedValue(new Error(
      '409: {"message":"This email belongs to a disconnected inbox. Its contents are retained for manual review."}',
    ));
    renderSection(async () => ({ entries: [failure], total: 1 }));

    fireEvent.click(await screen.findByTestId("button-retry-parse-failure-failure-1"));

    expect(await screen.findByText(
      "This email belongs to a disconnected inbox. Its contents are retained for manual review.",
    )).toBeTruthy();
    expect(screen.queryByText(/Reconnect the same Gmail inbox/)).toBeNull();
  });

  it("shows loading and empty states", async () => {
    const never = new Promise(() => {});
    const loadingView = renderSection(() => never);
    expect(screen.getByText("Loading emails that need review...")).toBeTruthy();
    loadingView.unmount();

    renderSection(async () => ({ entries: [], total: 0 }));
    expect(await screen.findByText("No emails need parsing review.")).toBeTruthy();
  });

  it("shows query errors and offers a retry", async () => {
    renderSection(async () => {
      throw new Error('500: {"message":"Could not load saved emails."}');
    });

    expect(await screen.findByText("Could not load saved emails.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});