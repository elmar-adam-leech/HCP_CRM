import { sql } from "drizzle-orm";
import { pgTable, text, varchar, timestamp, decimal, index, uniqueIndex, jsonb, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { estimateStatusEnum } from "./enums";
import { contractors } from "./settings";
import { contacts } from "./contacts";

export type HcpOptionEntry = {
  id: string;
  name?: string;
  option_number?: string;
  total_amount?: number;
  approval_status?: string;
  // ISO timestamp of the most recent approval_status transition for this option.
  // Populated by the option webhook handler and the polling sync when a change
  // is detected. Old rows where this is missing should be coalesced to null.
  approval_status_changed_at?: string | null;
};

// Minimum useful subset of an HCP line item. Stored as jsonb on estimates and jobs
// so service-history queries and per-line reporting can work without a separate
// catalog table. Amounts are dollars (HCP returns cents — coerce in the mapper).
// Allowed values for HcpLineItem.kind. The schema stores it as a plain string
// (drizzle-zod can't honor literal unions on optional jsonb fields without
// losing required-property types — see Task #435 commit notes), so the mapper
// validates against this set instead.
export const HCP_LINE_ITEM_KINDS = ['labor', 'material', 'service', 'fee', 'discount'] as const;
export type HcpLineItemKind = typeof HCP_LINE_ITEM_KINDS[number];

export type HcpLineItem = {
  id: string;
  name: string;
  description?: string;
  quantity: number;
  unit_price: number;
  total: number;
  kind?: string;
  service_item_id?: string;
};

// Estimates table
export const estimates = pgTable("estimates", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  title: text("title").notNull(),
  description: text("description"),
  amount: decimal("amount", { precision: 10, scale: 2 }).notNull(),
  status: estimateStatusEnum("status").notNull().default("scheduled"),
  validUntil: timestamp("valid_until"),
  followUpDate: timestamp("follow_up_date"),
  contactId: varchar("contact_id").notNull().references(() => contacts.id), // Reference to contact (no duplicate phone/email data)
  // Housecall Pro integration fields
  housecallProEstimateId: varchar("housecall_pro_estimate_id"), // Housecall Pro estimate ID
  housecallProCustomerId: varchar("housecall_pro_customer_id"), // Housecall Pro customer ID
  scheduledStart: timestamp("scheduled_start"), // Scheduled start time from Housecall Pro
  scheduledEnd: timestamp("scheduled_end"), // Scheduled end time from Housecall Pro
  scheduledEmployeeId: varchar("scheduled_employee_id"), // Housecall Pro employee ID
  hcpOptions: jsonb("hcp_options").$type<HcpOptionEntry[]>(),
  lineItems: jsonb("line_items").$type<HcpLineItem[]>(),
  // CRM user id (users.id) of the salesperson on this estimate. Denormalised at
  // sync time from assigned_employees[0].id → employees.user_contractor_id →
  // user_contractors.user_id. Nullable when the HCP employee is not linked to
  // a CRM user yet (or no employee was assigned).
  salespersonUserId: varchar("salesperson_user_id"),
  // Top-level timestamp of the most recent estimate-level status change. Updated
  // by HCP webhook handlers and the polling sync whenever the resolved local
  // `status` flips. Distinct from per-option `hcpOptions[].approval_status_changed_at`
  // (which is a per-option signal) — this column reflects the parent estimate's
  // status transition timestamp and is what reports / SLA queries should join on.
  approvalStatusChangedAt: timestamp("approval_status_changed_at"),
  // Free-form reason for the most recent status change. Populated from the HCP
  // webhook event type (e.g. `estimate.option.approval_status_changed`) or any
  // explicit reason/note string the webhook supplies. Used by reports and the
  // estimate detail UI to surface "why did this estimate move to <status>?".
  mostRecentStatusChangeReason: text("most_recent_status_change_reason"),
  syncedAt: timestamp("synced_at"), // Last sync time with Housecall Pro
  // Status-transition timestamps. Populated the first time an estimate moves into
  // approved/rejected. Used by the Time-to-Close report so later edits to the
  // row (notes, line items, etc.) do not shift the apparent close time.
  approvedAt: timestamp("approved_at"),
  rejectedAt: timestamp("rejected_at"),
  // True when the CRM user has manually set this estimate's status from the UI.
  // Polling sync and webhook handlers must respect this flag and never overwrite
  // the local status from HCP unless HCP reports a terminal rejected/cancelled state.
  statusManuallySet: boolean("status_manually_set").notNull().default(false),
  // External system tracking fields (consistent with jobs table)
  externalId: varchar("external_id"), // External system ID (e.g., Housecall Pro estimate ID)
  externalSource: varchar("external_source"), // External system name (e.g., 'housecall-pro')
  contractorId: varchar("contractor_id").notNull().references(() => contractors.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  // Performance indexes for common queries
  contractorIdIdx: index("estimates_contractor_id_idx").on(table.contractorId),
  contactIdIdx: index("estimates_contact_id_idx").on(table.contactId),
  statusIdx: index("estimates_status_idx").on(table.status),
  createdAtIdx: index("estimates_created_at_idx").on(table.createdAt),
  // Composite index for contractor + status queries
  contractorStatusIdx: index("estimates_contractor_status_idx").on(table.contractorId, table.status),
  // Composite index for contractor + date range queries
  contractorDateIdx: index("estimates_contractor_date_idx").on(table.contractorId, table.createdAt),
  // Index for follow-up date queries (Follow-ups page)
  followUpDateIdx: index("estimates_follow_up_date_idx").on(table.followUpDate),
  // Unique partial index preventing duplicate CRM estimates for the same HCP estimate ID.
  // The webhook handler and the booking path both create estimates; this constraint ensures
  // that a race between them cannot produce two rows for the same externalId.
  uniqueExternalIdx: uniqueIndex("estimates_unique_external_idx").on(table.contractorId, table.externalSource, table.externalId).where(sql`external_id IS NOT NULL AND external_source IS NOT NULL`),
  // Partial index for Housecall Pro estimate ID lookups (HCP sync path).
  // housecall_pro_estimate_id is distinct from external_id — the HCP estimate-specific
  // sync path queries this column directly when matching incoming HCP webhooks.
  housecallProEstimateIdIdx: index("estimates_housecall_pro_estimate_id_idx").on(table.housecallProEstimateId).where(sql`housecall_pro_estimate_id IS NOT NULL`),
  // Composite index supporting paginated title search queries:
  // WHERE contractor_id = ? AND title ILIKE ? ORDER BY created_at DESC
  contractorTitleIdx: index("estimates_contractor_title_idx").on(table.contractorId, table.title),
  // Per-salesperson reporting (Task B): scope by contractor + salesperson.
  salespersonIdx: index("estimates_salesperson_user_id_idx").on(table.contractorId, table.salespersonUserId).where(sql`salesperson_user_id IS NOT NULL`),
}));

// See note in shared/schema/jobs.ts: drizzle-zod widens optional jsonb fields
// to `unknown`, so we re-declare the line item shape on the insert schema to
// preserve InsertEstimate.lineItems narrowing for sync mappers.
const hcpLineItemEstZ = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  quantity: z.number(),
  unit_price: z.number(),
  total: z.number(),
  kind: z.string().optional(),
  service_item_id: z.string().optional(),
});

export const insertEstimateSchema = createInsertSchema(estimates).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
}).extend({
  amount: z.union([z.string(), z.number()]).transform(val => String(val)),
  lineItems: z.array(hcpLineItemEstZ).optional().nullable(),
});
export type InsertEstimate = z.infer<typeof insertEstimateSchema>;
export type Estimate = typeof estimates.$inferSelect;

// Lightweight DTO for estimate lists and pagination
export const estimateSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable().optional(),
  amount: z.string(),
  status: z.enum(["sent", "scheduled", "in_progress", "approved", "rejected"]),
  validUntil: z.date().nullable(),
  contactName: z.string(),
  contactId: z.string(),
  contactEmails: z.array(z.string()).nullable().optional(),
  contactPhones: z.array(z.string()).nullable().optional(),
  contactTags: z.array(z.string()).nullable().optional(),
  contactHasJobs: z.boolean().optional(),
  externalSource: z.string().nullable().optional(),
  externalId: z.string().nullable().optional(),
  housecallProEstimateId: z.string().nullable().optional(),
  hcpOptions: z.array(z.object({
    id: z.string(),
    name: z.string().optional(),
    option_number: z.string().optional(),
    total_amount: z.number().optional(),
    approval_status: z.string().optional(),
  })).nullable().optional(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type EstimateSummary = z.infer<typeof estimateSummarySchema>;

// Status counts shape used in paginated responses and the standalone endpoint
export const estimateStatusCountsSchema = z.object({
  all: z.number(),
  sent: z.number(),
  scheduled: z.number(),
  in_progress: z.number(),
  approved: z.number(),
  rejected: z.number(),
});
export type EstimateStatusCounts = z.infer<typeof estimateStatusCountsSchema>;

// Paginated response schema for estimates (statusCounts bundled to save a round trip)
export const paginatedEstimatesSchema = z.object({
  data: z.array(estimateSummarySchema),
  pagination: z.object({
    total: z.number(),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
  }),
  statusCounts: estimateStatusCountsSchema,
});
export type PaginatedEstimates = z.infer<typeof paginatedEstimatesSchema>;
