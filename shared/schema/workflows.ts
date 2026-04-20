import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, timestamp, boolean, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { workflowTriggerTypeEnum, workflowActionTypeEnum, workflowExecutionStatusEnum, workflowApprovalStatusEnum } from "./enums";
import { contractors } from "./settings";
import { users } from "./users";

// Workflows table for automation workflows
export const workflows = pgTable("workflows", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  contractorId: varchar("contractor_id").notNull().references(() => contractors.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  isActive: boolean("is_active").notNull().default(false),
  triggerType: workflowTriggerTypeEnum("trigger_type").notNull(),
  triggerConfig: text("trigger_config").notNull(), // JSON config for trigger (entity type, field, conditions, etc.)
  approvalStatus: workflowApprovalStatusEnum("approval_status").notNull().default("pending_approval"),
  approvedBy: varchar("approved_by").references(() => users.id), // Admin who approved/rejected the workflow
  approvedAt: timestamp("approved_at"), // When workflow was approved/rejected
  rejectionReason: text("rejection_reason"), // Optional reason for rejection
  createdBy: varchar("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  contractorIdIdx: index("workflows_contractor_id_idx").on(table.contractorId),
  isActiveIdx: index("workflows_is_active_idx").on(table.isActive),
  triggerTypeIdx: index("workflows_trigger_type_idx").on(table.triggerType),
  approvalStatusIdx: index("workflows_approval_status_idx").on(table.approvalStatus),
  contractorActiveIdx: index("workflows_contractor_active_idx").on(table.contractorId, table.isActive),
  contractorApprovalIdx: index("workflows_contractor_approval_idx").on(table.contractorId, table.approvalStatus),
}));

export const insertWorkflowSchema = createInsertSchema(workflows).omit({
  id: true,
  contractorId: true,
  approvalStatus: true,
  approvedBy: true,
  approvedAt: true,
  rejectionReason: true,
  createdBy: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertWorkflow = z.infer<typeof insertWorkflowSchema>;
export type Workflow = typeof workflows.$inferSelect;

// Workflow steps table for individual actions in a workflow
export const workflowSteps = pgTable("workflow_steps", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  workflowId: varchar("workflow_id").notNull().references(() => workflows.id, { onDelete: "cascade" }),
  stepOrder: integer("step_order").notNull(),
  actionType: workflowActionTypeEnum("action_type").notNull(),
  actionConfig: text("action_config").notNull(), // JSON config for action (email template, field updates, AI prompts, etc.)
  parentStepId: varchar("parent_step_id"), // For conditional branches - self-reference
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  workflowIdIdx: index("workflow_steps_workflow_id_idx").on(table.workflowId),
  workflowOrderIdx: index("workflow_steps_workflow_order_idx").on(table.workflowId, table.stepOrder),
  // Index for recursive step traversal when building conditional branch trees
  parentStepIdIdx: index("workflow_steps_parent_step_id_idx").on(table.parentStepId),
}));

export const insertWorkflowStepSchema = createInsertSchema(workflowSteps).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertWorkflowStep = z.infer<typeof insertWorkflowStepSchema>;
export type WorkflowStep = typeof workflowSteps.$inferSelect;

// Workflow executions table for tracking workflow runs
export const workflowExecutions = pgTable("workflow_executions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  workflowId: varchar("workflow_id").notNull().references(() => workflows.id, { onDelete: "cascade" }),
  contractorId: varchar("contractor_id").notNull().references(() => contractors.id, { onDelete: "cascade" }),
  status: workflowExecutionStatusEnum("status").notNull().default("pending"),
  triggerData: text("trigger_data"), // JSON data about what triggered the workflow (entity ID, field values, etc.)
  executionLog: text("execution_log"), // JSON log of each step execution with results/errors
  errorMessage: text("error_message"),
  currentStep: integer("current_step"), // Step order currently being executed (for progress tracking)
  resumeAt: timestamp("resume_at"), // When to resume a suspended execution (for delay steps)
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  workflowIdIdx: index("workflow_executions_workflow_id_idx").on(table.workflowId),
  contractorIdIdx: index("workflow_executions_contractor_id_idx").on(table.contractorId),
  statusIdx: index("workflow_executions_status_idx").on(table.status),
  createdAtIdx: index("workflow_executions_created_at_idx").on(table.createdAt),
  workflowStatusIdx: index("workflow_executions_workflow_status_idx").on(table.workflowId, table.status),
  // Composite index for the execution history view: filter by workflow, then page by date.
  // Without this, Postgres must intersect two separate indexes (workflowId + createdAt),
  // which is slower than a single covering scan.
  workflowCreatedAtIdx: index("workflow_executions_workflow_created_at_idx").on(table.workflowId, table.createdAt),
}));

export const insertWorkflowExecutionSchema = createInsertSchema(workflowExecutions).omit({
  id: true,
  createdAt: true,
});
export type InsertWorkflowExecution = z.infer<typeof insertWorkflowExecutionSchema>;
export type WorkflowExecution = typeof workflowExecutions.$inferSelect;
