import type { Express, Response } from "express";
import { sql } from "drizzle-orm";
import { db } from "../db";
import { requireAuth, AuthService, type AuthedRequest } from "../auth-service";
import { asyncHandler } from "../utils/async-handler";
import { getStats } from "../services/latency-stats";
import { getAuthCacheStats } from "../services/auth-cache";

const requireSuperAdmin = AuthService.requireRole(['super_admin']);

export function registerAdminPerfRoutes(app: Express): void {
  // GET /api/_admin/perf/latency
  // Returns the current per-route latency snapshot (p50/p95/p99/avg + counts),
  // sorted by p95 descending. Super-admin only.
  app.get(
    "/api/_admin/perf/latency",
    requireAuth,
    requireSuperAdmin,
    asyncHandler(async (_req: AuthedRequest, res: Response) => {
      const snapshot = getStats();
      const authCache = getAuthCacheStats();
      const total = authCache.hits + authCache.misses;
      const hitRate = total > 0 ? authCache.hits / total : 0;
      res.json({
        ...snapshot,
        authCache: {
          ...authCache,
          hitRate: Math.round(hitRate * 10000) / 10000,
        },
      });
    }),
  );

  // GET /api/_admin/perf/slow-queries
  // Top-20 statements by mean execution time from pg_stat_statements (if the
  // extension is installed). Returns 503 with a clear message when the
  // extension isn't available — Neon and most managed providers permit it,
  // but we don't crash if it's missing. Super-admin only.
  app.get(
    "/api/_admin/perf/slow-queries",
    requireAuth,
    requireSuperAdmin,
    asyncHandler(async (_req: AuthedRequest, res: Response) => {
      try {
        const exists = await db.execute(sql`
          SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements' LIMIT 1
        `);
        if ((exists.rows as unknown[]).length === 0) {
          res.status(503).json({
            message: 'pg_stat_statements is not installed on this database.',
          });
          return;
        }

        const result = await db.execute(sql`
          SELECT
            queryid::text AS queryid,
            LEFT(query, 500) AS query,
            calls,
            ROUND(mean_exec_time::numeric, 2) AS mean_ms,
            ROUND(total_exec_time::numeric, 2) AS total_ms,
            rows
          FROM pg_stat_statements
          ORDER BY mean_exec_time DESC
          LIMIT 20
        `);
        res.json({ queries: result.rows });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(503).json({
          message: 'Could not query pg_stat_statements',
          detail: message,
        });
      }
    }),
  );
}
