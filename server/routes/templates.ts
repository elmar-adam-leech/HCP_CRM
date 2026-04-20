import type { Express } from "express";
import { asyncHandler } from "../utils/async-handler";
import { parseBody } from "../utils/validate-body";
import { storage } from "../storage";
import { insertTemplateSchema, templates } from "@shared/schema";
import { db } from "../db";
import { eq, and, or, desc } from "drizzle-orm";
import { requireManagerOrAdmin, requireAdmin } from "../auth-service";
import { auditLog } from "../utils/audit-log";
import { logger } from "../utils/logger";

const log = logger('TemplateRoutes');

// Default page size for the templates list. Clients can pass ?limit=N (max 200)
// and ?offset=N for cursor-style pagination. This prevents unbounded memory use
// on large tenants and keeps response times predictable.
// TODO: Switch to keyset (cursor) pagination once clients support it.
const TEMPLATES_DEFAULT_LIMIT = 200;
const TEMPLATES_MAX_LIMIT = 200;

export function registerTemplateRoutes(app: Express): void {
  app.get("/api/templates", asyncHandler(async (req, res) => {
    const type = req.query.type as 'text' | 'email' | undefined;
    const isAdmin = req.user.role === 'admin' || req.user.role === 'super_admin';
    const userId = req.user.userId;
    const contractorId = req.user.contractorId;

    // Parse optional pagination query params; clamp to a safe positive range.
    const rawLimit = parseInt(req.query.limit as string, 10);
    const limit = Number.isNaN(rawLimit)
      ? TEMPLATES_DEFAULT_LIMIT
      : Math.max(1, Math.min(rawLimit, TEMPLATES_MAX_LIMIT));
    const rawOffset = parseInt(req.query.offset as string, 10);
    const offset = Number.isNaN(rawOffset) ? 0 : Math.max(0, rawOffset);

    // Non-admin visibility rule: a template is visible when it is either
    //   (a) approved (globally visible to the whole contractor team), or
    //   (b) owned by the requesting user (creator can always see their own drafts).
    // Admins see all templates regardless of status.
    // Pushing this into SQL ensures the limit is applied AFTER visibility filtering
    // so callers always get up to `limit` visible rows, not fewer.
    const visibilityCondition = isAdmin
      ? undefined
      : or(eq(templates.status, 'approved'), eq(templates.createdBy, userId));

    const conditions = [
      eq(templates.contractorId, contractorId),
      ...(type ? [eq(templates.type, type)] : []),
      ...(visibilityCondition ? [visibilityCondition] : []),
    ];

    // Deterministic sort (updatedAt desc, then id desc as tiebreaker) ensures
    // stable pagination across concurrent writes — without orderBy, offset pages
    // can return duplicate or skipped rows when the table is modified mid-page.
    const filteredTemplates = await db.select().from(templates)
      .where(and(...conditions))
      .orderBy(desc(templates.updatedAt), desc(templates.id))
      .limit(limit)
      .offset(offset);

    res.json(filteredTemplates);
  }));

  app.get("/api/templates/:id", asyncHandler(async (req, res) => {
    const template = await storage.getTemplate(req.params.id, req.user.contractorId);
    if (!template) {
      res.status(404).json({ message: "Template not found" });
      return;
    }
    res.json(template);
  }));

  app.post("/api/templates", asyncHandler(async (req, res) => {
    const templateData = parseBody(insertTemplateSchema.omit({ contractorId: true, createdBy: true }), req, res);
    if (!templateData) return;

    const dataWithUser = {
      ...templateData,
      createdBy: req.user.userId,
    };

    const template = await storage.createTemplate(dataWithUser, req.user.contractorId);
    auditLog({
      contractorId: req.user.contractorId,
      userId: req.user.userId,
      action: 'template.create',
      entityType: 'template',
      entityId: template.id,
      after: { title: template.title, type: template.type, status: template.status },
    }).catch(err => log.error('Failed to write audit log for template creation', err));
    res.status(201).json(template);
  }));

  app.put("/api/templates/:id", requireManagerOrAdmin, asyncHandler(async (req, res) => {
    const updateData = parseBody(insertTemplateSchema.omit({ contractorId: true, createdBy: true }).partial(), req, res);
    if (!updateData) return;

    const template = await storage.updateTemplate(req.params.id, updateData, req.user.contractorId);
    if (!template) {
      res.status(404).json({ message: "Template not found" });
      return;
    }
    auditLog({
      contractorId: req.user.contractorId,
      userId: req.user.userId,
      action: 'template.update',
      entityType: 'template',
      entityId: template.id,
      after: updateData as Record<string, unknown>,
    }).catch(err => log.error('Failed to write audit log for template update', err));
    res.json(template);
  }));

  app.delete("/api/templates/:id", requireManagerOrAdmin, asyncHandler(async (req, res) => {
    const success = await storage.deleteTemplate(req.params.id, req.user.contractorId);
    if (!success) {
      res.status(404).json({ message: "Template not found" });
      return;
    }
    auditLog({
      contractorId: req.user.contractorId,
      userId: req.user.userId,
      action: 'template.delete',
      entityType: 'template',
      entityId: req.params.id,
    }).catch(err => log.error('Failed to write audit log for template deletion', err));
    res.json({ message: "Template deleted successfully" });
  }));

  app.post("/api/templates/:id/approve", requireAdmin, asyncHandler(async (req, res) => {
    const { id } = req.params;

    const updated = await db.update(templates)
      .set({
        status: 'approved',
        approvedBy: req.user.userId,
        approvedAt: new Date()
      })
      .where(and(
        eq(templates.id, id),
        eq(templates.contractorId, req.user.contractorId)
      ))
      .returning();

    if (updated.length === 0) {
      res.status(404).json({ message: "Template not found" });
      return;
    }

    auditLog({
      contractorId: req.user.contractorId,
      userId: req.user.userId,
      action: 'template.approve',
      entityType: 'template',
      entityId: id,
      after: { status: 'approved' },
    }).catch(err => log.error('Failed to write audit log for template approval', err));
    res.json({ ...updated[0], message: "Template approved successfully" });
  }));

  app.post("/api/templates/:id/reject", requireAdmin, asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { rejectionReason } = req.body;

    const updated = await db.update(templates)
      .set({
        status: 'rejected',
        rejectionReason: rejectionReason || 'No reason provided',
        approvedBy: req.user.userId,
        approvedAt: new Date()
      })
      .where(and(
        eq(templates.id, id),
        eq(templates.contractorId, req.user.contractorId)
      ))
      .returning();

    if (updated.length === 0) {
      res.status(404).json({ message: "Template not found" });
      return;
    }

    auditLog({
      contractorId: req.user.contractorId,
      userId: req.user.userId,
      action: 'template.reject',
      entityType: 'template',
      entityId: id,
      after: { status: 'rejected', rejectionReason: rejectionReason || 'No reason provided' },
    }).catch(err => log.error('Failed to write audit log for template rejection', err));
    res.json({ ...updated[0], message: "Template rejected" });
  }));
}
