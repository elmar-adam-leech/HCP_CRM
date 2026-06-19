import { sql } from "drizzle-orm";
import { pgTable, text, varchar, timestamp, boolean, index, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { leadStatusEnum } from "./enums";
import { contractors } from "./settings";
import { users } from "./users";
import { contacts } from "./contacts";
import { estimates } from "./estimates";
import { jobs } from "./jobs";

// Leads table - tracks individual lead submissions
// Each submission creates a new lead record, even if from the same contact
// This allows tracking multiple inquiries from the same person over time
export const leads = pgTable("leads", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  contactId: varchar("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }), // Link to deduplicated contact
  status: leadStatusEnum("status").notNull().default("new"), // Lead-specific status
  source: text("source"), // Where this specific lead submission came from
  message: text("message"), // Message or notes from this submission
  housecallProLeadId: varchar("housecall_pro_lead_id"), // HCP lead ID for syncing
  // Google Local Services lead ID (when source = 'google_local_services').
  // First-class column so the GLS poller can locate previously ingested
  // leads by O(1) index lookup instead of LIKE-scanning rawPayload (task #490).
  googleLeadId: varchar("google_lead_id"),
  // Reason this lead was not pushed to Housecall Pro (skip code or failure code).
  // null when push succeeded or HCP sync was never attempted (e.g. integration off + skipHcpSync used).
  // Skip codes: integration_disabled, send_leads_off, skip_tag_matched, no_email_or_phone, integration_credentials_missing.
  // Failure codes: failed_create_customer, failed_create_lead.
  hcpSyncSkipReason: text("hcp_sync_skip_reason"),
  hcpSyncSkipDetail: text("hcp_sync_skip_detail"), // Human-readable detail (e.g. API error message)
  // UTM tracking for this specific submission
  utmSource: text("utm_source"),
  utmMedium: text("utm_medium"),
  utmCampaign: text("utm_campaign"),
  utmTerm: text("utm_term"),
  utmContent: text("utm_content"),
  pageUrl: text("page_url"), // Page where this lead was submitted
  rawPayload: text("raw_payload"), // Store the raw webhook payload for debugging
  archived: boolean("archived").notNull().default(false), // Archived leads are hidden from main view but not deleted
  aged: boolean("aged").notNull().default(false), // Aged leads are older leads moved to a monitoring area but remain interactive
  followUpDate: timestamp("follow_up_date"), // Follow-up date for this specific lead
  convertedAt: timestamp("converted_at"), // When this lead was converted to customer/estimate/job
  convertedToEstimateId: varchar("converted_to_estimate_id").references(() => estimates.id), // If converted to estimate
  convertedToJobId: varchar("converted_to_job_id").references(() => jobs.id), // If converted to job
  assignedToUserId: varchar("assigned_to_user_id").references(() => users.id), // User assigned to follow up
  // Lead-level first-contact timing (task #805) — per-lead speed-to-lead.
  contactedAt: timestamp("contacted_at"), // When this lead was first contacted (call, text, or email)
  contactedByUserId: varchar("contacted_by_user_id").references(() => users.id), // User who first contacted this lead
  contractorId: varchar("contractor_id").notNull().references(() => contractors.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  // Performance indexes
  contractorIdIdx: index("leads_contractor_id_idx").on(table.contractorId),
  contactIdIdx: index("leads_contact_id_idx").on(table.contactId),
  statusIdx: index("leads_status_idx").on(table.status),
  createdAtIdx: index("leads_created_at_idx").on(table.createdAt),
  // Composite indexes for common queries
  contractorStatusIdx: index("leads_contractor_status_idx").on(table.contractorId, table.status),
  contractorDateIdx: index("leads_contractor_date_idx").on(table.contractorId, table.createdAt),
  contactCreatedIdx: index("leads_contact_created_idx").on(table.contactId, table.createdAt),
  assignedToUserIdIdx: index("leads_assigned_to_user_id_idx").on(table.assignedToUserId),
  // Task #805 — speed-to-lead / contacted aggregates on the dashboard.
  contractorContactedAtIdx: index("leads_contractor_contacted_at_idx").on(table.contractorId, table.contactedAt),
  // Task #805 — effective-stage derivation: most-recent open/terminal lead per contact.
  contactStageIdx: index("leads_contact_archived_status_created_idx").on(table.contactId, table.archived, table.status, table.createdAt),
  // Indexes for conversion tracking queries (e.g., finding which estimate/job a lead became)
  convertedToEstimateIdIdx: index("leads_converted_to_estimate_id_idx").on(table.convertedToEstimateId),
  convertedToJobIdIdx: index("leads_converted_to_job_id_idx").on(table.convertedToJobId),
  // Unique index prevents duplicate lead records during HCP webhook race conditions (partial: only when set)
  housecallProLeadIdUniqueIdx: uniqueIndex("leads_housecall_pro_lead_id_unique_idx")
    .on(table.contractorId, table.housecallProLeadId)
    .where(sql`housecall_pro_lead_id IS NOT NULL`),
  // O(1) lookup for the Google Local Services poller (task #490). Partial &
  // unique because each Google leadId appears at most once per contractor.
  googleLeadIdUniqueIdx: uniqueIndex("leads_google_lead_id_unique_idx")
    .on(table.contractorId, table.googleLeadId)
    .where(sql`google_lead_id IS NOT NULL`),
}));

export const insertLeadSchema = createInsertSchema(leads).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertLead = z.infer<typeof insertLeadSchema>;
export type Lead = typeof leads.$inferSelect;
