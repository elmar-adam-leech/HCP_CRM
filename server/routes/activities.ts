import type { Express } from "express";
import { asyncHandler } from "../utils/async-handler";
import { parseBody } from "../utils/validate-body";
import { storage } from "../storage";
import { insertActivitySchema } from "@shared/schema";
import { requireManagerOrAdmin, requireAdmin } from "../auth-service";
import { broadcastToContractor } from "../websocket";
import { messageCleanupService } from "../services/message-cleanup";
import { encodeActivityCursor } from "../storage/activities";
import { createDateInTimezone } from "../utils/time";
import { z } from "zod";

// Convert a calendar day ("YYYY-MM-DD") + IANA timezone into the UTC instant for
// the START of that day (offset by `dayOffset` days) in that timezone. Anchoring
// at noon UTC keeps the calendar day stable across the US timezones this CRM
// serves before createDateInTimezone walks it back to local midnight.
function ymdToUtcDayStart(ymd: string, dayOffset: number, timezone: string): Date {
  const [y, m, d] = ymd.split('-').map(Number);
  const noonAnchor = new Date(Date.UTC(y, m - 1, d + dayOffset, 12, 0, 0));
  return createDateInTimezone(noonAnchor, 0, 0, timezone);
}

// Zod schema for the GET /api/activities query parameters.
// Previously these were manually cast with parseInt/as-string, which silently
// produced NaN for non-numeric limit/offset values.
const activitiesQuerySchema = z.object({
  contactId:  z.string().optional(),
  leadId:     z.string().optional(),
  customerId: z.string().optional(),
  estimateId: z.string().optional(),
  jobId:      z.string().optional(),
  type:       z.enum(['note', 'call', 'email', 'sms', 'meeting', 'follow_up', 'status_change']).optional(),
  limit:      z.coerce.number().int().min(1).max(500).optional(),
  // cursor: opaque base64 keyset token encoding (createdAt, id) — replaces offset.
  // Enables O(1) keyset pagination instead of O(N) OFFSET scans.
  // Obtain the cursor value from the X-Next-Cursor response header of the previous page.
  cursor:     z.string().optional(),
});

// Query params for GET /api/calls (Calls history section, task #876).
const ymdRegex = /^\d{4}-\d{2}-\d{2}$/;
const callsQuerySchema = z.object({
  direction:  z.enum(['inbound', 'outbound']).optional(),
  assignment: z.enum(['assigned', 'unassigned']).optional(),
  // Inclusive calendar-day range (interpreted in the contractor's timezone).
  startDate:  z.string().regex(ymdRegex, "startDate must be YYYY-MM-DD").optional(),
  endDate:    z.string().regex(ymdRegex, "endDate must be YYYY-MM-DD").optional(),
  limit:      z.coerce.number().int().min(1).max(200).optional(),
  cursor:     z.string().optional(),
});

// Body for POST /api/calls/:id/link.
const callLinkSchema = z.object({
  contactId: z.string().min(1, "contactId is required"),
});

export function registerActivityRoutes(app: Express): void {
  app.get("/api/activities", asyncHandler(async (req, res) => {
    const parsed = activitiesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ message: parsed.error.issues[0]?.message ?? "Invalid query parameters" });
      return;
    }
    const { contactId, leadId, customerId, estimateId, jobId, type, limit, cursor } = parsed.data;
    const resolvedContactId = contactId || leadId || customerId;
    const pageLimit = limit || 50;
    // Fetch one extra row to determine whether a next page exists.
    const rows = await storage.getActivities(req.user.contractorId, {
      contactId: resolvedContactId,
      estimateId,
      jobId,
      type,
      limit: pageLimit + 1,
      cursor,
    });
    const hasMore = rows.length > pageLimit;
    if (hasMore) rows.pop();
    // Expose next-page cursor via header so existing callers (which expect a flat
    // array body) are unaffected. New callers can read X-Next-Cursor to paginate.
    if (hasMore && rows.length > 0) {
      const last = rows[rows.length - 1];
      res.setHeader('X-Next-Cursor', encodeActivityCursor(last.createdAt, last.id));
    }
    res.json(rows);
  }));

  app.get("/api/activities/:id", asyncHandler(async (req, res) => {
    const activity = await storage.getActivity(req.params.id, req.user.contractorId);
    if (!activity) {
      res.status(404).json({ message: "Activity not found" });
      return;
    }
    res.json(activity);
  }));

  app.post("/api/activities", asyncHandler(async (req, res) => {
    const activityData = parseBody(insertActivitySchema.omit({ contractorId: true }), req, res);
    if (!activityData) return;
    // For call activities logged via this endpoint, default metadata.direction
    // to 'outbound' so the Speed-to-Lead report (which filters on
    // metadata.direction = 'outbound') counts manually-logged calls. We only
    // fill in a missing value — explicit caller-supplied directions win.
    let finalMetadata = activityData.metadata;
    if (activityData.type === 'call') {
      const meta = (finalMetadata && typeof finalMetadata === 'object'
        ? finalMetadata
        : {}) as Record<string, unknown>;
      if (typeof meta.direction !== 'string') {
        finalMetadata = { ...meta, direction: 'outbound' };
      }
    }
    const activity = await storage.createActivity(
      { ...activityData, metadata: finalMetadata, userId: req.user.userId },
      req.user.contractorId
    );
    const contactId = activity.contactId;
    if (contactId && ['call', 'email', 'sms'].includes(activity.type)) {
      await storage.markContactContacted(contactId, req.user.contractorId, req.user.userId);
      await storage.markLeadContacted(contactId, req.user.contractorId, req.user.userId);
    }
    broadcastToContractor(req.user.contractorId, {
      type: 'activity_created',
      activityId: activity.id,
      contactId: activity.contactId ?? undefined,
    });
    res.status(201).json(activity);
  }));

  app.put("/api/activities/:id", requireManagerOrAdmin, asyncHandler(async (req, res) => {
    const updateData = parseBody(insertActivitySchema.omit({ contractorId: true, userId: true }).partial(), req, res);
    if (!updateData) return;
    const activity = await storage.updateActivity(req.params.id, updateData, req.user.contractorId);
    if (!activity) {
      res.status(404).json({ message: "Activity not found" });
      return;
    }
    broadcastToContractor(req.user.contractorId, {
      type: 'activity_updated',
      activityId: activity.id,
      contactId: activity.contactId ?? undefined,
    });
    res.json(activity);
  }));

  app.delete("/api/activities/:id", requireManagerOrAdmin, asyncHandler(async (req, res) => {
    const deleted = await storage.deleteActivity(req.params.id, req.user.contractorId);
    if (!deleted) {
      res.status(404).json({ message: "Activity not found" });
      return;
    }
    broadcastToContractor(req.user.contractorId, {
      type: 'activity_deleted',
      activityId: req.params.id,
    });
    res.json({ message: "Activity deleted successfully" });
  }));

  // --- Calls history section (task #876) ---------------------------------
  // Tenant-wide list of `call` activities (including UNASSIGNED inbound calls
  // that matched no contact), newest first, with direction + assignment
  // filters and (createdAt, id) keyset pagination. Scoped to the session's
  // active contractor exactly like the rest of the CRM.
  app.get("/api/calls", asyncHandler(async (req, res) => {
    const parsed = callsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ message: parsed.error.issues[0]?.message ?? "Invalid query parameters" });
      return;
    }
    const { direction, assignment, startDate, endDate, limit, cursor } = parsed.data;
    const pageLimit = limit || 50;

    // Resolve the date range in the contractor's timezone so "Today"/day
    // boundaries match the rep's local calendar, not the server's UTC clock.
    let startTs: Date | undefined;
    let endTs: Date | undefined;
    if (startDate || endDate) {
      const contractor = await storage.getContractor(req.user.contractorId);
      const timezone = (contractor && 'timezone' in contractor && typeof (contractor as { timezone?: unknown }).timezone === 'string'
        ? (contractor as { timezone: string }).timezone
        : null) || 'America/New_York';
      if (startDate) startTs = ymdToUtcDayStart(startDate, 0, timezone);
      // Exclusive upper bound = start of the day AFTER endDate.
      if (endDate) endTs = ymdToUtcDayStart(endDate, 1, timezone);
    }

    const rows = await storage.getCallActivities(req.user.contractorId, {
      direction,
      assignment,
      startTs,
      endTs,
      limit: pageLimit + 1,
      cursor,
    });
    const hasMore = rows.length > pageLimit;
    if (hasMore) rows.pop();
    let nextCursor: string | null = null;
    if (hasMore && rows.length > 0) {
      const last = rows[rows.length - 1];
      nextCursor = encodeActivityCursor(last.createdAt, last.id);
    }
    res.json({ calls: rows, nextCursor });
  }));

  // Link an UNASSIGNED call activity to a contact. Regular users may do this
  // (unlike PUT /api/activities/:id which is manager/admin-only) because it is
  // the final step of the create-contact-from-call flow. Only calls that are
  // currently unassigned can be linked here — already-linked calls are out of
  // scope (no reassignment).
  app.post("/api/calls/:id/link", asyncHandler(async (req, res) => {
    const parsed = callLinkSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: parsed.error.issues[0]?.message ?? "Invalid request body" });
      return;
    }
    const { contactId } = parsed.data;

    const activity = await storage.getActivity(req.params.id, req.user.contractorId);
    if (!activity || activity.type !== 'call') {
      res.status(404).json({ message: "Call not found" });
      return;
    }
    if (activity.contactId) {
      res.status(409).json({ message: "This call is already linked to a contact" });
      return;
    }

    const contact = await storage.getContact(contactId, req.user.contractorId);
    if (!contact) {
      res.status(404).json({ message: "Contact not found" });
      return;
    }

    const updated = await storage.updateActivity(req.params.id, { contactId }, req.user.contractorId);
    if (!updated) {
      res.status(404).json({ message: "Call not found" });
      return;
    }
    await storage.markContactContacted(contactId, req.user.contractorId, req.user.userId);
    await storage.markLeadContacted(contactId, req.user.contractorId, req.user.userId);

    broadcastToContractor(req.user.contractorId, {
      type: 'activity_updated',
      activityId: updated.id,
      contactId,
    });
    res.json(updated);
  }));

  app.post("/api/admin/cleanup-orphaned-activities", requireAdmin, asyncHandler(async (req, res) => {
    const outcome = await messageCleanupService.forceCleanupForContractor(req.user.contractorId);
    if (!outcome.success) {
      res.status(500).json({ message: "Cleanup failed", error: String(outcome.error) });
      return;
    }
    res.json({
      deleted: (outcome.result?.deletedMessagesCount ?? 0) + (outcome.result?.deletedActivitiesCount ?? 0),
      deletedActivities: outcome.result?.deletedActivitiesCount ?? 0,
      deletedMessages: outcome.result?.deletedMessagesCount ?? 0,
    });
  }));
}
