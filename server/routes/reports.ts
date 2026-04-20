import type { Express, Response } from "express";
import { z } from "zod";
import type { AuthedRequest } from "../auth-service";
import { asyncHandler } from "../utils/async-handler";
import { getSpeedToLeadReport } from "../services/speed-to-lead-report";
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
  getRepeatCustomerReport,
  getGeographicReport,
  type EstimatesReportFilters,
} from "../services/estimates-reports";

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
  const { startDate, endDate, salespersonId, leadSource } = parsed.data;
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
  };
}

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

      const report = await getSpeedToLeadReport(req.user.contractorId, {
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
      const opts = await getEstimateFilterOptions(req.user.contractorId);
      res.json(opts);
    }),
  );

  // One endpoint per report. They all share the same filter schema and call into
  // the corresponding builder in services/estimates-reports.ts.
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

  wire("/api/reports/estimates/revenue", getRevenueReport);
  wire("/api/reports/estimates/lost-revenue", getLostRevenueReport);
  wire("/api/reports/estimates/pipeline-forecast", getPipelineForecastReport);
  wire("/api/reports/estimates/close-rate-by-salesperson", getCloseRateBySalesperson);
  wire("/api/reports/estimates/close-rate-by-source", getCloseRateBySource);
  wire("/api/reports/estimates/time-to-close", getTimeToCloseReport);
  wire("/api/reports/estimates/pending", getPendingReport);
  wire("/api/reports/estimates/in-progress", getInProgressReport);
  wire("/api/reports/estimates/sales-activity", getSalesActivityReport);
  wire("/api/reports/estimates/repeat-customers", getRepeatCustomerReport);
  wire("/api/reports/estimates/geographic", getGeographicReport);
}
