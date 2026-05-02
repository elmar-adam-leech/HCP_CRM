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

  // Regression: legacy Dialpad-webhook activity rows used to land in the DB
  // with activities.user_id = NULL, which made every per-user aggregate
  // empty. The query now COALESCEs activity.user_id with two metadata-based
  // lookups: operator_id → dialpad_users.dialpad_user_id (joined by email
  // to users), and operator_email → users.email directly. This test pins
  // the SQL shape so the fallback can't be silently removed.
  it("falls back to metadata.operator_id and metadata.operator_email when activities.user_id is NULL", async () => {
    executeMock.mockResolvedValueOnce({ rows: [{ per_user: null, totals: null }] });
    executeMock.mockResolvedValueOnce({ rows: [{ exists: false }] });

    await getSpeedToLeadReport(TENANT, RANGE);

    const sqlArg = executeMock.mock.calls[0][0];
    const serialized = JSON.stringify(sqlArg);
    expect(serialized).toContain("COALESCE");
    expect(serialized).toContain("dialpad_users");
    expect(serialized).toContain("operator_id");
    expect(serialized).toContain("operator_email");
    // Legacy fallback: pre-fix Dialpad-webhook rows only stored
    // metadata.operatorName (display name), not operator_id/email.
    // Verify the operatorName → dialpad_users.full_name path is wired.
    expect(serialized).toContain("operatorName");
    expect(serialized).toContain("full_name");
    // The plain WHERE a.user_id IS NOT NULL filter must be gone (it was
    // the original culprit); the corresponding NULL filter now lives on
    // the resolved value inside the salesperson_calls CTE.
    expect(serialized).not.toContain("a.user_id IS NOT NULL");
    expect(serialized).toContain("oc.user_id IS NOT NULL");
  });

  // Higher-fidelity simulation: the previous bug was that legacy Dialpad
  // call activities (user_id NULL) produced an empty report. Now that the
  // SQL resolves a user_id from operator metadata, the consumer formatter
  // should treat the resolved row exactly like a row that had user_id
  // populated to begin with. We feed the mock the shape the new CTE
  // would produce for a single legacy Dialpad call attributed via the
  // operator_id fallback, and assert the report is non-empty and the
  // resolved user shows up correctly.
  it("formats a non-empty report when the resolved user_id came from the operator_id fallback (legacy Dialpad row)", async () => {
    executeMock.mockResolvedValueOnce({
      rows: [
        {
          per_user: [
            {
              user_id: "rep-resolved-from-operator-id",
              name: "Casey Salesperson",
              leads_called: 4,
              median_min: 6,
              avg_min: 9,
              avg_calls: 2,
              avg_calls_scheduled: 3,
              avg_calls_scheduled_non_selfbook: 3,
              scheduled_leads_called: 2,
              scheduled_leads_called_non_selfbook: 2,
              lt5m: 1, lt15m: 1, lt1h: 1, lt4h: 1, lt24h: 0, gte24h: 0,
            },
          ],
          totals: {
            leads_called: 4,
            median_min: 6,
            avg_min: 9,
            avg_calls: 2,
            avg_calls_scheduled: 3,
            avg_calls_scheduled_non_selfbook: 3,
            scheduled_leads_called: 2,
            scheduled_leads_called_non_selfbook: 2,
            lt5m: 1, lt15m: 1, lt1h: 1, lt4h: 1, lt24h: 0, gte24h: 0,
          },
        },
      ],
    });

    const report = await getSpeedToLeadReport(TENANT, RANGE);

    expect(report.salespeople).toHaveLength(1);
    expect(report.salespeople[0].userId).toBe("rep-resolved-from-operator-id");
    expect(report.salespeople[0].name).toBe("Casey Salesperson");
    expect(report.salespeople[0].leadsCalled).toBe(4);
    expect(report.totals.leadsCalled).toBe(4);
    expect(report.emptyReason).toBeNull();
    // Sanity: the formatter did not silently drop the resolved row, so
    // emptyReason is null (i.e. the report is non-empty).
    expect(report.totals.leadsCalled).toBeGreaterThan(0);
  });
});
