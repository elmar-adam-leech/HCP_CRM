import { sql } from "drizzle-orm";
import { pgTable, text, varchar, timestamp, boolean, integer, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { contractors } from "./settings";
import { users } from "./users";

export const assignmentRules = pgTable("assignment_rules", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  contractorId: varchar("contractor_id").notNull().references(() => contractors.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  conditions: text("conditions").notNull().default("[]"),
  assignToUserId: varchar("assign_to_user_id").references(() => users.id, { onDelete: "set null" }),
  priority: integer("priority").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  contractorIdIdx: index("assignment_rules_contractor_id_idx").on(table.contractorId),
  priorityIdx: index("assignment_rules_priority_idx").on(table.contractorId, table.priority),
}));

export const insertAssignmentRuleSchema = createInsertSchema(assignmentRules).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertAssignmentRule = z.infer<typeof insertAssignmentRuleSchema>;
export type AssignmentRule = typeof assignmentRules.$inferSelect;

export const assignmentConditionSchema = z.object({
  field: z.enum(["source", "campaign", "adName", "status"]),
  operator: z.enum(["equals", "contains", "startsWith"]),
  value: z.string(),
});
export type AssignmentCondition = z.infer<typeof assignmentConditionSchema>;
