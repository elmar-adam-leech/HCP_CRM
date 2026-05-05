import type { Express, Response } from "express";
import { sql } from "drizzle-orm";
import { db } from "../db";
import { requireAuth, AuthService, type AuthedRequest } from "../auth-service";
import { asyncHandler } from "../utils/async-handler";

const requireSuperAdmin = AuthService.requireRole(['super_admin']);

export function registerAdminBackfillRoutes(app: Express): void {
  // POST /api/_admin/backfills/call-direction
  //
  // Idempotently fills in metadata.direction = 'outbound' for historical call
  // activities that were created by our in-app call endpoints before they
  // started stamping the field. Without this, the Speed-to-Lead report (which
  // filters on metadata.direction = 'outbound') silently drops these rows.
  //
  // Confident-inference rules (anything that doesn't match is left alone):
  //   - title = 'Phone call initiated'
  //       → POST /api/calls/initiate (in-app "Call" button)
  //   - content LIKE 'Outbound call to %'
  //       → POST /api/calls/log-personal (manual "log a personal call")
  //
  // The metadata column is declared jsonb in shared/schema/activities.ts but
  // has historically been written as a JSON-serialized text blob (see the
  // drift comment in that file). The expression below works for both shapes:
  // it casts to jsonb if needed, merges in the new field, and writes back.
  app.post(
    "/api/_admin/backfills/call-direction",
    requireAuth,
    requireSuperAdmin,
    asyncHandler(async (_req: AuthedRequest, res: Response) => {
      const result = await db.execute<{ id: string }>(sql`
        UPDATE activities
        SET metadata =
          COALESCE(NULLIF(metadata::text, '')::jsonb, '{}'::jsonb)
          || '{"direction":"outbound"}'::jsonb
        WHERE type = 'call'
          AND (
            metadata IS NULL
            OR COALESCE((metadata::jsonb)->>'direction', '') = ''
          )
          AND (
            title = 'Phone call initiated'
            OR content LIKE 'Outbound call to %'
          )
        RETURNING id
      `);
      res.json({
        updated: result.rows.length,
      });
    }),
  );
}
