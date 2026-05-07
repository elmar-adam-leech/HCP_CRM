import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, timestamp, boolean, index, uniqueIndex, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { contractors } from "./settings";
import { users } from "./users";
import { leads } from "./leads";
import { estimates } from "./estimates";
import { leadStatusEnum, estimateStatusEnum } from "./enums";

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

// Multi-cadence: a tenant can have many cadences, each scoped to a trigger.
// `trigger_type` decides what fires enrollment; `target_status` narrows the
// fire condition for *_status_changed triggers (null for `lead_created`).
// `entity_type` is derived from the trigger (lead vs estimate) but persisted
// for fast filtering and UI grouping.
export const salesProcesses = pgTable("sales_processes", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  contractorId: varchar("contractor_id").notNull().references(() => contractors.id, { onDelete: "cascade" }),
  name: text("name").notNull().default("Default sales process"),
  active: boolean("active").notNull().default(false),
  triggerType: text("trigger_type").notNull().default("lead_created"),
  targetStatus: text("target_status"),
  entityType: text("entity_type").notNull().default("lead"),
  // Per-cadence "stop" statuses. When the bound entity (lead or estimate)
  // transitions into any status in this list, all pending instances for
  // (this cadence, that entity) are skipped with reason `lead_status_changed`,
  // and no new instances are materialized. Implicit terminals
  // (converted/disqualified/lost for leads; rejected for estimates) always
  // stop the process and are merged with this list at runtime — the column
  // only needs to carry the *additional* user-configured stop statuses.
  // Nullable: legacy rows behave as `[]` (implicit terminals only).
  stopStatuses: text("stop_statuses").array(),
  // Soft-delete column. We never hard-delete cadences because task_instances
  // reference steps with ON DELETE RESTRICT and we want historical tasks to
  // remain navigable after an admin "deletes" a cadence in the UI.
  archivedAt: timestamp("archived_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  // One *active* cadence per (tenant, trigger, target_status). Archived rows
  // are excluded so re-creating a cadence after a delete works.
  triggerUnique: uniqueIndex("sales_processes_trigger_unique")
    .on(table.contractorId, table.triggerType, sql`COALESCE(${table.targetStatus}, '')`)
    .where(sql`archived_at IS NULL`),
  contractorIdx: index("sales_processes_contractor_idx").on(table.contractorId),
}));

export const salesProcessSteps = pgTable("sales_process_steps", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  salesProcessId: varchar("sales_process_id").notNull().references(() => salesProcesses.id, { onDelete: "cascade" }),
  dayOffset: integer("day_offset").notNull(),
  actionType: salesProcessActionTypeEnum("action_type").notNull(),
  mode: salesProcessStepModeEnum("mode").notNull().default("manual"),
  messageTemplate: text("message_template"),
  // Optional rep coaching surfaced on the Follow-Ups page. `callScript` is
  // shown for `actionType === 'call'` (calls have no messageTemplate);
  // `guidance` is shown for any action type. Both nullable; UI hides the
  // affordance when empty. See task #729.
  callScript: text("call_script"),
  guidance: text("guidance"),
  displayOrder: integer("display_order").notNull().default(0),
  archivedAt: timestamp("archived_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  processIdx: index("sales_process_steps_process_idx").on(table.salesProcessId),
  uniquePerProcess: uniqueIndex("sales_process_steps_unique_per_process")
    .on(table.salesProcessId, table.dayOffset, table.actionType)
    .where(sql`archived_at IS NULL`),
}));

// Task instances now belong to either a lead OR an estimate. Exactly one of
// (lead_id, estimate_id) must be set; we enforce this in the materialization
// layer plus partial unique indexes per-entity to suppress double-enrollment.
export const salesProcessTaskInstances = pgTable("sales_process_task_instances", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  contractorId: varchar("contractor_id").notNull().references(() => contractors.id, { onDelete: "cascade" }),
  leadId: varchar("lead_id").references(() => leads.id, { onDelete: "cascade" }),
  estimateId: varchar("estimate_id").references(() => estimates.id, { onDelete: "cascade" }),
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
  estimateStatusIdx: index("sales_process_task_instances_estimate_status_idx")
    .on(table.estimateId, table.status),
  // Hard guarantee at the DB level: every row points at exactly one entity.
  // Materialization code already enforces this in JS, but a CHECK closes the
  // door on stray inserts/migrations introducing half-set rows.
  entityXor: sql`CONSTRAINT sales_process_task_instances_entity_xor CHECK ((lead_id IS NULL) <> (estimate_id IS NULL))`,
  // Partial unique indexes implementing the "one row per (cadence_step,
  // entity)" rule. countTaskInstancesForEntity() gives a fast early-exit;
  // these indexes are the race-proof backstop when concurrent hooks (e.g.
  // a webhook firing while a backfill is mid-loop) try to double-enroll.
  leadStepUnique: uniqueIndex("sales_process_task_instances_lead_step_unique")
    .on(table.stepId, table.leadId)
    .where(sql`lead_id IS NOT NULL`),
  estimateStepUnique: uniqueIndex("sales_process_task_instances_estimate_step_unique")
    .on(table.stepId, table.estimateId)
    .where(sql`estimate_id IS NOT NULL`),
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

export const SALES_PROCESS_TRIGGER_TYPES = ["lead_created", "lead_status_changed", "estimate_status_changed"] as const;
export type SalesProcessTriggerType = typeof SALES_PROCESS_TRIGGER_TYPES[number];

export const SALES_PROCESS_ENTITY_TYPES = ["lead", "estimate"] as const;
export type SalesProcessEntityType = typeof SALES_PROCESS_ENTITY_TYPES[number];

export function entityTypeForTrigger(trigger: SalesProcessTriggerType): SalesProcessEntityType {
  return trigger === "estimate_status_changed" ? "estimate" : "lead";
}

// Discriminated create payload: target_status is required for status-change
// triggers and forbidden for lead_created.
export const createCadenceSchema = z.discriminatedUnion("triggerType", [
  z.object({
    triggerType: z.literal("lead_created"),
    name: z.string().trim().min(1).max(200).optional(),
    active: z.boolean().optional(),
    // Per-cadence early-stop statuses (task #725). Optional at create time;
    // server validates each value against the cadence's entityType enum.
    stopStatuses: z.array(z.string()).max(20).optional(),
  }),
  z.object({
    triggerType: z.literal("lead_status_changed"),
    targetStatus: z.enum(leadStatusEnum.enumValues),
    name: z.string().trim().min(1).max(200).optional(),
    active: z.boolean().optional(),
    stopStatuses: z.array(z.string()).max(20).optional(),
  }),
  z.object({
    triggerType: z.literal("estimate_status_changed"),
    targetStatus: z.enum(estimateStatusEnum.enumValues),
    name: z.string().trim().min(1).max(200).optional(),
    active: z.boolean().optional(),
    stopStatuses: z.array(z.string()).max(20).optional(),
  }),
]);
export type CreateCadenceInput = z.infer<typeof createCadenceSchema>;
