import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import http from "http";
import type { AddressInfo } from "net";

const TENANT = "tenant-1";

const getReportMock = vi.fn();

vi.mock("../services/leads-scheduling-source-report", () => ({
  getLeadsSchedulingSourceReport: (cid: string, opts: { startDate: Date; endDate: Date }) =>
    getReportMock(cid, opts),
}));

vi.mock("../utils/async-handler", () => ({
  asyncHandler: (fn: express.RequestHandler) =>
    (req: express.Request, res: express.Response, next: express.NextFunction) => {
      Promise.resolve(fn(req, res, next)).catch(next);
    },
}));

import { registerReportsRoutes } from "../routes/reports";

let server: http.Server | undefined;
let baseUrl = "";

async function startApp(opts?: { user?: { contractorId: string } | null }) {
  const app = express();
  app.use((req, _res, next) => {
    if (opts?.user !== null) {
      (req as unknown as { user: { contractorId: string } }).user = opts?.user ?? {
        contractorId: TENANT,
      };
    }
    next();
  });
  registerReportsRoutes(app);
  app.use((err: Error, _req: express.Request, res: express.Response, _n: express.NextFunction) => {
    res.status(500).json({ message: err.message });
  });
  server = http.createServer(app);
  await new Promise<void>((resolve) => server!.listen(0, resolve));
  const addr = server!.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
}

beforeEach(() => {
  getReportMock.mockReset();
  getReportMock.mockResolvedValue({
    range: { start: "", end: "" },
    timezone: "America/New_York",
    totals: {
      total: 0,
      selfBooked: 0,
      salespersonBooked: 0,
      selfBookedPct: 0,
      salespersonBookedPct: 0,
    },
    daily: [],
    bySalesperson: [],
  });
});

afterEach(async () => {
  if (server) await new Promise<void>((resolve, reject) => server!.close((e) => (e ? reject(e) : resolve())));
  server = undefined;
});

describe("GET /api/reports/leads/scheduling-source", () => {
  it("uses a default 30-day range when no dates are provided", async () => {
    await startApp();
    const res = await fetch(`${baseUrl}/api/reports/leads/scheduling-source`);
    expect(res.status).toBe(200);
    expect(getReportMock).toHaveBeenCalledTimes(1);
    const [cid, opts] = getReportMock.mock.calls[0];
    expect(cid).toBe(TENANT);
    const diffDays = (opts.endDate.getTime() - opts.startDate.getTime()) / (1000 * 60 * 60 * 24);
    expect(diffDays).toBeGreaterThan(29.5);
    expect(diffDays).toBeLessThan(30.5);
  });

  it("forwards an explicit date range to the service", async () => {
    await startApp();
    const start = "2026-01-01T00:00:00.000Z";
    const end = "2026-02-01T00:00:00.000Z";
    const res = await fetch(
      `${baseUrl}/api/reports/leads/scheduling-source?startDate=${encodeURIComponent(start)}&endDate=${encodeURIComponent(end)}`,
    );
    expect(res.status).toBe(200);
    const [, opts] = getReportMock.mock.calls[0];
    expect(opts.startDate.toISOString()).toBe(start);
    expect(opts.endDate.toISOString()).toBe(end);
  });

  it("rejects an inverted date range with 400", async () => {
    await startApp();
    const start = "2026-02-01T00:00:00.000Z";
    const end = "2026-01-01T00:00:00.000Z";
    const res = await fetch(
      `${baseUrl}/api/reports/leads/scheduling-source?startDate=${encodeURIComponent(start)}&endDate=${encodeURIComponent(end)}`,
    );
    expect(res.status).toBe(400);
    expect(getReportMock).not.toHaveBeenCalled();
  });

  it("rejects providing only one of startDate / endDate with 400", async () => {
    await startApp();
    const res = await fetch(
      `${baseUrl}/api/reports/leads/scheduling-source?startDate=2026-01-01T00:00:00.000Z`,
    );
    expect(res.status).toBe(400);
    expect(getReportMock).not.toHaveBeenCalled();
  });

  it("scopes the query to the authenticated user's contractor", async () => {
    await startApp({ user: { contractorId: "tenant-other" } });
    const res = await fetch(`${baseUrl}/api/reports/leads/scheduling-source`);
    expect(res.status).toBe(200);
    const [cid] = getReportMock.mock.calls[0];
    expect(cid).toBe("tenant-other");
  });
});
