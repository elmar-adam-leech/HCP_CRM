import { sql } from "drizzle-orm";
import { pgTable, text, varchar, timestamp, boolean, index, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { messageTypeEnum, messageStatusEnum, messageDirectionEnum, templateTypeEnum, templateStatusEnum, webhookServiceEnum, webhookEventTypeEnum } from "./enums";
import { contractors } from "./settings";
import { users } from "./users";
import { contacts } from "./contacts";
import { estimates } from "./estimates";

// Messages table for texting functionality
export const messages = pgTable("messages", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  type: messageTypeEnum("type").notNull().default("text"),
  status: messageStatusEnum("status").notNull().default("sent"),
  direction: messageDirectionEnum("direction").notNull().default("outbound"), // Track if message is inbound or outbound
  content: text("content").notNull(),
  toNumber: text("to_number").notNull(),
  fromNumber: text("from_number"),
  contactId: varchar("contact_id").references(() => contacts.id, { onDelete: "cascade" }), // Unified contact reference
  estimateId: varchar("estimate_id").references(() => estimates.id, { onDelete: "cascade" }), // Optional estimate context
  userId: varchar("user_id").references(() => users.id, { onDelete: "set null" }), // Track which user sent the message (for outbound) or assigned to (for inbound)
  externalMessageId: text("external_message_id"), // Dialpad message ID for tracking
  contractorId: varchar("contractor_id").notNull().references(() => contractors.id),
  // Set true on outbound messages composed by the AI scheduling agent.
  // Used to badge AI replies in the UI and to filter conversation context.
  aiAuthored: boolean("ai_authored").notNull().default(false),
  // Set true on outbound workflow SMS rows whose workflow step was marked as
  // "scheduling-intent". The inbound webhook reads this flag (within the
  // contractor's `aiSchedulingWindowHours`) to decide whether to engage.
  isSchedulingIntent: boolean("is_scheduling_intent").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  readAt: timestamp("read_at"),
}, (table) => ({
  // Performance indexes for common queries
  contractorIdIdx: index("messages_contractor_id_idx").on(table.contractorId),
  contactIdIdx: index("messages_contact_id_idx").on(table.contactId),
  toNumberIdx: index("messages_to_number_idx").on(table.toNumber),
  fromNumberIdx: index("messages_from_number_idx").on(table.fromNumber),
  directionIdx: index("messages_direction_idx").on(table.direction),
  createdAtIdx: index("messages_created_at_idx").on(table.createdAt),
  estimateIdIdx: index("messages_estimate_id_idx").on(table.estimateId),
  // Composite index for phone conversation lookups
  contractorPhoneIdx: index("messages_contractor_phone_idx").on(table.contractorId, table.toNumber),
  // Composite index for contractor + contact queries
  contractorContactIdx: index("messages_contractor_contact_idx").on(table.contractorId, table.contactId),
  // Index for webhook/sync lookups by external message ID
  externalMessageIdIdx: index("messages_external_message_id_idx").on(table.externalMessageId),
  // Composite index for conversation timeline queries
  contractorContactCreatedIdx: index("messages_contractor_contact_created_idx").on(table.contractorId, table.contactId, table.createdAt),
}));

export const insertMessageSchema = createInsertSchema(messages).omit({
  id: true,
  createdAt: true,
  readAt: true,
});
export type InsertMessage = z.infer<typeof insertMessageSchema>;
export type Message = typeof messages.$inferSelect;

// Webhooks table for tracking webhook configurations
export const webhooks = pgTable("webhooks", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  contractorId: varchar("contractor_id").notNull().references(() => contractors.id),
  service: webhookServiceEnum("service").notNull(), // 'dialpad', 'housecall-pro', etc.
  webhookType: webhookEventTypeEnum("webhook_type").notNull(), // 'sms', 'call', 'estimate', etc.
  externalWebhookId: varchar("external_webhook_id"), // ID from external service (e.g., Dialpad webhook ID)
  webhookUrl: text("webhook_url").notNull(), // The URL endpoint to receive webhooks
  isActive: boolean("is_active").notNull().default(true),
  lastReceivedAt: timestamp("last_received_at"), // Last time we received a webhook
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  // Performance indexes for common queries
  contractorIdIdx: index("webhooks_contractor_id_idx").on(table.contractorId),
  serviceIdx: index("webhooks_service_idx").on(table.service),
  webhookTypeIdx: index("webhooks_webhook_type_idx").on(table.webhookType),
  isActiveIdx: index("webhooks_is_active_idx").on(table.isActive),
  // Composite index for finding active webhooks by service
  contractorServiceIdx: index("webhooks_contractor_service_idx").on(table.contractorId, table.service),
}));

export const insertWebhookSchema = createInsertSchema(webhooks).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertWebhook = z.infer<typeof insertWebhookSchema>;
export type Webhook = typeof webhooks.$inferSelect;

// Webhook events table for logging all webhook events received.
//
// Growth concern: this table accumulates every incoming webhook event indefinitely. At
// 10x write volume (high Dialpad/HCP traffic) the GIN indexes on `payload` and the
// multiple B-tree indexes will degrade write throughput significantly. The standard
// approach is a scheduled job that archives or hard-deletes processed rows older than
// N days (e.g. 30 days). The `processedCreatedAtIdx` composite index is designed to
// make that DELETE efficient (index-only scan on processed + createdAt).
// Cleanup: nightly job deletes processed events >7 days, errored events >30 days, and stuck unprocessed events >30 days.
export const webhookEvents = pgTable("webhook_events", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  webhookId: varchar("webhook_id").references(() => webhooks.id),
  contractorId: varchar("contractor_id").references(() => contractors.id), // Nullable to allow logging before contractor is identified
  service: webhookServiceEnum("service").notNull(), // 'dialpad', 'housecall-pro', etc.
  eventType: varchar("event_type").notNull(), // 'sms.received', 'call.completed', etc.
  payload: text("payload").notNull(), // Full JSON payload from webhook
  processed: boolean("processed").notNull().default(false),
  processedAt: timestamp("processed_at"),
  // Set when background processing has permanently failed (after all retries
  // are exhausted, or when the poller cannot dispatch the row at all). A
  // non-null `failedAt` means the row is terminal but did NOT succeed —
  // distinct from a successful `processed=true`. The poller treats only
  // `processed=false AND failed_at IS NULL` as work to retry.
  failedAt: timestamp("failed_at"),
  errorMessage: text("error_message"), // Store any processing errors
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  // Performance indexes for common queries
  webhookIdIdx: index("webhook_events_webhook_id_idx").on(table.webhookId),
  contractorIdIdx: index("webhook_events_contractor_id_idx").on(table.contractorId),
  serviceIdx: index("webhook_events_service_idx").on(table.service),
  eventTypeIdx: index("webhook_events_event_type_idx").on(table.eventType),
  processedIdx: index("webhook_events_processed_idx").on(table.processed),
  createdAtIdx: index("webhook_events_created_at_idx").on(table.createdAt),
  failedAtIdx: index("webhook_events_failed_at_idx").on(table.failedAt),
  // Composite index for finding unprocessed events
  processedCreatedAtIdx: index("webhook_events_processed_created_at_idx").on(table.processed, table.createdAt),
  // Partial index specifically for the background processor's pending-event
  // lookup. Excludes both successfully processed rows and permanently-failed
  // rows so the index stays small and the poller scan stays cheap.
  unprocessedIdx: index("webhook_events_unprocessed_idx").on(table.createdAt).where(sql`processed = false AND failed_at IS NULL`),
  // Composite index covering the four queries the HCP webhook-health checker
  // runs every tick (latest non-rejection event, latest rejection event,
  // 10-minute rejection count, 24-hour rejection count). Without this the
  // planner has to bitmap-AND across narrow indexes and re-sort by
  // created_at, which under DB-pool pressure was slow enough to surface as
  // `timeout exceeded when trying to connect` and silently fail the health
  // checker (Task #684).
  contractorServiceEventTypeCreatedAtIdx: index("webhook_events_contractor_service_event_type_created_at_idx")
    .on(table.contractorId, table.service, table.eventType, table.createdAt.desc()),
}));

export const insertWebhookEventSchema = createInsertSchema(webhookEvents).omit({
  id: true,
  createdAt: true,
  failedAt: true,
});
export type InsertWebhookEvent = z.infer<typeof insertWebhookEventSchema>;
export type WebhookEvent = typeof webhookEvents.$inferSelect;

// Webhook incidents — durable record of an open "no events received" outage
// for a given (contractorId, service, kind) so admin notifications fire
// exactly once per outage even if the server restarts during it. A row with
// `closed_at IS NULL` represents an open incident; closing it stamps
// `closedAt`. `kind` distinguishes silence ('staleness') from auth-failure
// spikes ('rejection') so the two can coexist.
//
// Also records the most recent backfill attempt for the contractor so the
// settings panel can surface "Last resync" time and the next health-check
// cycle can avoid re-firing a backfill more than once per incident.
export const webhookIncidents = pgTable("webhook_incidents", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  contractorId: varchar("contractor_id").notNull().references(() => contractors.id),
  // varchar (not webhookServiceEnum) — see schema-drift.ts comment.
  service: varchar("service").notNull(),
  // 'staleness' | 'rejection' | 'health-check-failure' | 'subscription-missing'
  // (see server/services/hcp-webhook-health.ts for the full set; varchar is
  // intentional so we can add new kinds without an enum migration).
  kind: varchar("kind").notNull(),
  openedAt: timestamp("opened_at").defaultNow().notNull(),
  closedAt: timestamp("closed_at"),
  notifiedAt: timestamp("notified_at"),
  backfillAttemptedAt: timestamp("backfill_attempted_at"),
  backfillSummary: text("backfill_summary"),
}, (table) => ({
  contractorServiceKindIdx: index("webhook_incidents_contractor_service_kind_idx").on(table.contractorId, table.service, table.kind),
  // UNIQUE partial index: at most one OPEN incident per (contractor, service,
  // kind). This is the atomicity guarantee the health checker relies on —
  // `INSERT ... ON CONFLICT DO NOTHING` will silently no-op when an open
  // incident already exists, making the "open if not already open" path race-free.
  uniqueOpenIdx: uniqueIndex("webhook_incidents_unique_open_idx").on(table.contractorId, table.service, table.kind).where(sql`closed_at IS NULL`),
}));

export type WebhookIncident = typeof webhookIncidents.$inferSelect;

// Templates table for text and email templates
export const templates = pgTable("templates", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  title: text("title").notNull(),
  subject: text("subject"),
  content: text("content").notNull(),
  type: templateTypeEnum("type").notNull(),
  status: templateStatusEnum("status").notNull().default("pending_approval"),
  createdBy: varchar("created_by").notNull().references(() => users.id),
  approvedBy: varchar("approved_by").references(() => users.id),
  approvedAt: timestamp("approved_at"),
  rejectionReason: text("rejection_reason"),
  contractorId: varchar("contractor_id").notNull().references(() => contractors.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  contractorIdIdx: index("templates_contractor_id_idx").on(table.contractorId),
  typeIdx: index("templates_type_idx").on(table.type),
}));

export const insertTemplateSchema = createInsertSchema(templates).omit({
  id: true,
  status: true,
  approvedBy: true,
  approvedAt: true,
  rejectionReason: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertTemplate = z.infer<typeof insertTemplateSchema>;
export type Template = typeof templates.$inferSelect;

