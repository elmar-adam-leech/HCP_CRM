import { describe, it, expect, vi, beforeEach } from "vitest";

const state = {
  // Queue of rows returned by successive db.select(...).limit() calls.
  selectResults: [] as Array<Array<Record<string, unknown>>>,
  lastSetValues: null as Record<string, unknown> | null,
  updatedRow: {} as Record<string, unknown>,
};

vi.mock("../db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => state.selectResults.shift() ?? [],
        }),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        state.lastSetValues = values;
        return {
          where: () => ({
            returning: async () => [state.updatedRow],
          }),
        };
      },
    }),
  },
}));

vi.mock("../services/report-cache", () => ({
  invalidateReportsCache: vi.fn(),
}));

vi.mock("../services/sales-process", () => ({
  onEstimateStatusChanged: vi.fn(),
}));

import { estimateMethods } from "../storage/estimates";

beforeEach(() => {
  state.selectResults = [];
  state.lastSetValues = null;
  state.updatedRow = { id: "est-1", status: "sent" };
});

describe("updateEstimate documentSentAt stamping (task #898)", () => {
  it("stamps documentSentAt when status is set to 'sent' and no timestamp exists", async () => {
    state.selectResults = [
      [{ status: "in_progress" }],       // prior-status lookup
      [{ documentSentAt: null }],        // stamping lookup
    ];

    await estimateMethods.updateEstimate("est-1", { status: "sent" }, "tenant-1");

    expect(state.lastSetValues?.documentSentAt).toBeInstanceOf(Date);
  });

  it("does not overwrite an existing documentSentAt (sticky)", async () => {
    const existing = new Date("2026-01-01T00:00:00Z");
    state.selectResults = [
      [{ status: "in_progress" }],
      [{ documentSentAt: existing }],
    ];

    await estimateMethods.updateEstimate("est-1", { status: "sent" }, "tenant-1");

    expect(state.lastSetValues?.documentSentAt).toBeUndefined();
  });

  it("caller-provided documentSentAt wins over auto-stamping", async () => {
    const provided = new Date("2026-02-02T00:00:00Z");
    state.selectResults = [
      [{ status: "in_progress" }],
      // no stamping lookup happens when caller provides the value
    ];

    await estimateMethods.updateEstimate(
      "est-1",
      { status: "sent", documentSentAt: provided },
      "tenant-1",
    );

    expect(state.lastSetValues?.documentSentAt).toBe(provided);
  });

  it("passes through an explicit documentSentAt: null (un-send, task #900)", async () => {
    state.selectResults = [
      [{ status: "sent" }],              // prior-status lookup
    ];
    state.updatedRow = { id: "est-1", status: "scheduled" };

    await estimateMethods.updateEstimate(
      "est-1",
      { status: "scheduled", documentSentAt: null },
      "tenant-1",
    );

    expect(state.lastSetValues?.documentSentAt).toBeNull();
  });

  it("re-stamps documentSentAt when re-marked sent after an un-send (task #900)", async () => {
    state.selectResults = [
      [{ status: "scheduled" }],         // prior-status lookup
      [{ documentSentAt: null }],        // stamping lookup (cleared by un-send)
    ];

    await estimateMethods.updateEstimate("est-1", { status: "sent" }, "tenant-1");

    expect(state.lastSetValues?.documentSentAt).toBeInstanceOf(Date);
  });

  it("does not stamp for non-'sent' status updates", async () => {
    state.selectResults = [
      [{ status: "sent" }],              // prior-status lookup
      [{ status: "sent", approvedAt: null, rejectedAt: null }], // approved/rejected lookup
    ];
    state.updatedRow = { id: "est-1", status: "approved" };

    await estimateMethods.updateEstimate("est-1", { status: "approved" }, "tenant-1");

    expect(state.lastSetValues?.documentSentAt).toBeUndefined();
  });
});
