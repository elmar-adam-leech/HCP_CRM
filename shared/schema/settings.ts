import { sql } from "drizzle-orm";
import { pgTable, text, varchar, timestamp, decimal, boolean, integer, index, uniqueIndex, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Contractors table — one row per tenant (company). All business-data tables
// reference this table via contractorId for multi-tenant isolation.
export const contractors = pgTable("contractors", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  domain: text("domain").notNull().unique(),
  bookingSlug: text("booking_slug").unique(), // URL-friendly slug for public booking page (e.g., /book/acme-hvac)
  bookingRedirectUrl: text("booking_redirect_url"), // Optional URL to redirect to after a successful booking
  timezone: text("timezone").default("America/New_York"), // Business timezone for availability calculations
  housecallProSyncStartDate: timestamp("housecall_pro_sync_start_date"), // Admin configurable sync start date
  defaultDialpadNumber: text("default_dialpad_number"), // Organization-wide default Dialpad phone number
  dialpadActivityLastSyncAt: timestamp("dialpad_activity_last_sync_at"), // Last time Dialpad activities were synced
  dialpadActivitySyncEnabled: boolean("dialpad_activity_sync_enabled").default(true).notNull(), // Enable/disable automatic activity sync
  // Twilio (task #822) — parallel calling/SMS provider.
  defaultTwilioNumber: text("default_twilio_number"), // Organization-wide default Twilio phone number
  twilioRecordCalls: boolean("twilio_record_calls").default(false).notNull(), // Record inbound+outbound calls (OFF by default, consent-gated)
  twilioInboundCallMode: text("twilio_inbound_call_mode").default("crm").notNull(), // 'crm' = CRM answers inbound calls (ring rep + voicemail) | 'external' = keep contractor's Twilio setup (e.g. Studio Flow); CRM still logs via StatusCallback
  twilioRingTree: jsonb("twilio_ring_tree"), // Ring-order config for inbound calls (task #854). Shape: TwilioRingTree. NULL = default behavior (first user with a phone → voicemail).
  estimateArchiveDays: integer("estimate_archive_days"), // nullable — null = show all, N = only show estimates from last N days
  logoUrl: text("logo_url"), // Company logo: https URL or data:image/...;base64,... (nullable)
  brandColor: text("brand_color"), // Optional brand/accent color (hex, e.g. "#3366ff") used to theme the public booking page
  hcpSendLeads: boolean("hcp_send_leads").default(true).notNull(), // Whether to push new leads to HCP
  hcpSyncSkipTags: text("hcp_sync_skip_tags").array().notNull().default(sql`'{}'`), // Lead tags that should skip HCP sync
  dataRetentionMonths: integer("data_retention_months"),
  privacyNoticeMarkdown: text("privacy_notice_markdown"),
  // When true, header-based reply matching may auto-add the inbound sender's
  // address to the matched contact's `emails` array so subsequent replies
  // match via the fast sender path. See server/sync/gmail.ts.
  autoLearnReplyAddresses: boolean("auto_learn_reply_addresses").default(true).notNull(),
  // AI SMS scheduling agent settings (task #697). The agent responds to
  // inbound text replies on contacts in an active scheduling-intent
  // conversation, asks for the address, confirms availability, and books
  // the appointment in HCP. These columns control whether it runs and how
  // it sounds.
  aiSchedulingEnabled: boolean("ai_scheduling_enabled").default(false).notNull(),
  aiSchedulingPersonality: text("ai_scheduling_personality"),
  aiSchedulingCompanyContext: text("ai_scheduling_company_context"),
  // How long after a flagged outreach SMS the AI agent is allowed to engage
  // with an inbound reply. Default 72h. Tenant-tunable but not user-facing yet.
  aiSchedulingWindowHours: integer("ai_scheduling_window_hours").notNull().default(72),
  // Configurable appointment length and buffer between appointments (task #858).
  // Used by availability generation and when writing calendar events. Defaults
  // match the historical hard-coded SLOT_DURATION_MINUTES / BUFFER_MINUTES.
  appointmentDurationMinutes: integer("appointment_duration_minutes").notNull().default(60),
  appointmentBufferMinutes: integer("appointment_buffer_minutes").notNull().default(30),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertContractorSchema = createInsertSchema(contractors).omit({
  id: true,
  createdAt: true,
});
export type InsertContractor = z.infer<typeof insertContractorSchema>;
export type Contractor = typeof contractors.$inferSelect;

// ── Twilio inbound ring tree (task #854) ────────────────────────────────────
// Each step rings all its members SIMULTANEOUSLY (multiple <Number> nouns in
// one <Dial>); steps run IN ORDER (sequential fallthrough). Members can be a
// CRM user (their twilioPhoneToRing is resolved at call time) or a raw phone
// number (e.g., an office landline).
export const twilioRingStepSchema = z
  .object({
    numbers: z.array(z.string().trim().min(3).max(20)).max(5).default([]),
    userIds: z.array(z.string().trim().min(1).max(64)).max(5).default([]),
    timeoutSeconds: z.number().int().min(5).max(60),
  })
  .refine((s) => s.numbers.length + s.userIds.length >= 1, {
    message: "Each ring step needs at least one member",
  })
  .refine((s) => s.numbers.length + s.userIds.length <= 5, {
    message: "Each ring step can have at most 5 members",
  });

export const twilioRingTreeSchema = z.object({
  steps: z.array(twilioRingStepSchema).min(1).max(5),
  voicemailGreeting: z.string().trim().max(500).optional(),
});
export type TwilioRingStep = z.infer<typeof twilioRingStepSchema>;
export type TwilioRingTree = z.infer<typeof twilioRingTreeSchema>;

// Terminology settings table for customizable navigation labels per contractor
export const terminologySettings = pgTable("terminology_settings", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  contractorId: varchar("contractor_id").notNull().references(() => contractors.id).unique(),
  // Navigation labels - defaults match current system
  leadLabel: text("lead_label").notNull().default("Lead"),
  leadsLabel: text("leads_label").notNull().default("Leads"),
  estimateLabel: text("estimate_label").notNull().default("Estimate"),
  estimatesLabel: text("estimates_label").notNull().default("Estimates"),
  jobLabel: text("job_label").notNull().default("Job"),
  jobsLabel: text("jobs_label").notNull().default("Jobs"),
  messageLabel: text("message_label").notNull().default("Message"),
  messagesLabel: text("messages_label").notNull().default("Messages"),
  templateLabel: text("template_label").notNull().default("Template"),
  templatesLabel: text("templates_label").notNull().default("Templates"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertTerminologySettingsSchema = createInsertSchema(terminologySettings).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertTerminologySettings = z.infer<typeof insertTerminologySettingsSchema>;
export type TerminologySettings = typeof terminologySettings.$inferSelect;

// Business metric targets table for custom performance targets per contractor
export const businessTargets = pgTable("business_targets", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  contractorId: varchar("contractor_id").notNull().references(() => contractors.id),
  speedToLeadMinutes: integer("speed_to_lead_minutes").notNull().default(60), // Target response time in minutes
  followUpRatePercent: decimal("follow_up_rate_percent", { precision: 5, scale: 2 }).notNull().default(sql`80.00`), // Target follow-up rate percentage
  setRatePercent: decimal("set_rate_percent", { precision: 5, scale: 2 }).notNull().default(sql`40.00`), // Target set rate percentage (leads to estimates)
  closeRatePercent: decimal("close_rate_percent", { precision: 5, scale: 2 }).notNull().default(sql`25.00`), // Target close rate percentage (estimates to jobs)
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  contractorIdIdx: index("business_targets_contractor_id_idx").on(table.contractorId),
}));

export const insertBusinessTargetsSchema = createInsertSchema(businessTargets).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertBusinessTargets = z.infer<typeof insertBusinessTargetsSchema>;
export type BusinessTargets = typeof businessTargets.$inferSelect;

export const senderRuleActionEnum = z.enum(["block", "each_email_is_new_lead", "follow_link", "default"]);
export type SenderRuleAction = z.infer<typeof senderRuleActionEnum>;

export const crmFieldEnum = z.enum(["name", "firstName", "lastName", "phone", "email", "message", "address", "source", "notes", "utmCampaign", "utmSource", "utmMedium", "utmTerm", "utmContent", "pageUrl"]);
export type CrmField = z.infer<typeof crmFieldEnum>;

export const fieldMappingSchema = z.object({
  label: z.string().min(1),
  field: crmFieldEnum,
});
export type FieldMapping = z.infer<typeof fieldMappingSchema>;

export const spamOverrideEnum = z.enum(["none", "always_allow", "always_block"]);
export type SpamOverride = z.infer<typeof spamOverrideEnum>;

export const senderRuleSchema = z.object({
  senderEmail: z.string().email(),
  action: senderRuleActionEnum.optional(),
  actions: z.array(senderRuleActionEnum).optional(),
  fieldMappings: z.array(fieldMappingSchema).optional(),
  spamOverride: spamOverrideEnum.optional().default("none"),
  urlPattern: z.string().optional(),
}).transform((rule) => {
  const actions = rule.actions && rule.actions.length > 0
    ? rule.actions
    : rule.action ? [rule.action] : ['default' as const];
  return { ...rule, actions, action: undefined };
});
export type SenderRule = z.output<typeof senderRuleSchema>;

export const leadCaptureInboxes = pgTable("lead_capture_inboxes", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  contractorId: varchar("contractor_id").notNull().references(() => contractors.id).unique(),
  emailAddress: text("email_address").notNull(),
  gmailRefreshToken: text("gmail_refresh_token").notNull(),
  lastSyncAt: timestamp("last_sync_at"),
  spamFilterEnabled: boolean("spam_filter_enabled").notNull().default(false),
  spamConfidenceThreshold: integer("spam_confidence_threshold").notNull().default(80),
  senderRules: jsonb("sender_rules").$type<SenderRule[]>().default([]),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  contractorIdIdx: index("lead_capture_inboxes_contractor_id_idx").on(table.contractorId),
}));

export const insertLeadCaptureInboxSchema = createInsertSchema(leadCaptureInboxes).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertLeadCaptureInbox = z.infer<typeof insertLeadCaptureInboxSchema>;
export type LeadCaptureInbox = typeof leadCaptureInboxes.$inferSelect;

export const spamAuditLog = pgTable("spam_audit_log", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  inboxId: varchar("inbox_id").notNull().references(() => leadCaptureInboxes.id, { onDelete: 'cascade' }),
  contractorId: varchar("contractor_id").notNull().references(() => contractors.id),
  senderEmail: text("sender_email").notNull(),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  spamConfidence: integer("spam_confidence").notNull(),
  reason: text("reason"),
  flaggedAt: timestamp("flagged_at").defaultNow().notNull(),
  recoveredAt: timestamp("recovered_at"),
  recoveredLeadId: varchar("recovered_lead_id"),
}, (table) => ({
  inboxIdIdx: index("spam_audit_log_inbox_id_idx").on(table.inboxId),
  contractorIdIdx: index("spam_audit_log_contractor_id_idx").on(table.contractorId),
}));

export const insertSpamAuditLogSchema = createInsertSchema(spamAuditLog).omit({
  id: true,
  flaggedAt: true,
  recoveredAt: true,
  recoveredLeadId: true,
});
export type InsertSpamAuditLog = z.infer<typeof insertSpamAuditLogSchema>;
export type SpamAuditLog = typeof spamAuditLog.$inferSelect;

export const hcpExcludedCustomers = pgTable("hcp_excluded_customers", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  contractorId: varchar("contractor_id").notNull().references(() => contractors.id),
  hcpCustomerId: varchar("hcp_customer_id").notNull(),
  excludedAt: timestamp("excluded_at").defaultNow().notNull(),
}, (table) => ({
  contractorCustomerIdx: uniqueIndex("hcp_excluded_customers_contractor_customer_idx").on(table.contractorId, table.hcpCustomerId),
}));

export type HcpExcludedCustomer = typeof hcpExcludedCustomers.$inferSelect;

export const sharedEmailAccounts = pgTable("shared_email_accounts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  contractorId: varchar("contractor_id").notNull().references(() => contractors.id).unique(),
  email: text("email").notNull(),
  displayName: text("display_name"),
  gmailRefreshToken: text("gmail_refresh_token").notNull(),
  connectedByUserId: varchar("connected_by_user_id"), // FK to users(id) ON DELETE SET NULL enforced via SQL migration (circular import prevents Drizzle .references())
  lastSyncAt: timestamp("last_sync_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertSharedEmailAccountSchema = createInsertSchema(sharedEmailAccounts).omit({
  id: true,
  createdAt: true,
});
export type InsertSharedEmailAccount = z.infer<typeof insertSharedEmailAccountSchema>;
export type SharedEmailAccount = typeof sharedEmailAccounts.$inferSelect;
