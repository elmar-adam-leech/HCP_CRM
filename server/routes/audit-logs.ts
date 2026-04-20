import type { Express, Response } from "express";
import { db } from "../db";
import { auditLogs, users } from "@shared/schema";
import { eq, and, gte, lte, desc } from "drizzle-orm";
import { requireAuth, requireAdmin, type AuthedRequest } from "../auth-service";
import { asyncHandler } from "../utils/async-handler";

export function registerAuditLogRoutes(app: Express): void {

  // GET /api/audit-logs — admin-only paginated audit log
  app.get("/api/audit-logs", requireAuth, requireAdmin, asyncHandler(async (req: AuthedRequest, res: Response) => {
    const contractorId = req.user.contractorId;
    const {
      page = '1',
      limit: limitStr = '50',
      userId: filterUserId,
      action: filterAction,
      dateFrom,
      dateTo,
    } = req.query as {
      page?: string;
      limit?: string;
      userId?: string;
      action?: string;
      dateFrom?: string;
      dateTo?: string;
    };

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(limitStr, 10) || 50));
    const offset = (pageNum - 1) * limit;

    const conditions = [eq(auditLogs.contractorId, contractorId)];

    if (filterUserId) {
      conditions.push(eq(auditLogs.userId, filterUserId));
    }
    if (dateFrom) {
      conditions.push(gte(auditLogs.createdAt, new Date(dateFrom)));
    }
    if (dateTo) {
      const toDate = new Date(dateTo);
      toDate.setHours(23, 59, 59, 999);
      conditions.push(lte(auditLogs.createdAt, toDate));
    }

    const where = conditions.length > 1 ? and(...conditions) : conditions[0];

    // Get total count
    const countResult = await db.select({ id: auditLogs.id })
      .from(auditLogs)
      .where(where);
    const total = countResult.length;

    // Get paginated rows
    let query = db.select({
      id: auditLogs.id,
      userId: auditLogs.userId,
      action: auditLogs.action,
      entityType: auditLogs.entityType,
      entityId: auditLogs.entityId,
      before: auditLogs.before,
      after: auditLogs.after,
      ipAddress: auditLogs.ipAddress,
      userAgent: auditLogs.userAgent,
      createdAt: auditLogs.createdAt,
    }).from(auditLogs).where(where).orderBy(desc(auditLogs.createdAt)).limit(limit).offset(offset);

    // Also filter by action keyword if provided (in-app substring filter)
    const rows = await query;

    const filteredRows = filterAction
      ? rows.filter(r => r.action.toLowerCase().includes(filterAction.toLowerCase()))
      : rows;

    // Enrich with user info
    const userIdsSet = new Set(filteredRows.map(r => r.userId).filter(Boolean) as string[]);
    const userIds = Array.from(userIdsSet);

    // Map userId -> user info
    const allUsers = userIds.length > 0
      ? await Promise.all(userIds.map(uid =>
          db.select({ id: users.id, name: users.name, email: users.email })
            .from(users).where(eq(users.id, uid)).limit(1)
        ))
      : [];

    const userMap: Record<string, { name: string; email: string }> = {};
    allUsers.forEach(arr => {
      if (arr[0]) userMap[arr[0].id] = { name: arr[0].name, email: arr[0].email };
    });

    const enriched = filteredRows.map(row => ({
      ...row,
      user: row.userId ? (userMap[row.userId] ?? null) : null,
    }));

    res.json({
      data: enriched,
      pagination: {
        total: filterAction ? filteredRows.length : total,
        page: pageNum,
        limit,
        totalPages: Math.ceil((filterAction ? filteredRows.length : total) / limit),
      },
    });
  }));
}
