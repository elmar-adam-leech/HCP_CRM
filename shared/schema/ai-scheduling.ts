import { sql } from "drizzle-orm";
import { pgTable, text, varchar, timestamp, integer, index, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { contractors } from "./settings";
import { contacts } from "./contacts";
import { messages } from "./messages";
import { workflowExecutions } from "./workflows";
import { users } from "./users";

// AI scheduling conversations — one row per active scheduling-intent
// conversation between the AI agent and a contact. At most one open
// conversation per (contractorId, contactId) is enforced via partial unique
// index on the open statuses.
export const aiSchedulingConversations = pgTable("ai_scheduling_conversations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  contractorId: varchar("contractor_id").notNull().references(() => contractors.id, { onDelete: "cascade" }),
  contactId: varchar("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
  triggeringMessageId: varchar("triggering_message_id").references(() => messages.id, { onDelete: "set null" }),
  triggeringWorkflowExecutionId: varchar("triggering_workflow_execution_id").references(() => workflowExecutions.id, { onDelete: "set null" }),
  // 'active' | 'awaiting_confirmation' | 'booked' | 'handed_off' | 'failed'
  status: text("status").notNull().default("active"),
  proposedStartTime: timestamp("proposed_start_time"),
  proposedSalespersonUserId: varchar("proposed_salesperson_user_id").references(() => users.id, { onDelete: "set null" }),
  proposedAddress: text("proposed_address"),
  exchangeCount: integer("exchange_count").notNull().default(0),
  lastInboundMessageId: varchar("last_inbound_message_id").references(() => messages.id, { onDelete: "set null" }),
  lastOutboundMessageId: varchar("last_outbound_message_id").references(() => messages.id, { onDelete: "set null" }),
  handoffReason: text("handoff_reason"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  contractorIdx: index("ai_sched_conv_contractor_idx").on(table.contractorId),
  contactIdx: index("ai_sched_conv_contact_idx").on(table.contactId),
  statusIdx: index("ai_sched_conv_status_idx").on(table.status),
  // Only one OPEN (active or awaiting_confirmation) conversation per contact.
  // Closed states are repeatable (a contact may complete one and start another).
  uniqueOpenIdx: uniqueIndex("ai_sched_conv_unique_open_idx")
    .on(table.contractorId, table.contactId)
    .where(sql`status IN ('active','awaiting_confirmation')`),
}));

export const insertAiSchedulingConversationSchema = createInsertSchema(aiSchedulingConversations).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertAiSchedulingConversation = z.infer<typeof insertAiSchedulingConversationSchema>;
export type AiSchedulingConversation = typeof aiSchedulingConversations.$inferSelect;
