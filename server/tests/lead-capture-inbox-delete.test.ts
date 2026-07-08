import { describe, it, expect, vi, beforeEach } from "vitest";
import { leadCaptureInboxes, spamAuditLog } from "@shared/schema";

const state = {
  inboxRows: [] as Array<{ id: string }>,
  deletedTables: [] as unknown[],
  deleteRowCounts: new Map<unknown, number>(),
};

vi.mock("../db", () => {
  const makeTx = () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => state.inboxRows,
        }),
      }),
    }),
    delete: (table: unknown) => ({
      where: async () => {
        state.deletedTables.push(table);
        return { rowCount: state.deleteRowCounts.get(table) ?? 0 };
      },
    }),
  });
  return {
    db: {
      transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(makeTx()),
    },
  };
});

import { leadCaptureMethods } from "../storage/lead-capture";

beforeEach(() => {
  state.inboxRows = [];
  state.deletedTables = [];
  state.deleteRowCounts = new Map();
});

describe("deleteLeadCaptureInbox", () => {
  it("deletes spam audit rows before the inbox row (FK-safe) and returns true", async () => {
    state.inboxRows = [{ id: "inbox-1" }];
    state.deleteRowCounts.set(leadCaptureInboxes, 1);

    const result = await leadCaptureMethods.deleteLeadCaptureInbox("tenant-1");

    expect(result).toBe(true);
    expect(state.deletedTables).toEqual([spamAuditLog, leadCaptureInboxes]);
  });

  it("returns false and deletes nothing when no inbox exists for the contractor", async () => {
    state.inboxRows = [];

    const result = await leadCaptureMethods.deleteLeadCaptureInbox("tenant-1");

    expect(result).toBe(false);
    expect(state.deletedTables).toEqual([]);
  });
});
