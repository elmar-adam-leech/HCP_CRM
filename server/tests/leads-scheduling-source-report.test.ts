import { describe, it, expect, vi, beforeEach } from "vitest";

const executeMock = vi.fn();

vi.mock("../db", () => ({ db: { execute: (...args: unknown[]) => executeMock(...args) } }));

import { getLeadsSchedulingSourceReport } from "../services/leads-scheduling-source-report";

const TENANT = "tenant-1";
const RANGE = {
  startDate: new Date("2026-01-01T00:00:00Z"),
  endDate: new Date("2026-01-08T00:00:00Z"),
};

beforeEach(() => {
  executeMock.mockReset();
});

describe("getLeadsSchedulingSourceReport", () => {
  it("issues a single DB round-trip", async () => {
    executeMock.mockResolvedValueOnce({
      rows: [
        {
          totals: { total: 0, self_booked: 0, salesperson_booked: 0 },
          daily: null,
          by_salesperson: null,
          timezone: "America/New_York",
        },
      ],
    });
    await getLeadsSchedulingSourceReport(TENANT, RANGE);
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it("returns zeroed totals and empty rows when there are no bookings", async () => {
    executeMock.mockResolvedValueOnce({
      rows: [
        {
          totals: null,
          daily: null,
          by_salesperson: null,
          timezone: "America/New_York",
        },
      ],
    });
    const r = await getLeadsSchedulingSourceReport(TENANT, RANGE);
    expect(r.totals).toEqual({
      total: 0,
      selfBooked: 0,
      salespersonBooked: 0,
      selfBookedPct: 0,
      salespersonBookedPct: 0,
    });
    expect(r.bySalesperson).toEqual([]);
    // daily is zero-filled across the requested range, not empty.
    expect(r.daily.length).toBeGreaterThan(0);
    expect(r.daily.every((d) => d.selfBooked === 0 && d.salespersonBooked === 0)).toBe(true);
    expect(r.range.start).toBe(RANGE.startDate.toISOString());
    expect(r.range.end).toBe(RANGE.endDate.toISOString());
    expect(r.timezone).toBe("America/New_York");
  });

  it("normalises numeric strings and computes percentages", async () => {
    executeMock.mockResolvedValueOnce({
      rows: [
        {
          totals: { total: "10", self_booked: "3", salesperson_booked: "7" },
          daily: [
            { date: "2026-01-01", self_booked: "1", salesperson_booked: "2" },
            { date: "2026-01-03", self_booked: "2", salesperson_booked: "5" },
          ],
          by_salesperson: [
            { user_id: "u1", name: "Alice", bookings: "5" },
            { user_id: null, name: null, bookings: "2" },
          ],
          timezone: "America/Los_Angeles",
        },
      ],
    });

    const r = await getLeadsSchedulingSourceReport(TENANT, RANGE);
    expect(r.totals.total).toBe(10);
    expect(r.totals.selfBooked).toBe(3);
    expect(r.totals.salespersonBooked).toBe(7);
    expect(r.totals.selfBookedPct).toBeCloseTo(30.0, 5);
    expect(r.totals.salespersonBookedPct).toBeCloseTo(70.0, 5);

    // Non-empty days are present and counts are normalized to numbers.
    const jan1 = r.daily.find((d) => d.date === "2026-01-01");
    const jan3 = r.daily.find((d) => d.date === "2026-01-03");
    expect(jan1).toEqual({ date: "2026-01-01", selfBooked: 1, salespersonBooked: 2 });
    expect(jan3).toEqual({ date: "2026-01-03", selfBooked: 2, salespersonBooked: 5 });

    // Days that the query did not return are zero-filled.
    const jan2 = r.daily.find((d) => d.date === "2026-01-02");
    expect(jan2).toEqual({ date: "2026-01-02", selfBooked: 0, salespersonBooked: 0 });

    expect(r.bySalesperson).toEqual([
      { userId: "u1", name: "Alice", bookings: 5 },
      { userId: null, name: "Unassigned", bookings: 2 },
    ]);

    expect(r.timezone).toBe("America/Los_Angeles");
  });

  it("scopes the query to the contractor and the requested date range", async () => {
    executeMock.mockResolvedValueOnce({
      rows: [{ totals: null, daily: null, by_salesperson: null, timezone: "America/New_York" }],
    });
    await getLeadsSchedulingSourceReport(TENANT, RANGE);
    const sqlArg = executeMock.mock.calls[0][0];
    const serialized = JSON.stringify(sqlArg);
    expect(serialized).toContain(TENANT);
    expect(serialized).toContain(RANGE.startDate.toISOString());
    expect(serialized).toContain(RANGE.endDate.toISOString());
    // Confirm we filter by source = 'public_booking' (the canonical
    // self-scheduled marker) and bucket by created_at, not start_time.
    expect(serialized).toContain("public_booking");
    expect(serialized).toContain("created_at");
  });

  it("(task #698) splits a mixed dataset of public and in-app bookings into the correct buckets", async () => {
    // Regression: simulate the exact shape of the bug — same day has both a
    // self-scheduled (public_booking) row and a sales-scheduled (in_app_booking)
    // row, plus another day with two rows of one type each. The service
    // counts on `scheduled_bookings.source` having been written/backfilled
    // correctly; this test asserts the parsing layer correctly turns those
    // raw counts into totals + per-day buckets + per-salesperson breakdown.
    executeMock.mockResolvedValueOnce({
      rows: [
        {
          totals: { total: "4", self_booked: "2", salesperson_booked: "2" },
          daily: [
            // Day 1: one self, one sales — the previous bug had this day
            // showing 0 self because every row was misclassified as in-app.
            { date: "2026-01-01", self_booked: "1", salesperson_booked: "1" },
            // Day 2: one of each from a different salesperson.
            { date: "2026-01-04", self_booked: "1", salesperson_booked: "1" },
          ],
          // The per-salesperson breakdown excludes self-booked rows by design
          // (the report SQL filters `WHERE NOT is_self_booked`), so totals
          // here should match `salesperson_booked` from the totals object.
          by_salesperson: [
            { user_id: "u-alice", name: "Alice", bookings: "1" },
            { user_id: "u-bob", name: "Bob", bookings: "1" },
          ],
          timezone: "America/New_York",
        },
      ],
    });

    const r = await getLeadsSchedulingSourceReport(TENANT, RANGE);

    // Totals: half self, half sales. Percentages must add to 100.
    expect(r.totals.total).toBe(4);
    expect(r.totals.selfBooked).toBe(2);
    expect(r.totals.salespersonBooked).toBe(2);
    expect(r.totals.selfBookedPct).toBeCloseTo(50.0, 5);
    expect(r.totals.salespersonBookedPct).toBeCloseTo(50.0, 5);

    // Daily buckets returned by the query are present with correct counts;
    // days in between are zero-filled.
    const jan1 = r.daily.find((d) => d.date === "2026-01-01");
    const jan4 = r.daily.find((d) => d.date === "2026-01-04");
    expect(jan1).toEqual({ date: "2026-01-01", selfBooked: 1, salespersonBooked: 1 });
    expect(jan4).toEqual({ date: "2026-01-04", selfBooked: 1, salespersonBooked: 1 });
    const jan2 = r.daily.find((d) => d.date === "2026-01-02");
    expect(jan2).toEqual({ date: "2026-01-02", selfBooked: 0, salespersonBooked: 0 });

    // Per-salesperson breakdown: only salesperson-booked rows show up here,
    // and the two breakdown counts sum to the salesperson-booked total.
    expect(r.bySalesperson).toEqual([
      { userId: "u-alice", name: "Alice", bookings: 1 },
      { userId: "u-bob", name: "Bob", bookings: 1 },
    ]);
    const breakdownSum = r.bySalesperson.reduce((s, x) => s + x.bookings, 0);
    expect(breakdownSum).toBe(r.totals.salespersonBooked);
  });

  it("falls back to America/New_York when the contractor has no timezone", async () => {
    executeMock.mockResolvedValueOnce({
      rows: [
        {
          totals: { total: 1, self_booked: 1, salesperson_booked: 0 },
          daily: [{ date: "2026-01-02", self_booked: 1, salesperson_booked: 0 }],
          by_salesperson: null,
          timezone: null,
        },
      ],
    });
    const r = await getLeadsSchedulingSourceReport(TENANT, RANGE);
    expect(r.timezone).toBe("America/New_York");
    // 100% / 0% split for a single self-scheduled booking.
    expect(r.totals.selfBookedPct).toBe(100);
    expect(r.totals.salespersonBookedPct).toBe(0);
  });
});
