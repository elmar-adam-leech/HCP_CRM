import type { Express, Response } from "express";
import { z } from "zod";
import type { AuthedRequest } from "../auth-service";
import { asyncHandler } from "../utils/async-handler";
import { getSpeedToLeadReport } from "../services/speed-to-lead-report";
import { getLeadsSchedulingSourceReport } from "../services/leads-scheduling-source-report";
import {
  getEstimateFilterOptions,
  getRevenueReport,
  getLostRevenueReport,
  getPipelineForecastReport,
  getCloseRateBySalesperson,
  getCloseRateBySource,
  getTimeToCloseReport,
  getPendingReport,
  getInProgressReport,
  getSalesActivityReport,
  getGeographicReport,
  type EstimatesReportFilters,
} from "../services/estimates-reports";
import { withReportCache } from "../services/report-cache";
import {
  getRoiBySourceReport,
  type RoiBySourceFilters,
  type RoiMode,
} from "../services/roi-by-source";

const speedToLeadQuerySchema = z
  .object({
    startDate: z.string().datetime({ offset: true }).optional().or(z.string().date().optional()),
    endDate: z.string().datetime({ offset: true }).optional().or(z.string().date().optional()),
  })
  .refine(
    (v) => (v.startDate && v.endDate) || (!v.startDate && !v.endDate),
    { message: "startDate and endDate must be provided together" },
  );

// Shared filter schema for every estimates report endpoint.
const estimatesReportQuerySchema = z.object({
  startDate: z.string().datetime({ offset: true }).optional().or(z.string().date().optional()),
  endDate: z.string().datetime({ offset: true }).optional().or(z.string().date().optional()),
  salespersonId: z.string().min(1).optional(),
  leadSource: z.string().min(1).optional(),
  page: z.coerce.number().int().min(0).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
  sortBy: z.enum(["created_at", "amount", "age", "salesperson"]).optional(),
  sortDir: z.enum(["asc", "desc"]).optional(),
});

// Resolve a report-filters object out of the query string. Default window is the
// last 30 days (matching the dashboard) so endpoints called without dates still
// return a sensible result instead of erroring out.
function resolveFilters(req: AuthedRequest, res: Response): EstimatesReportFilters | null {
  const parsed = estimatesReportQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ message: parsed.error.issues[0]?.message ?? "Invalid query parameters" });
    return null;
  }
  const { startDate, endDate, salespersonId, leadSource, page, pageSize, sortBy, sortDir } = parsed.data;
  let start: Date;
  let end: Date;
  if (startDate && endDate) {
    start = new Date(startDate);
    end = new Date(endDate);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      res.status(400).json({ message: "Invalid date" });
      return null;
    }
    if (end <= start) {
      res.status(400).json({ message: "endDate must be after startDate" });
      return null;
    }
  } else {
    end = new Date();
    start = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
  }
  return {
    startDate: start,
    endDate: end,
    salespersonId: salespersonId ?? null,
    leadSource: leadSource ?? null,
    page: page ?? 0,
    pageSize: pageSize ?? 25,
    sortBy: sortBy ?? null,
    sortDir: sortDir ?? null,
  };
}

// Stable cache-key serializer: filter date instances normalize to ISO and
// nullable filters normalize to "" so identical requests share a cache slot.
// page/pageSize are included so paginated reports cache each page separately.
function serializeFilters(args: [EstimatesReportFilters]): string {
  const f = args[0];
  return [
    f.startDate.toISOString(),
    f.endDate.toISOString(),
    f.salespersonId ?? "",
    f.leadSource ?? "",
    f.page ?? 0,
    f.pageSize ?? 25,
    f.sortBy ?? "",
    f.sortDir ?? "",
  ].join("|");
}

// Wrap every estimates report builder with the per-tenant in-memory cache.
// Keep filter-options cached longer (5 minutes) since those rarely change.
const cachedRevenue = withReportCache("revenue", getRevenueReport, { serialize: serializeFilters });
const cachedLostRevenue = withReportCache("lost-revenue", getLostRevenueReport, { serialize: serializeFilters });
const cachedPipelineForecast = withReportCache("pipeline-forecast", getPipelineForecastReport, { serialize: serializeFilters });
const cachedCloseRateSalesperson = withReportCache("close-rate-salesperson", getCloseRateBySalesperson, { serialize: serializeFilters });
const cachedCloseRateSource = withReportCache("close-rate-source", getCloseRateBySource, { serialize: serializeFilters });
const cachedTimeToClose = withReportCache("time-to-close", getTimeToCloseReport, { serialize: serializeFilters });
const cachedPending = withReportCache("pending", getPendingReport, { serialize: serializeFilters });
const cachedInProgress = withReportCache("in-progress", getInProgressReport, { serialize: serializeFilters });
const cachedSalesActivity = withReportCache("sales-activity", getSalesActivityReport, { serialize: serializeFilters });
const cachedGeographic = withReportCache("geographic", getGeographicReport, { serialize: serializeFilters });
const cachedFilterOptions = withReportCache(
  "filter-options",
  (cid: string) => getEstimateFilterOptions(cid),
  { ttlMs: 5 * 60 * 1000, serialize: () => "" },
);
const cachedSpeedToLead = withReportCache(
  "speed-to-lead",
  (cid: string, range: { startDate: Date; endDate: Date }) =>
    getSpeedToLeadReport(cid, range),
  {
    serialize: (args) => `${args[0].startDate.toISOString()}|${args[0].endDate.toISOString()}`,
  },
);
const cachedLeadsSchedulingSource = withReportCache(
  "leads-scheduling-source",
  (cid: string, range: { startDate: Date; endDate: Date }) =>
    getLeadsSchedulingSourceReport(cid, range),
  {
    serialize: (args) => `${args[0].startDate.toISOString()}|${args[0].endDate.toISOString()}`,
  },
);

export function registerReportsRoutes(app: Express): void {
  app.get(
    "/api/reports/speed-to-lead",
    asyncHandler(async (req: AuthedRequest, res: Response) => {
      const parsed = speedToLeadQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res
          .status(400)
          .json({ message: parsed.error.issues[0]?.message ?? "Invalid query parameters" });
        return;
      }

      const { startDate, endDate } = parsed.data;
      let start: Date;
      let end: Date;
      if (startDate && endDate) {
        start = new Date(startDate);
        end = new Date(endDate);
        if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
          res.status(400).json({ message: "Invalid date" });
          return;
        }
        if (end <= start) {
          res.status(400).json({ message: "endDate must be after startDate" });
          return;
        }
      } else {
        // Default: last 30 days, lead.created_at half-open [start, end).
        end = new Date();
        start = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
      }

      const report = await cachedSpeedToLead(req.user.contractorId, {
        startDate: start,
        endDate: end,
      });
      res.json(report);
    }),
  );

  // Self-Scheduled vs Sales-Scheduled bookings (Reports → Leads → task #694).
  // Same date-range schema and defaults as /api/reports/speed-to-lead so the
  // two leads-tab reports behave identically when the user moves between them.
  app.get(
    "/api/reports/leads/scheduling-source",
    asyncHandler(async (req: AuthedRequest, res: Response) => {
      const parsed = speedToLeadQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res
          .status(400)
          .json({ message: parsed.error.issues[0]?.message ?? "Invalid query parameters" });
        return;
      }

      const { startDate, endDate } = parsed.data;
      let start: Date;
      let end: Date;
      if (startDate && endDate) {
        start = new Date(startDate);
        end = new Date(endDate);
        if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
          res.status(400).json({ message: "Invalid date" });
          return;
        }
        if (end <= start) {
          res.status(400).json({ message: "endDate must be after startDate" });
          return;
        }
      } else {
        end = new Date();
        start = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
      }

      const report = await cachedLeadsSchedulingSource(req.user.contractorId, {
        startDate: start,
        endDate: end,
      });
      res.json(report);
    }),
  );

  // Estimates filter dropdowns (salespeople + distinct lead sources).
  app.get(
    "/api/reports/estimates/filter-options",
    asyncHandler(async (req: AuthedRequest, res: Response) => {
      const opts = await cachedFilterOptions(req.user.contractorId);
      res.json(opts);
    }),
  );

  // One endpoint per report. They all share the same filter schema and call into
  // the corresponding cached builder.
  const wire = <T>(path: string, fn: (cid: string, f: EstimatesReportFilters) => Promise<T>) => {
    app.get(
      path,
      asyncHandler(async (req: AuthedRequest, res: Response) => {
        const filters = resolveFilters(req, res);
        if (!filters) return;
        const data = await fn(req.user.contractorId, filters);
        res.json({
          range: { start: filters.startDate.toISOString(), end: filters.endDate.toISOString() },
          ...data,
        });
      }),
    );
  };

  wire("/api/reports/estimates/revenue", cachedRevenue);
  wire("/api/reports/estimates/lost-revenue", cachedLostRevenue);
  wire("/api/reports/estimates/pipeline-forecast", cachedPipelineForecast);
  wire("/api/reports/estimates/close-rate-by-salesperson", cachedCloseRateSalesperson);
  wire("/api/reports/estimates/close-rate-by-source", cachedCloseRateSource);
  wire("/api/reports/estimates/time-to-close", cachedTimeToClose);
  wire("/api/reports/estimates/pending", cachedPending);
  wire("/api/reports/estimates/in-progress", cachedInProgress);
  wire("/api/reports/estimates/sales-activity", cachedSalesActivity);
  wire("/api/reports/estimates/geographic", cachedGeographic);

  // ---- Task #696: Lead-to-sale ROI by source ----
  const roiBySourceQuerySchema = z.object({
    startDate: z.string().datetime({ offset: true }).optional().or(z.string().date().optional()),
    endDate: z.string().datetime({ offset: true }).optional().or(z.string().date().optional()),
    mode: z.enum(["estimates", "jobs"]).optional(),
  });

  const cachedRoiBySource = withReportCache(
    "roi-by-source",
    (cid: string, filters: RoiBySourceFilters) => getRoiBySourceReport(cid, filters),
    {
      serialize: (args) => {
        const f = args[0];
        return [f.startDate.toISOString(), f.endDate.toISOString(), f.mode].join("|");
      },
    },
  );

  app.get(
    "/api/reports/leads/roi-by-source",
    asyncHandler(async (req: AuthedRequest, res: Response) => {
      const parsed = roiBySourceQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res
          .status(400)
          .json({ message: parsed.error.issues[0]?.message ?? "Invalid query parameters" });
        return;
      }
      const { startDate, endDate, mode } = parsed.data;
      let start: Date;
      let end: Date;
      if (startDate && endDate) {
        start = new Date(startDate);
        end = new Date(endDate);
        if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
          res.status(400).json({ message: "Invalid date" });
          return;
        }
        if (end <= start) {
          res.status(400).json({ message: "endDate must be after startDate" });
          return;
        }
      } else {
        end = new Date();
        start = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
      }
      const resolvedMode: RoiMode = mode ?? "estimates";
      const report = await cachedRoiBySource(req.user.contractorId, {
        startDate: start,
        endDate: end,
        mode: resolvedMode,
      });
      res.json({
        range: { start: start.toISOString(), end: end.toISOString() },
        ...report,
      });
    }),
  );
}
