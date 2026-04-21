import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, timestamp, boolean, index, uniqueIndex, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { contractors } from "./settings";
import { users } from "./users";
import { leads } from "./leads";

export const salesProcessActionTypeEnum = pgEnum("sales_process_action_type", ["call", "text", "email"]);
export const salesProcessStepModeEnum = pgEnum("sales_process_step_mode", ["manual", "auto"]);
export const salesProcessTaskStatusEnum = pgEnum("sales_process_task_status", ["pending", "completed", "skipped", "failed"]);
export const salesProcessCompletionReasonEnum = pgEnum("sales_process_completion_reason", [
  "manual",
  "activity_logged",
  "auto_sent",
  "lead_status_changed",
  "step_deleted",
]);

// One row per tenant today (enforced by unique index). Schema is tenant-scoped
// to keep the door open for per-source / per-service variants later without a
// migration — we'd just relax the unique index.
export const salesProcesses = pgTable("sales_processes", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  contractorId: varchar("contractor_id").notNull().references(() => contractors.id, { onDelete: "cascade" }),
  name: text("name").notNull().default("Default sales process"),
  active: boolean("active").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  contractorUnique: uniqueIndex("sales_processes_contractor_unique").on(table.contractorId),
}));

export const salesProcessSteps = pgTable("sales_process_steps", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  salesProcessId: varchar("sales_process_id").notNull().references(() => salesProcesses.id, { onDelete: "cascade" }),
  dayOffset: integer("day_offset").notNull(),
  actionType: salesProcessActionTypeEnum("action_type").notNull(),
  mode: salesProcessStepModeEnum("mode").notNull().default("manual"),
  messageTemplate: text("message_template"),
  displayOrder: integer("display_order").notNull().default(0),
  // Soft-delete: when a manager removes a step, we keep the row (because
  // historical task instances FK-restrict-reference it) but set archivedAt
  // so the cadence engine, the API, and the UI ignore it. The unique index
  // is partial on (archivedAt IS NULL) so the same (day, action) can be
  // re-added later without colliding with the archived ghost.
  archivedAt: timestamp("archived_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  processIdx: index("sales_process_steps_process_idx").on(table.salesProcessId),
  uniquePerProcess: uniqueIndex("sales_process_steps_unique_per_process")
    .on(table.salesProcessId, table.dayOffset, table.actionType)
    .where(sql`archived_at IS NULL`),
}));

export const salesProcessTaskInstances = pgTable("sales_process_task_instances", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  contractorId: varchar("contractor_id").notNull().references(() => contractors.id, { onDelete: "cascade" }),
  leadId: varchar("lead_id").notNull().references(() => leads.id, { onDelete: "cascade" }),
  // Restrict so deleting a step preserves history. We mark pending instances
  // skipped before deleting the step (see PUT /api/sales-process logic).
  stepId: varchar("step_id").notNull().references(() => salesProcessSteps.id, { onDelete: "restrict" }),
  actionType: salesProcessActionTypeEnum("action_type").notNull(),
  mode: salesProcessStepModeEnum("mode").notNull(),
  dueAt: timestamp("due_at").notNull(),
  status: salesProcessTaskStatusEnum("status").notNull().default("pending"),
  completionReason: salesProcessCompletionReasonEnum("completion_reason"),
  completedAt: timestamp("completed_at"),
  completedBy: varchar("completed_by").references(() => users.id),
  failureReason: text("failure_reason"),
  attemptCount: integer("attempt_count").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  tenantStatusDueIdx: index("sales_process_task_instances_tenant_status_due_idx")
    .on(table.contractorId, table.status, table.dueAt),
  leadStatusIdx: index("sales_process_task_instances_lead_status_idx")
    .on(table.leadId, table.status),
}));

export const insertSalesProcessSchema = createInsertSchema(salesProcesses).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertSalesProcess = z.infer<typeof insertSalesProcessSchema>;
export type SalesProcess = typeof salesProcesses.$inferSelect;

export const insertSalesProcessStepSchema = createInsertSchema(salesProcessSteps).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertSalesProcessStep = z.infer<typeof insertSalesProcessStepSchema>;
export type SalesProcessStep = typeof salesProcessSteps.$inferSelect;

export const insertSalesProcessTaskInstanceSchema = createInsertSchema(salesProcessTaskInstances).omit({
  id: true,
  createdAt: true,
});
export type InsertSalesProcessTaskInstance = z.infer<typeof insertSalesProcessTaskInstanceSchema>;
export type SalesProcessTaskInstance = typeof salesProcessTaskInstances.$inferSelect;
