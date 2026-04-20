import { sql } from "drizzle-orm";
import { pgTable, text, varchar, timestamp, boolean, integer, unique, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { providerTypeEnum, emailProviderEnum, smsProviderEnum, callingProviderEnum, dialpadSyncStatusEnum } from "./enums";
import { contractors } from "./settings";
import { users, userContractors } from "./users";

// Contractor credentials table for secure per-contractor API key storage
export const contractorCredentials = pgTable("contractor_credentials", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  contractorId: varchar("contractor_id").notNull().references(() => contractors.id),
  service: varchar("service").notNull(), // 'gmail', 'dialpad', etc.
  credentialKey: varchar("credential_key").notNull(), // 'api_key', 'client_id', etc.
  encryptedValue: text("encrypted_value").notNull(), // Encrypted credential value
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  // Ensure one credential type per service per tenant
}, (table) => ({
  // Explicit name kept under PG's 63-char identifier limit (auto-generated name is 65 chars).
  contractorServiceKeyUnique: unique('cc_contractor_id_service_cred_key_unique').on(table.contractorId, table.service, table.credentialKey),
}));

export const insertContractorCredentialSchema = createInsertSchema(contractorCredentials).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertContractorCredential = z.infer<typeof insertContractorCredentialSchema>;
export type ContractorCredential = typeof contractorCredentials.$inferSelect;

// Contractor provider preferences - which provider each contractor uses for each service type
export const contractorProviders = pgTable("contractor_providers", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  contractorId: varchar("contractor_id").notNull().references(() => contractors.id),
  providerType: providerTypeEnum("provider_type").notNull(), // 'email', 'sms', 'calling'
  emailProvider: emailProviderEnum("email_provider"), // Only set if providerType is 'email'
  smsProvider: smsProviderEnum("sms_provider"), // Only set if providerType is 'sms'
  callingProvider: callingProviderEnum("calling_provider"), // Only set if providerType is 'calling'
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  // Ensure one provider per service type per contractor
}, (table) => ({
  contractorProviderTypeUnique: unique().on(table.contractorId, table.providerType),
}));

export const insertContractorProviderSchema = createInsertSchema(contractorProviders).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertContractorProvider = z.infer<typeof insertContractorProviderSchema>;
export type ContractorProvider = typeof contractorProviders.$inferSelect;

// Contractor integration enablement - explicit control over which integrations are enabled
export const contractorIntegrations = pgTable("contractor_integrations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  contractorId: varchar("contractor_id").notNull().references(() => contractors.id),
  integrationName: varchar("integration_name").notNull(), // 'dialpad', 'gmail', 'housecall-pro', etc.
  isEnabled: boolean("is_enabled").notNull().default(false), // Explicit enablement flag
  enabledAt: timestamp("enabled_at"), // When integration was enabled
  disabledAt: timestamp("disabled_at"), // When integration was disabled
  enabledBy: varchar("enabled_by").references(() => users.id), // User who enabled it
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  // Ensure one record per integration per contractor
}, (table) => ({
  contractorIntegrationUnique: unique().on(table.contractorId, table.integrationName),
  // Index for "who enabled this integration?" audit queries
  enabledByIdx: index("contractor_integrations_enabled_by_idx").on(table.enabledBy),
}));

export const insertContractorIntegrationSchema = createInsertSchema(contractorIntegrations).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertContractorIntegration = z.infer<typeof insertContractorIntegrationSchema>;
export type ContractorIntegration = typeof contractorIntegrations.$inferSelect;

// Employees table for storing and labeling team members from external sources
export const employees = pgTable("employees", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  contractorId: varchar("contractor_id").notNull().references(() => contractors.id),
  externalSource: varchar("external_source"), // 'housecall-pro', null for manually added
  externalId: varchar("external_id"), // External system's employee ID
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  email: text("email"),
  isActive: boolean("is_active").notNull().default(true),
  externalRole: text("external_role"), // Original role from external system
  roles: text("roles").array().notNull().default(sql`'{}'`), // Internal role labels
  department: text("department"), // Department assignment for phone number mapping
  // Link to a CRM user (via the user_contractors join table id) so we can ask
  // "what user sold this estimate" when HCP only gives us the employee id.
  // Backfilled by email match (see hcp-backfill-foundation). Nullable when no
  // unambiguous match exists.
  userContractorId: varchar("user_contractor_id").references(() => userContractors.id, { onDelete: 'set null' }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  contractorExternalUnique: unique().on(table.contractorId, table.externalSource, table.externalId),
  userContractorIdx: index("employees_user_contractor_id_idx").on(table.contractorId, table.userContractorId).where(sql`user_contractor_id IS NOT NULL`),
}));

export const insertEmployeeSchema = createInsertSchema(employees).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertEmployee = z.infer<typeof insertEmployeeSchema>;
export type Employee = typeof employees.$inferSelect;

export const updateEmployeeRolesSchema = z.object({
  roles: z.array(z.enum(["sales", "technician", "estimator", "dispatcher", "manager", "admin"])).max(5)
});
export type UpdateEmployeeRoles = z.infer<typeof updateEmployeeRolesSchema>;

// Dialpad phone numbers table for storing available phone numbers and their capabilities
export const dialpadPhoneNumbers = pgTable("dialpad_phone_numbers", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  contractorId: varchar("contractor_id").notNull().references(() => contractors.id),
  phoneNumber: text("phone_number").notNull(), // The actual phone number
  dialpadId: text("dialpad_id"), // Dialpad's internal ID for this number
  displayName: text("display_name"), // Human-readable name for this number
  department: text("department"), // Which department this number belongs to
  canSendSms: boolean("can_send_sms").notNull().default(false), // SMS capability
  canReceiveSms: boolean("can_receive_sms").notNull().default(false), // SMS capability
  canMakeCalls: boolean("can_make_calls").notNull().default(false), // Calling capability
  canReceiveCalls: boolean("can_receive_calls").notNull().default(false), // Calling capability
  isActive: boolean("is_active").notNull().default(true),
  lastSyncAt: timestamp("last_sync_at"), // When capabilities were last checked
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  contractorPhoneUnique: unique().on(table.contractorId, table.phoneNumber),
}));

export const insertDialpadPhoneNumberSchema = createInsertSchema(dialpadPhoneNumbers).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertDialpadPhoneNumber = z.infer<typeof insertDialpadPhoneNumberSchema>;
export type DialpadPhoneNumber = typeof dialpadPhoneNumbers.$inferSelect;

// User phone number permissions - which users can send from which phone numbers
export const userPhoneNumberPermissions = pgTable("user_phone_number_permissions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  phoneNumberId: varchar("phone_number_id").notNull().references(() => dialpadPhoneNumbers.id),
  contractorId: varchar("contractor_id").notNull().references(() => contractors.id),
  canSendSms: boolean("can_send_sms").notNull().default(false),
  canMakeCalls: boolean("can_make_calls").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
  assignedBy: varchar("assigned_by").references(() => users.id), // Who granted this permission
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  userPhoneUnique: unique().on(table.userId, table.phoneNumberId),
  // Standalone indexes so lookups by any single dimension are fast
  userIdIdx: index("user_phone_permissions_user_id_idx").on(table.userId),
  phoneNumberIdIdx: index("user_phone_permissions_phone_number_id_idx").on(table.phoneNumberId),
  contractorIdIdx: index("user_phone_permissions_contractor_id_idx").on(table.contractorId),
}));

export const insertUserPhoneNumberPermissionSchema = createInsertSchema(userPhoneNumberPermissions).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertUserPhoneNumberPermission = z.infer<typeof insertUserPhoneNumberPermissionSchema>;
export type UserPhoneNumberPermission = typeof userPhoneNumberPermissions.$inferSelect;

// Dialpad users cache - stores Dialpad user data for each contractor
export const dialpadUsers = pgTable("dialpad_users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  contractorId: varchar("contractor_id").notNull().references(() => contractors.id),
  dialpadUserId: text("dialpad_user_id").notNull(), // Dialpad's user ID (from API)
  email: text("email").notNull(),
  firstName: text("first_name"),
  lastName: text("last_name"),
  fullName: text("full_name"),
  isActive: boolean("is_active").notNull().default(true),
  department: text("department"), // User's primary department
  phoneNumbers: text("phone_numbers").array().default(sql`'{}'`), // User's assigned phone numbers
  lastSyncAt: timestamp("last_sync_at"), // When this user data was last synced
  syncChecksum: text("sync_checksum"), // For detecting changes
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  contractorDialpadUserUnique: unique().on(table.contractorId, table.dialpadUserId),
  // Standalone contractor index for "list all Dialpad users for tenant" queries
  contractorIdIdx: index("dialpad_users_contractor_id_idx").on(table.contractorId),
}));

export const insertDialpadUserSchema = createInsertSchema(dialpadUsers).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertDialpadUser = z.infer<typeof insertDialpadUserSchema>;
export type DialpadUser = typeof dialpadUsers.$inferSelect;

// Dialpad departments cache - stores Dialpad department data for each contractor
export const dialpadDepartments = pgTable("dialpad_departments", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  contractorId: varchar("contractor_id").notNull().references(() => contractors.id),
  dialpadDepartmentId: text("dialpad_department_id").notNull(), // Dialpad's department ID (from API)
  name: text("name").notNull(),
  description: text("description"),
  isActive: boolean("is_active").notNull().default(true),
  phoneNumbers: text("phone_numbers").array().default(sql`'{}'`), // Department's assigned phone numbers
  userCount: integer("user_count").default(0), // Number of users in this department
  lastSyncAt: timestamp("last_sync_at"), // When this department data was last synced
  syncChecksum: text("sync_checksum"), // For detecting changes
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  contractorDialpadDeptUnique: unique().on(table.contractorId, table.dialpadDepartmentId),
  // Standalone contractor index for "list all departments for tenant" queries
  contractorIdIdx: index("dialpad_departments_contractor_id_idx").on(table.contractorId),
}));

export const insertDialpadDepartmentSchema = createInsertSchema(dialpadDepartments).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertDialpadDepartment = z.infer<typeof insertDialpadDepartmentSchema>;
export type DialpadDepartment = typeof dialpadDepartments.$inferSelect;

// Dialpad sync jobs - tracks sync operations and status
export const dialpadSyncJobs = pgTable("dialpad_sync_jobs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  contractorId: varchar("contractor_id").notNull().references(() => contractors.id),
  syncType: text("sync_type").notNull(), // 'full', 'incremental', 'users', 'departments', 'numbers'
  status: dialpadSyncStatusEnum("status").notNull().default("pending"),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  errorMessage: text("error_message"),
  recordsProcessed: integer("records_processed").default(0),
  recordsSuccess: integer("records_success").default(0),
  recordsError: integer("records_error").default(0),
  lastSuccessfulSyncAt: timestamp("last_successful_sync_at"), // When last successful sync happened
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  // Performance indexes for common queries
  contractorIdIdx: index("dialpad_sync_jobs_contractor_id_idx").on(table.contractorId),
  statusIdx: index("dialpad_sync_jobs_status_idx").on(table.status),
  createdAtIdx: index("dialpad_sync_jobs_created_at_idx").on(table.createdAt),
  // Composite index for finding pending jobs by contractor
  contractorStatusIdx: index("dialpad_sync_jobs_contractor_status_idx").on(table.contractorId, table.status),
}));

export const insertDialpadSyncJobSchema = createInsertSchema(dialpadSyncJobs).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertDialpadSyncJob = z.infer<typeof insertDialpadSyncJobSchema>;
export type DialpadSyncJob = typeof dialpadSyncJobs.$inferSelect;

// Tracks the IDs of webhooks and call subscriptions registered against Dialpad,
// per contractor. Used by the diagnostic endpoint to detect drift even when the
// live Dialpad list call fails (e.g. credential rotation).
export const dialpadWebhookState = pgTable("dialpad_webhook_state", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  contractorId: varchar("contractor_id").notNull().references(() => contractors.id).unique(),
  smsWebhookId: text("sms_webhook_id"),
  smsSubscriptionId: text("sms_subscription_id"),
  callWebhookId: text("call_webhook_id"),
  callSubscriptionIds: text("call_subscription_ids").array(),
  lastRegisteredCallUrl: text("last_registered_call_url"),
  lastRegisteredSmsUrl: text("last_registered_sms_url"),
  lastRegisteredAt: timestamp("last_registered_at"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertDialpadWebhookStateSchema = createInsertSchema(dialpadWebhookState).omit({
  id: true,
  updatedAt: true,
});
export type InsertDialpadWebhookState = z.infer<typeof insertDialpadWebhookStateSchema>;
export type DialpadWebhookState = typeof dialpadWebhookState.$inferSelect;

// HCP calendar events — manual time blocks, PTO, etc. entered directly in HCP.
// Populated by the daily HCP sync so availability queries never need to hit the HCP API live.
export const hcpCalendarEvents = pgTable("hcp_calendar_events", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  contractorId: varchar("contractor_id").notNull().references(() => contractors.id),
  hcpEventId: varchar("hcp_event_id").notNull(),
  hcpEmployeeId: varchar("hcp_employee_id").notNull(),
  startTime: timestamp("start_time").notNull(),
  endTime: timestamp("end_time").notNull(),
  title: text("title"),
  status: text("status"),
  syncedAt: timestamp("synced_at").defaultNow().notNull(),
}, (table) => ({
  contractorEmployeeIdx: index("hcp_calendar_events_contractor_employee_idx").on(table.contractorId, table.hcpEmployeeId),
  startTimeIdx: index("hcp_calendar_events_start_time_idx").on(table.contractorId, table.startTime),
  hcpEventIdIdx: index("hcp_calendar_events_hcp_event_id_idx").on(table.contractorId, table.hcpEventId),
}));

export const insertHcpCalendarEventSchema = createInsertSchema(hcpCalendarEvents).omit({
  id: true,
  syncedAt: true,
});
export type InsertHcpCalendarEvent = z.infer<typeof insertHcpCalendarEventSchema>;
export type HcpCalendarEvent = typeof hcpCalendarEvents.$inferSelect;
