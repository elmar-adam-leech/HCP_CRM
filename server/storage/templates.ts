import {
  type Template, type InsertTemplate,
  templates,
} from "@shared/schema";
import { db } from "../db";
import { eq, and } from "drizzle-orm";
import type { UpdateTemplate } from "../storage-types";

async function getTemplates(contractorId: string, type?: 'text' | 'email'): Promise<Template[]> {
  const conditions = [eq(templates.contractorId, contractorId)];
  if (type) conditions.push(eq(templates.type, type));
  return await db.select().from(templates).where(and(...conditions)).limit(200);
}

async function getTemplate(id: string, contractorId: string): Promise<Template | undefined> {
  const result = await db.select().from(templates).where(and(eq(templates.id, id), eq(templates.contractorId, contractorId))).limit(1);
  return result[0];
}

async function createTemplate(template: Omit<InsertTemplate, 'contractorId'>, contractorId: string): Promise<Template> {
  const result = await db.insert(templates).values({ ...template, contractorId }).returning();
  return result[0];
}

async function updateTemplate(id: string, template: UpdateTemplate, contractorId: string): Promise<Template | undefined> {
  const result = await db.update(templates)
    .set({ ...template, updatedAt: new Date() })
    .where(and(eq(templates.id, id), eq(templates.contractorId, contractorId)))
    .returning();
  return result[0];
}

async function deleteTemplate(id: string, contractorId: string): Promise<boolean> {
  const result = await db.delete(templates).where(and(eq(templates.id, id), eq(templates.contractorId, contractorId)));
  return (result.rowCount ?? 0) > 0;
}

export const templateMethods = {
  getTemplates,
  getTemplate,
  createTemplate,
  updateTemplate,
  deleteTemplate,
};
