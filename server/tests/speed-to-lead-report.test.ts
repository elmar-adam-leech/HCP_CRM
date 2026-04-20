import { describe, it, expect, vi, beforeEach } from "vitest";

const executeMock = vi.fn();

vi.mock("../db", () => ({ db: { execute: (...args: unknown[]) => executeMock(...args) } }));

import { getSpeedToLeadReport } from "../services/speed-to-lead-report";

const TENANT = "tenant-1";
const RANGE = {
  startDate: new Date("2026-01-01T00:00:00Z"),
  endDate: new Date("2026-02-01T00:00:00Z"),
};

beforeEach(() => {
  executeMock.mockReset();
});

describe("getSpeedToLeadReport", () => {
  it("issues a single DB round-trip when rows are present", async () => {
    executeMock.mockResolvedValueOnce({
      rows: [
        {
          per_user: [
            {
              user_id: "u1",
              name: "A",
              leads_called: 1,
              median_min: 0,
              avg_min: 0,
              avg_calls: 1,
              avg_calls_scheduled: null,
              avg_calls_scheduled_non_selfbook: null,
              scheduled_leads_called: 0,
              scheduled_leads_called_non_selfbook: 0,
              lt5m: 1, lt15m: 0, lt1h: 0, lt4h: 0, lt24h: 0, gte24h: 0,
            },
          ],
          totals: null,
        },
      ],
    });
    await getSpeedToLeadReport(TENANT, RANGE);
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it("returns empty totals and rows when there are no called leads", async () => {
    executeMock.mockResolvedValueOnce({ rows: [{ per_user: null, totals: null }] });
    executeMock.mockResolvedValueOnce({ rows: [{ exists: false }] });

    const r = await getSpeedToLeadReport(TENANT, RANGE);
    expect(r.salespeople).toEqual([]);
    expect(r.totals.leadsCalled).toBe(0);
    expect(r.totals.medianMinutesToFirstCall).toBe(0);
    expect(r.totals.averageCallsPerScheduledLead).toBeNull();
    expect(r.totals.averageCallsPerScheduledLeadNonSelfBook).toBeNull();
    expect(r.totals.distribution).toEqual({
      lt5m: 0, lt15m: 0, lt1h: 0, lt4h: 0, lt24h: 0, gte24h: 0,
    });
    expect(r.range.start).toBe(RANGE.startDate.toISOString());
    expect(r.range.end).toBe(RANGE.endDate.toISOString());
  });

  it("classifies emptyReason as no_calls_ever when no call activities exist", async () => {
    executeMock.mockResolvedValueOnce({ rows: [{ per_user: null, totals: null }] });
    executeMock.mockResolvedValueOnce({ rows: [{ exists: false }] });

    const r = await getSpeedToLeadReport(TENANT, RANGE);
    expect(r.emptyReason).toBe("no_calls_ever");
    expect(executeMock).toHaveBeenCalledTimes(2);
  });

  it("classifies emptyReason as no_calls_in_range when calls exist but not in range", async () => {
    executeMock.mockResolvedValueOnce({ rows: [{ per_user: null, totals: null }] });
    executeMock.mockResolvedValueOnce({ rows: [{ exists: true }] });
    executeMock.mockResolvedValueOnce({ rows: [{ exists: false }] });

    const r = await getSpeedToLeadReport(TENANT, RANGE);
    expect(r.emptyReason).toBe("no_calls_in_range");
    expect(executeMock).toHaveBeenCalledTimes(3);
  });

  it("classifies emptyReason as no_lead_calls_in_range when calls exist in range but no per-user rows", async () => {
    executeMock.mockResolvedValueOnce({ rows: [{ per_user: null, totals: null }] });
    executeMock.mockResolvedValueOnce({ rows: [{ exists: true }] });
    executeMock.mockResolvedValueOnce({ rows: [{ exists: true }] });

    const r = await getSpeedToLeadReport(TENANT, RANGE);
    expect(r.emptyReason).toBe("no_lead_calls_in_range");
    expect(executeMock).toHaveBeenCalledTimes(3);
  });

  it("emptyReason is null when there are salespeople rows", async () => {
    executeMock.mockResolvedValueOnce({
      rows: [
        {
          per_user: [
            {
              user_id: "u1",
              name: "A",
              leads_called: 1,
              median_min: 0,
              avg_min: 0,
              avg_calls: 1,
              avg_calls_scheduled: null,
              avg_calls_scheduled_non_selfbook: null,
              scheduled_leads_called: 0,
              scheduled_leads_called_non_selfbook: 0,
              lt5m: 1, lt15m: 0, lt1h: 0, lt4h: 0, lt24h: 0, gte24h: 0,
            },
          ],
          totals: null,
        },
      ],
    });
    const r = await getSpeedToLeadReport(TENANT, RANGE);
    expect(r.emptyReason).toBeNull();
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it("normalises numeric strings, rounds, and nulls scheduled averages when n=0", async () => {
    executeMock.mockResolvedValueOnce({
      rows: [
        {
          per_user: [
            {
              user_id: "u1",
              name: "Alice",
              leads_called: "3",
              median_min: "12.34",
              avg_min: "30",
              avg_calls: "2.5555",
              avg_calls_scheduled: "1.5",
              avg_calls_scheduled_non_selfbook: null,
              scheduled_leads_called: "2",
              scheduled_leads_called_non_selfbook: "0",
              lt5m: "1",
              lt15m: "1",
              lt1h: "1",
              lt4h: "0",
              lt24h: "0",
              gte24h: "0",
            },
          ],
          totals: {
            leads_called: "3",
            median_min: "12",
            avg_min: "30",
            avg_calls: "2.5",
            avg_calls_scheduled: "1.5",
            avg_calls_scheduled_non_selfbook: null,
            scheduled_leads_called: "2",
            scheduled_leads_called_non_selfbook: "0",
            lt5m: "1",
            lt15m: "1",
            lt1h: "1",
            lt4h: "0",
            lt24h: "0",
            gte24h: "0",
          },
        },
      ],
    });

    const r = await getSpeedToLeadReport(TENANT, RANGE);
    expect(r.salespeople).toHaveLength(1);
    const a = r.salespeople[0];
    expect(a.userId).toBe("u1");
    expect(a.name).toBe("Alice");
    expect(a.leadsCalled).toBe(3);
    expect(a.medianMinutesToFirstCall).toBe(12.3);
    expect(a.averageMinutesToFirstCall).toBe(30);
    expect(a.averageCallsPerLead).toBe(2.6);
    expect(a.averageCallsPerScheduledLead).toBe(1.5);
    // No non-self-book scheduled leads → null instead of 0.
    expect(a.averageCallsPerScheduledLeadNonSelfBook).toBeNull();
    expect(a.scheduledLeadsCalled).toBe(2);
    expect(a.scheduledLeadsCalledNonSelfBook).toBe(0);
    expect(a.distribution).toEqual({
      lt5m: 1, lt15m: 1, lt1h: 1, lt4h: 0, lt24h: 0, gte24h: 0,
    });

    expect(r.totals.leadsCalled).toBe(3);
    expect(r.totals.averageCallsPerScheduledLeadNonSelfBook).toBeNull();
  });

  it("scopes the query to the contractor and the requested date range", async () => {
    executeMock.mockResolvedValueOnce({ rows: [{ per_user: null, totals: null }] });
    executeMock.mockResolvedValueOnce({ rows: [{ exists: false }] });

    await getSpeedToLeadReport(TENANT, RANGE);

    const sqlArg = executeMock.mock.calls[0][0];
    const serialized = JSON.stringify(sqlArg);
    expect(serialized).toContain(TENANT);
    expect(serialized).toContain(RANGE.startDate.toISOString());
    expect(serialized).toContain(RANGE.endDate.toISOString());
  });
});
