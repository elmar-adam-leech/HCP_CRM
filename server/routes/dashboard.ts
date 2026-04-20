import type { Express, Response } from "express";
import { storage } from "../storage";
import type { AuthedRequest } from "../auth-service";
import { asyncHandler } from "../utils/async-handler";
import { z } from "zod";
import { placesRateLimiter } from "../middleware/rate-limiter";
import { placesAutocomplete, placesDetails } from "../utils/places-client";

// Zod schema for the dashboard metrics query params.
// Validates timeframe and custom date range values before any Date construction,
// preventing silent NaN dates or 500 errors from malformed query strings.
const dashboardMetricsQuerySchema = z.object({
  timeframe: z.enum(['this_week', 'this_month', 'this_year', 'custom', 'all_time']).optional(),
  startDate: z.string().datetime({ offset: true }).optional().or(z.string().date().optional()),
  endDate: z.string().datetime({ offset: true }).optional().or(z.string().date().optional()),
});

export function registerDashboardRoutes(app: Express): void {
  // Google Places API proxy — authenticated, server-side calls bypass browser referrer restrictions.
  // `placesRateLimiter` enforces a per-IP limit of 30 req/min (stricter than the 300 req/min global
  // apiRateLimiter) because each call here consumes a paid Google API quota slot.
  app.get('/api/places/autocomplete', placesRateLimiter, asyncHandler(async (req: AuthedRequest, res: Response) => {
    const { input, sessionToken } = req.query as { input?: string; sessionToken?: string };
    if (!input || input.trim().length < 3) {
      res.json({ suggestions: [] });
      return;
    }
    const result = await placesAutocomplete(input, sessionToken);
    if (!result) {
      res.status(503).json({ error: 'Google Maps API key not configured' });
      return;
    }
    if (!result.ok) {
      res.status(502).json({ error: 'Places API error', details: result.data });
      return;
    }
    res.json({ suggestions: result.data.suggestions || [] });
  }));

  app.get('/api/places/details', placesRateLimiter, asyncHandler(async (req: AuthedRequest, res: Response) => {
    const { placeId, sessionToken } = req.query as { placeId?: string; sessionToken?: string };
    if (!placeId) {
      res.status(400).json({ error: 'placeId is required' });
      return;
    }
    const result = await placesDetails(placeId, sessionToken);
    if (!result) {
      res.status(503).json({ error: 'Google Maps API key not configured' });
      return;
    }
    if (!result.ok) {
      res.status(502).json({ error: 'Places API error', details: result.data });
      return;
    }
    res.json(result.data);
  }));

  // Dashboard metrics route
  app.get("/api/dashboard/metrics", asyncHandler(async (req: AuthedRequest, res: Response) => {
    const parsed = dashboardMetricsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ message: parsed.error.issues[0]?.message ?? "Invalid query parameters" });
      return;
    }
    const { timeframe, startDate, endDate } = parsed.data;

    let start: Date | undefined;
    let end: Date | undefined;

    const now = new Date();
    now.setHours(23, 59, 59, 999);

    if (timeframe === 'this_week') {
      start = new Date(now);
      const dayOfWeek = start.getDay();
      start.setDate(start.getDate() - dayOfWeek);
      start.setHours(0, 0, 0, 0);
      end = now;
    } else if (timeframe === 'this_month') {
      start = new Date(now.getFullYear(), now.getMonth(), 1);
      start.setHours(0, 0, 0, 0);
      end = now;
    } else if (timeframe === 'this_year') {
      start = new Date(now.getFullYear(), 0, 1);
      start.setHours(0, 0, 0, 0);
      end = now;
    } else if (timeframe === 'custom' && startDate && endDate) {
      start = new Date(startDate);
      start.setHours(0, 0, 0, 0);
      end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
    }

    const metrics = await storage.getDashboardMetrics(
      req.user.contractorId,
      req.user.userId,
      req.user.role,
      start,
      end
    );
    res.json(metrics);
  }));
}
