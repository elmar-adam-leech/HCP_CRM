import { sql } from "drizzle-orm";
import { pgTable, text, varchar, timestamp, boolean, index, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { contactTypeEnum, contactStatusEnum } from "./enums";
import { contractors } from "./settings";
import { users } from "./users";

// Contacts table (unified leads and customers)
// Stores deduplicated contact records - one record per unique person/company
export const contacts = pgTable("contacts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  emails: text("emails").array().default(sql`'{}'`), // Support multiple email addresses
  phones: text("phones").array().default(sql`'{}'`), // Support multiple phone numbers
  address: text("address"),
  street: text("street"),
  city: text("city"),
  state: text("state"),
  zip: text("zip"),
  type: contactTypeEnum("type").notNull().default("lead"), // lead, customer, or inactive
  status: contactStatusEnum("status").notNull().default("new"), // Unified status for all contact types
  source: text("source"), // Where the contact came from (web form, referral, etc.)
  notes: text("notes"),
  tags: text("tags").array().default(sql`'{}'`), // Tags for segmentation and workflow targeting
  followUpDate: timestamp("follow_up_date"),
  // UTM and tracking fields
  utmSource: text("utm_source"), // UTM source (e.g., "google", "facebook")
  utmMedium: text("utm_medium"), // UTM medium (e.g., "cpc", "email", "social")
  utmCampaign: text("utm_campaign"), // UTM campaign name
  utmTerm: text("utm_term"), // UTM term (keywords)
  utmContent: text("utm_content"), // UTM content (ad content)
  pageUrl: text("page_url"), // Page URL where contact was captured
  // Housecall Pro integration fields
  housecallProCustomerId: varchar("housecall_pro_customer_id"), // Housecall Pro customer ID
  housecallProEstimateId: varchar("housecall_pro_estimate_id"), // Housecall Pro estimate ID if scheduled
  scheduledAt: timestamp("scheduled_at"), // When the estimate was scheduled
  scheduledEmployeeId: varchar("scheduled_employee_id"), // Housecall Pro employee ID
  isScheduled: boolean("is_scheduled").notNull().default(false), // Quick lookup for scheduled status
  contactedAt: timestamp("contacted_at"), // When the contact was first contacted (call, text, or email)
  contactedByUserId: varchar("contacted_by_user_id").references(() => users.id), // User who first contacted
  scheduledByUserId: varchar("scheduled_by_user_id").references(() => users.id), // User who scheduled the appointment
  // External system tracking fields
  externalId: varchar("external_id"), // External system ID (e.g., Housecall Pro customer ID)
  externalSource: varchar("external_source"), // External system name (e.g., 'housecall-pro')
  // Pre-normalized phone (last 10 digits of the primary phone, digits only) for fast webhook
  // lookups — avoids a full table scan from REGEXP_REPLACE on the phones array column.
  // Populated on insert/update from phones[0]. Queried by getContactByPhone().
  normalizedPhone: text("normalized_phone"),
  bookingCode: text("booking_code"),
  contractorId: varchar("contractor_id").notNull().references(() => contractors.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  lastActivityAt: timestamp("last_activity_at").defaultNow(),
  erasedAt: timestamp("erased_at"),
  anonymized: boolean("anonymized").notNull().default(false),
  retentionFlaggedAt: timestamp("retention_flagged_at"),
}, (table) => ({
  // Performance indexes for common queries
  contractorIdIdx: index("contacts_contractor_id_idx").on(table.contractorId),
  typeIdx: index("contacts_type_idx").on(table.type),
  statusIdx: index("contacts_status_idx").on(table.status),
  isScheduledIdx: index("contacts_is_scheduled_idx").on(table.isScheduled),
  createdAtIdx: index("contacts_created_at_idx").on(table.createdAt),
  contactedAtIdx: index("contacts_contacted_at_idx").on(table.contactedAt),
  // Composite index for contractor + type queries
  contractorTypeIdx: index("contacts_contractor_type_idx").on(table.contractorId, table.type),
  // Composite index for contractor + status queries
  contractorStatusIdx: index("contacts_contractor_status_idx").on(table.contractorId, table.status),
  // Composite index for contractor + scheduled status queries
  contractorScheduledIdx: index("contacts_contractor_scheduled_idx").on(table.contractorId, table.isScheduled),
  // Composite index for contractor + date range queries
  contractorDateIdx: index("contacts_contractor_date_idx").on(table.contractorId, table.createdAt),
  // Composite index for contractor + activity-date sorting (leads views)
  contractorActivityIdx: index("contacts_contractor_activity_idx").on(table.contractorId, table.lastActivityAt),
  // Composite index for external system lookups
  externalLookupIdx: index("contacts_external_lookup_idx").on(table.contractorId, table.externalSource, table.externalId),
  // Index for tag-based filtering in workflows
  tagsIdx: index("contacts_tags_idx").on(table.tags),
  // Partial index for follow-up date queries — only rows that actually have a date set
  // (Follow-ups page never queries contacts where follow_up_date IS NULL)
  followUpDateIdx: index("contacts_follow_up_date_idx").on(table.followUpDate).where(sql`follow_up_date IS NOT NULL`),
  // Composite partial index for Follow-ups page: always filters by contractor first, then by date.
  // Supersedes the single-column followUpDateIdx for multi-tenant queries but we keep both.
  contractorFollowUpIdx: index("contacts_contractor_follow_up_idx").on(table.contractorId, table.followUpDate).where(sql`follow_up_date IS NOT NULL`),
  // Partial index for HCP customer ID lookups (sync path)
  housecallProCustomerIdIdx: index("contacts_housecall_pro_customer_id_idx").on(table.housecallProCustomerId).where(sql`housecall_pro_customer_id IS NOT NULL`),
  // GIN indexes for array-contains queries on email and phone arrays.
  // Without GIN, `WHERE emails @> ARRAY['x']` causes a full table scan.
  emailsGinIdx: index("contacts_emails_gin_idx").using("gin", table.emails),
  phonesGinIdx: index("contacts_phones_gin_idx").using("gin", table.phones),
  // Composite index for normalized-phone webhook lookups. Dialpad fires on every
  // inbound call/SMS, so this query runs very frequently. Using the pre-computed
  // normalizedPhone column (10 digits, no regex) makes this an O(log N) seek.
  contractorNormalizedPhoneIdx: index("contacts_contractor_normalized_phone_idx").on(table.contractorId, table.normalizedPhone),
}));

export const insertContactSchema = createInsertSchema(contacts).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertContact = z.infer<typeof insertContactSchema>;
export type Contact = typeof contacts.$inferSelect & {
  hasJobs?: boolean;
  assignedToUserId?: string | null;
  assignedToUserName?: string | null;
  allLeadsArchived?: boolean;
  anyLeadAged?: boolean;
  autoDisputed?: boolean;
  autoDisputeFailed?: boolean;
  // Task #805: pipeline stage derived from the most-recent open lead + booking
  // state, not the raw `status` column. Present on lead-scoped list rows.
  effectiveStage?: string;
};

// Lightweight DTO for contact lists and pagination.
// `type` and `status` are derived from the Drizzle enum definitions so that
// adding a new value to `contactTypeEnum` or `contactStatusEnum` automatically
// reflects here without requiring a manual edit to this DTO.
export const contactSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  emails: z.array(z.string()),
  phones: z.array(z.string()),
  type: z.enum(contactTypeEnum.enumValues),
  status: z.enum(contactStatusEnum.enumValues),
  source: z.string().nullable(),
  isScheduled: z.boolean(),
  contactedAt: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
  housecallProCustomerId: z.string().nullable().optional(),
  lastActivityAt: z.date().nullable().optional(),
  hasJobs: z.boolean().optional(),
  assignedToUserId: z.string().nullable().optional(),
  assignedToUserName: z.string().nullable().optional(),
  // State-summary booleans surfaced by the contact list query so search
  // result rows can render Disqualified / Archived / Aged badges.
  allLeadsArchived: z.boolean().optional(),
  anyLeadAged: z.boolean().optional(),
  autoDisputed: z.boolean().optional(),
  autoDisputeFailed: z.boolean().optional(),
  // Task #805: derived pipeline stage (see Contact type).
  effectiveStage: z.string().optional(),
});
export type ContactSummary = z.infer<typeof contactSummarySchema>;

// Shared filter options for contact list queries.
// All three storage functions (getContactsPaginated, getContactsCount,
// getContactsStatusCounts) accept this shape so that any new filter field
// only needs to be added in one place.
export interface ContactFilterOptions {
  cursor?: string;
  offset?: number;
  limit?: number;
  type?: 'lead' | 'customer' | 'inactive';
  // Multi-type filter: when provided (non-empty), takes precedence over `type`
  // and produces a `contacts.type IN (...)` predicate. Lets a single request
  // ask for e.g. customers + inactive at once (used by the global header
  // search Contacts section to avoid issuing two requests per keystroke).
  types?: Array<'lead' | 'customer' | 'inactive'>;
  status?: string;
  search?: string;
  includeAll?: boolean;
  archived?: boolean;
  aged?: boolean;
  assignedTo?: string;
  dateFrom?: string;
  dateTo?: string;
  retentionFlagged?: boolean;
  sortField?: 'lastActivity' | 'createdDate';
  sortOrder?: 'asc' | 'desc';
}

// Paginated response schema for contacts
export const paginatedContactsSchema = z.object({
  data: z.array(contactSummarySchema),
  pagination: z.object({
    total: z.number(),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
  }),
});
export type PaginatedContacts = z.infer<typeof paginatedContactsSchema>;

// Scheduled bookings table for tracking appointments
// Lives here because its primary FK is contacts.id
export const scheduledBookings = pgTable("scheduled_bookings", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  contractorId: varchar("contractor_id").notNull().references(() => contractors.id, { onDelete: "cascade" }),
  assignedSalespersonId: varchar("assigned_salesperson_id").notNull().references(() => users.id),
  contactId: varchar("contact_id").references(() => contacts.id, { onDelete: "set null" }),
  housecallProEventId: text("housecall_pro_event_id"), // HCP calendar event ID
  title: text("title").notNull(),
  startTime: timestamp("start_time").notNull(),
  endTime: timestamp("end_time").notNull(),
  customerName: text("customer_name"),
  customerEmail: text("customer_email"),
  customerPhone: text("customer_phone"),
  notes: text("notes"),
  status: text("status").notNull().default("confirmed"), // confirmed, cancelled, completed
  // Where the booking originated. Mirrors `ScheduleSource` in
  // server/services/contact-status.ts. Default 'in_app_booking' covers historical
  // rows that were inserted before this column existed (the migration backfills
  // the public-link bookings via the activity log).
  source: text("source").notNull().default("in_app_booking"),
  bookingPayload: jsonb("booking_payload"), // Raw request body captured at booking time for audit trail
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  contractorIdx: index("scheduled_bookings_contractor_idx").on(table.contractorId),
  salespersonIdx: index("scheduled_bookings_salesperson_idx").on(table.assignedSalespersonId),
  startTimeIdx: index("scheduled_bookings_start_time_idx").on(table.startTime),
  // Index for contact detail page lookups — avoids full table scan
  contactIdIdx: index("scheduled_bookings_contact_id_idx").on(table.contactId),
}));

export const insertScheduledBookingSchema = createInsertSchema(scheduledBookings).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertScheduledBooking = z.infer<typeof insertScheduledBookingSchema>;
export type ScheduledBooking = typeof scheduledBookings.$inferSelect;

// Consent logs table — records consent at every inbound channel
export const consentLogs = pgTable("consent_logs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  contractorId: varchar("contractor_id").notNull().references(() => contractors.id),
  contactId: varchar("contact_id").references(() => contacts.id, { onDelete: "set null" }),
  userId: varchar("user_id").references(() => users.id, { onDelete: "set null" }),
  source: text("source").notNull(),
  optInType: text("opt_in_type").notNull().default("implied"),
  consentVersion: text("consent_version").notNull(),
  ipHash: text("ip_hash"),
  metadata: jsonb("metadata").default(sql`'{}'::jsonb`),
  withdrawnAt: timestamp("withdrawn_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  contractorCreatedAtIdx: index("consent_logs_contractor_created_at_idx").on(table.contractorId, table.createdAt),
  contactIdIdx: index("consent_logs_contact_id_idx").on(table.contactId),
}));

export const insertConsentLogSchema = createInsertSchema(consentLogs).omit({ id: true, createdAt: true });
export type InsertConsentLog = z.infer<typeof insertConsentLogSchema>;
export type ConsentLog = typeof consentLogs.$inferSelect;
