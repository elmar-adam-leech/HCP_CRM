import type { Express } from "express";
import { asyncHandler } from "../utils/async-handler";
import { requireManagerOrAdmin } from "../auth-service";
import { db } from "../db";
import { assignmentRules, leads, users } from "@shared/schema";
import { eq, and, asc } from "drizzle-orm";
import { z } from "zod";
import { parseBody } from "../utils/validate-body";
import { logger } from "../utils/logger";

const log = logger('AssignmentRoutes');

const ruleConditionSchema = z.object({
  field: z.enum(["source", "campaign", "adName", "status", "tag"]),
  operator: z.enum(["equals", "contains", "startsWith"]),
  value: z.string(),
});

const createRuleSchema = z.object({
  name: z.string().min(1),
  conditions: z.array(ruleConditionSchema).default([]),
  assignToUserId: z.string().nullable().optional(),
  priority: z.number().int().min(0).default(0),
  isActive: z.boolean().default(true),
});

const updateRuleSchema = createRuleSchema.partial();

export function registerAssignmentRoutes(app: Express): void {
  app.get("/api/assignment-rules", requireManagerOrAdmin, asyncHandler(async (req, res) => {
    const rules = await db
      .select({
        id: assignmentRules.id,
        contractorId: assignmentRules.contractorId,
        name: assignmentRules.name,
        conditions: assignmentRules.conditions,
        assignToUserId: assignmentRules.assignToUserId,
        priority: assignmentRules.priority,
        isActive: assignmentRules.isActive,
        createdAt: assignmentRules.createdAt,
        assignToUserName: users.name,
      })
      .from(assignmentRules)
      .leftJoin(users, eq(assignmentRules.assignToUserId, users.id))
      .where(eq(assignmentRules.contractorId, req.user.contractorId))
      .orderBy(asc(assignmentRules.priority), asc(assignmentRules.createdAt));

    res.json(rules.map(r => ({
      ...r,
      conditions: JSON.parse(r.conditions || '[]'),
    })));
  }));

  app.post("/api/assignment-rules", requireManagerOrAdmin, asyncHandler(async (req, res) => {
    const parsed = parseBody(createRuleSchema, req, res);
    if (!parsed) return;

    const [created] = await db.insert(assignmentRules).values({
      contractorId: req.user.contractorId,
      name: parsed.name,
      conditions: JSON.stringify(parsed.conditions),
      assignToUserId: parsed.assignToUserId || null,
      priority: parsed.priority,
      isActive: parsed.isActive,
    }).returning();

    res.status(201).json({ ...created, conditions: parsed.conditions });
  }));

  app.patch("/api/assignment-rules/:ruleId", requireManagerOrAdmin, asyncHandler(async (req, res) => {
    const { ruleId } = req.params;
    const parsed = parseBody(updateRuleSchema, req, res);
    if (!parsed) return;

    const existing = await db.select().from(assignmentRules)
      .where(and(eq(assignmentRules.id, ruleId), eq(assignmentRules.contractorId, req.user.contractorId)))
      .limit(1);

    if (!existing[0]) {
      res.status(404).json({ message: "Rule not found" });
      return;
    }

    const updateData: Record<string, unknown> = { updatedAt: new Date() };
    if (parsed.name !== undefined) updateData.name = parsed.name;
    if (parsed.conditions !== undefined) updateData.conditions = JSON.stringify(parsed.conditions);
    if (parsed.assignToUserId !== undefined) updateData.assignToUserId = parsed.assignToUserId || null;
    if (parsed.priority !== undefined) updateData.priority = parsed.priority;
    if (parsed.isActive !== undefined) updateData.isActive = parsed.isActive;

    const [updated] = await db.update(assignmentRules)
      .set(updateData)
      .where(and(eq(assignmentRules.id, ruleId), eq(assignmentRules.contractorId, req.user.contractorId)))
      .returning();

    res.json({ ...updated, conditions: JSON.parse(updated.conditions || '[]') });
  }));

  app.delete("/api/assignment-rules/:ruleId", requireManagerOrAdmin, asyncHandler(async (req, res) => {
    const { ruleId } = req.params;

    const deleted = await db.delete(assignmentRules)
      .where(and(eq(assignmentRules.id, ruleId), eq(assignmentRules.contractorId, req.user.contractorId)))
      .returning();

    if (!deleted[0]) {
      res.status(404).json({ message: "Rule not found" });
      return;
    }

    res.json({ message: "Rule deleted" });
  }));

  app.patch("/api/leads/:leadId/assign", asyncHandler(async (req, res) => {
    const { leadId } = req.params;
    const { assignToUserId } = req.body;

    const existing = await db.select().from(leads)
      .where(and(eq(leads.id, leadId), eq(leads.contractorId, req.user.contractorId)))
      .limit(1);

    if (!existing[0]) {
      res.status(404).json({ message: "Lead not found" });
      return;
    }

    const [updated] = await db.update(leads)
      .set({ assignedToUserId: assignToUserId || null, updatedAt: new Date() })
      .where(and(eq(leads.id, leadId), eq(leads.contractorId, req.user.contractorId)))
      .returning();

    res.json(updated);
  }));
}

export async function autoAssignLead(leadId: string, contractorId: string, leadData: {
  source?: string | null;
  message?: string | null;
  utmCampaign?: string | null;
  status?: string;
  tags?: string[] | null;
}): Promise<string | null> {
  try {
    const rules = await db
      .select()
      .from(assignmentRules)
      .where(and(
        eq(assignmentRules.contractorId, contractorId),
        eq(assignmentRules.isActive, true),
      ))
      .orderBy(asc(assignmentRules.priority), asc(assignmentRules.createdAt));

    for (const rule of rules) {
      if (!rule.assignToUserId) continue;
      const conditions: Array<{ field: string; operator: string; value: string }> = JSON.parse(rule.conditions || '[]');

      const matchesAll = conditions.every(cond => {
        if (cond.field === 'tag') {
          const tags = leadData.tags;
          if (!tags || tags.length === 0) return false;
          const cv = cond.value.toLowerCase();
          return tags.some(t => {
            const v = t.toLowerCase();
            if (cond.operator === 'equals') return v === cv;
            if (cond.operator === 'contains') return v.includes(cv);
            if (cond.operator === 'startsWith') return v.startsWith(cv);
            return false;
          });
        }

        let fieldValue = '';
        if (cond.field === 'source') fieldValue = leadData.source || '';
        else if (cond.field === 'campaign') fieldValue = leadData.utmCampaign || '';
        else if (cond.field === 'adName') fieldValue = leadData.message || '';
        else if (cond.field === 'status') fieldValue = leadData.status || '';

        const v = fieldValue.toLowerCase();
        const cv = cond.value.toLowerCase();
        if (cond.operator === 'equals') return v === cv;
        if (cond.operator === 'contains') return v.includes(cv);
        if (cond.operator === 'startsWith') return v.startsWith(cv);
        return false;
      });

      if (matchesAll || conditions.length === 0) {
        await db.update(leads)
          .set({ assignedToUserId: rule.assignToUserId, updatedAt: new Date() })
          .where(and(eq(leads.id, leadId), eq(leads.contractorId, contractorId)));
        return rule.assignToUserId;
      }
    }
  } catch (err) {
    log.error('Auto-assign failed:', err instanceof Error ? err.message : err);
  }
  return null;
}
