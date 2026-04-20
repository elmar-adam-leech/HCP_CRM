import { pgTable, unique, varchar, text, timestamp, boolean, integer, index, foreignKey, numeric, jsonb, uniqueIndex, pgEnum } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"

export const activityType = pgEnum("activity_type", ['note', 'call', 'email', 'sms', 'meeting', 'follow_up', 'status_change'])
export const callingProvider = pgEnum("calling_provider", ['dialpad', 'twilio', 'ringcentral', 'zoom'])
export const contactStatus = pgEnum("contact_status", ['new', 'contacted', 'scheduled', 'active', 'disqualified', 'inactive'])
export const contactType = pgEnum("contact_type", ['lead', 'customer', 'inactive'])
export const dialpadSyncStatus = pgEnum("dialpad_sync_status", ['pending', 'in_progress', 'completed', 'failed'])
export const emailProvider = pgEnum("email_provider", ['gmail', 'sendgrid', 'outlook', 'mailgun'])
export const estimateStatus = pgEnum("estimate_status", ['draft', 'sent', 'pending', 'scheduled', 'in_progress', 'approved', 'rejected'])
export const jobPriority = pgEnum("job_priority", ['low', 'medium', 'high'])
export const jobStatus = pgEnum("job_status", ['scheduled', 'in_progress', 'completed', 'cancelled'])
export const leadStatus = pgEnum("lead_status", ['new', 'contacted', 'qualified', 'converted', 'disqualified'])
export const messageDirection = pgEnum("message_direction", ['inbound', 'outbound'])
export const messageStatus = pgEnum("message_status", ['sent', 'delivered', 'failed'])
export const messageType = pgEnum("message_type", ['text', 'email'])
export const notificationType = pgEnum("notification_type", ['lead_assigned', 'estimate_approved', 'estimate_rejected', 'job_completed', 'new_message', 'follow_up_due', 'system'])
export const providerType = pgEnum("provider_type", ['email', 'sms', 'calling'])
export const smsProvider = pgEnum("sms_provider", ['dialpad', 'twilio', 'messagebird', 'nexmo'])
export const syncFrequency = pgEnum("sync_frequency", ['daily', 'weekly', 'hourly', 'every-5-minutes'])
export const templateStatus = pgEnum("template_status", ['draft', 'pending_approval', 'approved', 'rejected'])
export const templateType = pgEnum("template_type", ['text', 'email'])
export const userRole = pgEnum("user_role", ['super_admin', 'admin', 'manager', 'user'])
export const workflowActionType = pgEnum("workflow_action_type", ['send_email', 'send_sms', 'create_notification', 'update_entity', 'assign_user', 'set_follow_up', 'conditional_branch', 'delay', 'wait_until'])
export const workflowApprovalStatus = pgEnum("workflow_approval_status", ['approved', 'pending_approval', 'rejected'])
export const workflowExecutionStatus = pgEnum("workflow_execution_status", ['pending', 'running', 'completed', 'failed', 'cancelled', 'suspended'])
export const workflowTriggerType = pgEnum("workflow_trigger_type", ['entity_created', 'entity_updated', 'status_changed', 'field_changed', 'time_based', 'manual'])


export const contractors = pgTable("contractors", {
        id: varchar().default(gen_random_uuid()).primaryKey().notNull(),
        name: text().notNull(),
        domain: text().notNull(),
        bookingSlug: text("booking_slug"),
        timezone: text().default('America/New_York'),
        housecallProSyncStartDate: timestamp("housecall_pro_sync_start_date", { mode: 'string' }),
        defaultDialpadNumber: text("default_dialpad_number"),
        dialpadActivityLastSyncAt: timestamp("dialpad_activity_last_sync_at", { mode: 'string' }),
        dialpadActivitySyncEnabled: boolean("dialpad_activity_sync_enabled").default(true).notNull(),
        createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
        bookingRedirectUrl: text("booking_redirect_url"),
        estimateArchiveDays: integer("estimate_archive_days"),
        hcpSendLeads: boolean("hcp_send_leads").default(true).notNull(),
        hcpSyncSkipTags: text("hcp_sync_skip_tags").array().default([""]).notNull(),
}, (table) => [
        unique("contractors_domain_unique").on(table.domain),
        unique("contractors_booking_slug_unique").on(table.bookingSlug),
]);

export const userContractors = pgTable("user_contractors", {
        id: varchar().default(gen_random_uuid()).primaryKey().notNull(),
        userId: varchar("user_id").notNull(),
        contractorId: varchar("contractor_id").notNull(),
        role: userRole().default('user').notNull(),
        dialpadDefaultNumber: text("dialpad_default_number"),
        callPreference: text("call_preference").default('integration'),
        canManageIntegrations: boolean("can_manage_integrations").default(false).notNull(),
        isSalesperson: boolean("is_salesperson").default(false).notNull(),
        housecallProUserId: text("housecall_pro_user_id"),
        lastAssignmentAt: timestamp("last_assignment_at", { mode: 'string' }),
        calendarColor: text("calendar_color"),
        workingDays: integer("working_days").array().default([1, 2, 3, 4, 5]),
        workingHoursStart: text("working_hours_start").default('09:00'),
        workingHoursEnd: text("working_hours_end").default('17:00'),
        hasCustomSchedule: boolean("has_custom_schedule").default(false).notNull(),
        createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
        allowedIntegrations: text("allowed_integrations").array(),
        displayOrder: integer("display_order"),
}, (table) => [
        index("user_contractors_contractor_id_idx").using("btree", table.contractorId.asc().nullsLast().op("text_ops")),
        index("user_contractors_salesperson_idx").using("btree", table.contractorId.asc().nullsLast().op("bool_ops"), table.isSalesperson.asc().nullsLast().op("text_ops")),
        index("user_contractors_user_id_idx").using("btree", table.userId.asc().nullsLast().op("text_ops")),
        foreignKey({
                        columns: [table.userId],
                        foreignColumns: [users.id],
                        name: "user_contractors_user_id_users_id_fk"
                }).onDelete("cascade"),
        foreignKey({
                        columns: [table.contractorId],
                        foreignColumns: [contractors.id],
                        name: "user_contractors_contractor_id_contractors_id_fk"
                }).onDelete("cascade"),
        unique("user_contractors_user_id_contractor_id_unique").on(table.userId, table.contractorId),
]);

export const businessTargets = pgTable("business_targets", {
        id: varchar().default(gen_random_uuid()).primaryKey().notNull(),
        contractorId: varchar("contractor_id").notNull(),
        speedToLeadMinutes: integer("speed_to_lead_minutes").default(60).notNull(),
        followUpRatePercent: numeric("follow_up_rate_percent", { precision: 5, scale:  2 }).default('80.00').notNull(),
        setRatePercent: numeric("set_rate_percent", { precision: 5, scale:  2 }).default('40.00').notNull(),
        closeRatePercent: numeric("close_rate_percent", { precision: 5, scale:  2 }).default('25.00').notNull(),
        createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
        updatedAt: timestamp("updated_at", { mode: 'string' }).defaultNow().notNull(),
}, (table) => [
        index("business_targets_contractor_id_idx").using("btree", table.contractorId.asc().nullsLast().op("text_ops")),
        foreignKey({
                        columns: [table.contractorId],
                        foreignColumns: [contractors.id],
                        name: "business_targets_contractor_id_contractors_id_fk"
                }),
]);

export const oauthStates = pgTable("oauth_states", {
        id: varchar().default(gen_random_uuid()).primaryKey().notNull(),
        state: text().notNull(),
        userId: varchar("user_id").notNull(),
        redirectHost: text("redirect_host").notNull(),
        expiresAt: timestamp("expires_at", { mode: 'string' }).notNull(),
        createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
}, (table) => [
        index("oauth_states_expires_at_idx").using("btree", table.expiresAt.asc().nullsLast().op("timestamp_ops")),
        index("oauth_states_state_idx").using("btree", table.state.asc().nullsLast().op("text_ops")),
        unique("oauth_states_state_unique").on(table.state),
]);

export const users = pgTable("users", {
        id: varchar().default(gen_random_uuid()).primaryKey().notNull(),
        username: text().notNull(),
        password: text().notNull(),
        name: text().notNull(),
        email: text().notNull(),
        role: userRole().default('user').notNull(),
        tokenVersion: integer("token_version").default(1).notNull(),
        contractorId: varchar("contractor_id"),
        dialpadDefaultNumber: text("dialpad_default_number"),
        gmailConnected: boolean("gmail_connected").default(false).notNull(),
        gmailRefreshToken: text("gmail_refresh_token"),
        gmailEmail: text("gmail_email"),
        gmailLastSyncAt: timestamp("gmail_last_sync_at", { mode: 'string' }),
        gmailSyncHistoryId: text("gmail_sync_history_id"),
        canManageIntegrations: boolean("can_manage_integrations").default(false).notNull(),
        createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
}, (table) => [
        index("users_contractor_id_idx").using("btree", table.contractorId.asc().nullsLast().op("text_ops")),
        index("users_email_idx").using("btree", table.email.asc().nullsLast().op("text_ops")),
        index("users_email_lower_idx").using("btree", sql`lower(email)`),
        foreignKey({
                        columns: [table.contractorId],
                        foreignColumns: [contractors.id],
                        name: "users_contractor_id_contractors_id_fk"
                }),
        unique("users_username_unique").on(table.username),
]);

export const revokedTokens = pgTable("revoked_tokens", {
        jti: varchar().primaryKey().notNull(),
        userId: varchar("user_id").notNull(),
        expiresAt: timestamp("expires_at", { mode: 'string' }).notNull(),
        revokedAt: timestamp("revoked_at", { mode: 'string' }).defaultNow().notNull(),
}, (table) => [
        index("revoked_tokens_expires_at_idx").using("btree", table.expiresAt.asc().nullsLast().op("timestamp_ops")),
        index("revoked_tokens_user_id_idx").using("btree", table.userId.asc().nullsLast().op("text_ops")),
        foreignKey({
                        columns: [table.userId],
                        foreignColumns: [users.id],
                        name: "revoked_tokens_user_id_users_id_fk"
                }).onDelete("cascade"),
]);

export const userInvitations = pgTable("user_invitations", {
        id: varchar().default(gen_random_uuid()).primaryKey().notNull(),
        email: text().notNull(),
        role: userRole().default('user').notNull(),
        inviteCode: text("invite_code").notNull(),
        contractorId: varchar("contractor_id").notNull(),
        invitedBy: varchar("invited_by").notNull(),
        acceptedAt: timestamp("accepted_at", { mode: 'string' }),
        expiresAt: timestamp("expires_at", { mode: 'string' }).notNull(),
        createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
}, (table) => [
        index("user_invitations_contractor_id_idx").using("btree", table.contractorId.asc().nullsLast().op("text_ops")),
        index("user_invitations_invited_by_idx").using("btree", table.invitedBy.asc().nullsLast().op("text_ops")),
        foreignKey({
                        columns: [table.contractorId],
                        foreignColumns: [contractors.id],
                        name: "user_invitations_contractor_id_contractors_id_fk"
                }),
        foreignKey({
                        columns: [table.invitedBy],
                        foreignColumns: [users.id],
                        name: "user_invitations_invited_by_users_id_fk"
                }),
        unique("user_invitations_invite_code_unique").on(table.inviteCode),
]);

export const passwordResetTokens = pgTable("password_reset_tokens", {
        id: varchar().default(gen_random_uuid()).primaryKey().notNull(),
        userId: varchar("user_id").notNull(),
        token: text().notNull(),
        expiresAt: timestamp("expires_at", { mode: 'string' }).notNull(),
        usedAt: timestamp("used_at", { mode: 'string' }),
        createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
}, (table) => [
        index("password_reset_tokens_user_id_idx").using("btree", table.userId.asc().nullsLast().op("text_ops")),
        foreignKey({
                        columns: [table.userId],
                        foreignColumns: [users.id],
                        name: "password_reset_tokens_user_id_users_id_fk"
                }),
        unique("password_reset_tokens_token_unique").on(table.token),
]);

export const syncSchedules = pgTable("sync_schedules", {
        id: varchar().default(gen_random_uuid()).primaryKey().notNull(),
        contractorId: varchar("contractor_id").notNull(),
        integrationName: varchar("integration_name").notNull(),
        frequency: syncFrequency().default('daily').notNull(),
        lastSyncAt: timestamp("last_sync_at", { mode: 'string' }),
        nextSyncAt: timestamp("next_sync_at", { mode: 'string' }).notNull(),
        isEnabled: boolean("is_enabled").default(true).notNull(),
        createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
        updatedAt: timestamp("updated_at", { mode: 'string' }).defaultNow().notNull(),
}, (table) => [
        index("sync_schedules_next_sync_at_idx").using("btree", table.nextSyncAt.asc().nullsLast().op("timestamp_ops"), table.isEnabled.asc().nullsLast().op("timestamp_ops")),
        foreignKey({
                        columns: [table.contractorId],
                        foreignColumns: [contractors.id],
                        name: "sync_schedules_contractor_id_contractors_id_fk"
                }),
        unique("sync_schedules_contractor_integration_unique").on(table.contractorId, table.integrationName),
]);

export const terminologySettings = pgTable("terminology_settings", {
        id: varchar().default(gen_random_uuid()).primaryKey().notNull(),
        contractorId: varchar("contractor_id").notNull(),
        leadLabel: text("lead_label").default('Lead').notNull(),
        leadsLabel: text("leads_label").default('Leads').notNull(),
        estimateLabel: text("estimate_label").default('Estimate').notNull(),
        estimatesLabel: text("estimates_label").default('Estimates').notNull(),
        jobLabel: text("job_label").default('Job').notNull(),
        jobsLabel: text("jobs_label").default('Jobs').notNull(),
        messageLabel: text("message_label").default('Message').notNull(),
        messagesLabel: text("messages_label").default('Messages').notNull(),
        templateLabel: text("template_label").default('Template').notNull(),
        templatesLabel: text("templates_label").default('Templates').notNull(),
        createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
        updatedAt: timestamp("updated_at", { mode: 'string' }).defaultNow().notNull(),
}, (table) => [
        foreignKey({
                        columns: [table.contractorId],
                        foreignColumns: [contractors.id],
                        name: "terminology_settings_contractor_id_contractors_id_fk"
                }),
        unique("terminology_settings_contractor_id_unique").on(table.contractorId),
]);

export const contacts = pgTable("contacts", {
        id: varchar().default(gen_random_uuid()).primaryKey().notNull(),
        name: text().notNull(),
        emails: text().array().default([""]),
        phones: text().array().default([""]),
        address: text(),
        type: contactType().default('lead').notNull(),
        status: contactStatus().default('new').notNull(),
        source: text(),
        notes: text(),
        tags: text().array().default([""]),
        followUpDate: timestamp("follow_up_date", { mode: 'string' }),
        utmSource: text("utm_source"),
        utmMedium: text("utm_medium"),
        utmCampaign: text("utm_campaign"),
        utmTerm: text("utm_term"),
        utmContent: text("utm_content"),
        pageUrl: text("page_url"),
        housecallProCustomerId: varchar("housecall_pro_customer_id"),
        housecallProEstimateId: varchar("housecall_pro_estimate_id"),
        scheduledAt: timestamp("scheduled_at", { mode: 'string' }),
        scheduledEmployeeId: varchar("scheduled_employee_id"),
        isScheduled: boolean("is_scheduled").default(false).notNull(),
        contactedAt: timestamp("contacted_at", { mode: 'string' }),
        contactedByUserId: varchar("contacted_by_user_id"),
        scheduledByUserId: varchar("scheduled_by_user_id"),
        externalId: varchar("external_id"),
        externalSource: varchar("external_source"),
        normalizedPhone: text("normalized_phone"),
        contractorId: varchar("contractor_id").notNull(),
        createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
        updatedAt: timestamp("updated_at", { mode: 'string' }).defaultNow().notNull(),
}, (table) => [
        index("contacts_contacted_at_idx").using("btree", table.contactedAt.asc().nullsLast().op("timestamp_ops")),
        index("contacts_contractor_date_idx").using("btree", table.contractorId.asc().nullsLast().op("timestamp_ops"), table.createdAt.asc().nullsLast().op("timestamp_ops")),
        index("contacts_contractor_follow_up_idx").using("btree", table.contractorId.asc().nullsLast().op("timestamp_ops"), table.followUpDate.asc().nullsLast().op("timestamp_ops")).where(sql`(follow_up_date IS NOT NULL)`),
        index("contacts_contractor_id_idx").using("btree", table.contractorId.asc().nullsLast().op("text_ops")),
        index("contacts_contractor_normalized_phone_idx").using("btree", table.contractorId.asc().nullsLast().op("text_ops"), table.normalizedPhone.asc().nullsLast().op("text_ops")),
        index("contacts_contractor_scheduled_idx").using("btree", table.contractorId.asc().nullsLast().op("bool_ops"), table.isScheduled.asc().nullsLast().op("bool_ops")),
        index("contacts_contractor_status_idx").using("btree", table.contractorId.asc().nullsLast().op("enum_ops"), table.status.asc().nullsLast().op("text_ops")),
        index("contacts_contractor_type_idx").using("btree", table.contractorId.asc().nullsLast().op("enum_ops"), table.type.asc().nullsLast().op("enum_ops")),
        index("contacts_created_at_idx").using("btree", table.createdAt.asc().nullsLast().op("timestamp_ops")),
        index("contacts_emails_gin_idx").using("gin", table.emails.asc().nullsLast().op("array_ops")),
        index("contacts_external_lookup_idx").using("btree", table.contractorId.asc().nullsLast().op("text_ops"), table.externalSource.asc().nullsLast().op("text_ops"), table.externalId.asc().nullsLast().op("text_ops")),
        index("contacts_follow_up_date_idx").using("btree", table.followUpDate.asc().nullsLast().op("timestamp_ops")).where(sql`(follow_up_date IS NOT NULL)`),
        index("contacts_housecall_pro_customer_id_idx").using("btree", table.housecallProCustomerId.asc().nullsLast().op("text_ops")).where(sql`(housecall_pro_customer_id IS NOT NULL)`),
        index("contacts_is_scheduled_idx").using("btree", table.isScheduled.asc().nullsLast().op("bool_ops")),
        index("contacts_phones_gin_idx").using("gin", table.phones.asc().nullsLast().op("array_ops")),
        index("contacts_status_idx").using("btree", table.status.asc().nullsLast().op("enum_ops")),
        index("contacts_tags_idx").using("btree", table.tags.asc().nullsLast().op("array_ops")),
        index("contacts_type_idx").using("btree", table.type.asc().nullsLast().op("enum_ops")),
        foreignKey({
                        columns: [table.contactedByUserId],
                        foreignColumns: [users.id],
                        name: "contacts_contacted_by_user_id_users_id_fk"
                }),
        foreignKey({
                        columns: [table.scheduledByUserId],
                        foreignColumns: [users.id],
                        name: "contacts_scheduled_by_user_id_users_id_fk"
                }),
        foreignKey({
                        columns: [table.contractorId],
                        foreignColumns: [contractors.id],
                        name: "contacts_contractor_id_contractors_id_fk"
                }),
]);

export const scheduledBookings = pgTable("scheduled_bookings", {
        id: varchar().default(gen_random_uuid()).primaryKey().notNull(),
        contractorId: varchar("contractor_id").notNull(),
        assignedSalespersonId: varchar("assigned_salesperson_id").notNull(),
        contactId: varchar("contact_id"),
        housecallProEventId: text("housecall_pro_event_id"),
        title: text().notNull(),
        startTime: timestamp("start_time", { mode: 'string' }).notNull(),
        endTime: timestamp("end_time", { mode: 'string' }).notNull(),
        customerName: text("customer_name"),
        customerEmail: text("customer_email"),
        customerPhone: text("customer_phone"),
        notes: text(),
        status: text().default('confirmed').notNull(),
        createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
        updatedAt: timestamp("updated_at", { mode: 'string' }).defaultNow().notNull(),
}, (table) => [
        index("scheduled_bookings_contractor_idx").using("btree", table.contractorId.asc().nullsLast().op("text_ops")),
        index("scheduled_bookings_salesperson_idx").using("btree", table.assignedSalespersonId.asc().nullsLast().op("text_ops")),
        index("scheduled_bookings_start_time_idx").using("btree", table.startTime.asc().nullsLast().op("timestamp_ops")),
        foreignKey({
                        columns: [table.contractorId],
                        foreignColumns: [contractors.id],
                        name: "scheduled_bookings_contractor_id_contractors_id_fk"
                }).onDelete("cascade"),
        foreignKey({
                        columns: [table.assignedSalespersonId],
                        foreignColumns: [users.id],
                        name: "scheduled_bookings_assigned_salesperson_id_users_id_fk"
                }),
        foreignKey({
                        columns: [table.contactId],
                        foreignColumns: [contacts.id],
                        name: "scheduled_bookings_contact_id_contacts_id_fk"
                }).onDelete("set null"),
]);

export const jobs = pgTable("jobs", {
        id: varchar().default(gen_random_uuid()).primaryKey().notNull(),
        title: text().notNull(),
        type: text().notNull(),
        status: jobStatus().default('scheduled').notNull(),
        priority: jobPriority().default('medium').notNull(),
        value: numeric({ precision: 10, scale:  2 }).notNull(),
        estimatedHours: integer("estimated_hours"),
        scheduledDate: timestamp("scheduled_date", { mode: 'string' }),
        contactId: varchar("contact_id").notNull(),
        estimateId: varchar("estimate_id"),
        notes: text(),
        externalId: varchar("external_id"),
        externalSource: varchar("external_source"),
        contractorId: varchar("contractor_id").notNull(),
        createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
        updatedAt: timestamp("updated_at", { mode: 'string' }).defaultNow().notNull(),
        followUpDate: timestamp("follow_up_date", { mode: 'string' }),
}, (table) => [
        index("jobs_contact_id_idx").using("btree", table.contactId.asc().nullsLast().op("text_ops")),
        index("jobs_contractor_date_idx").using("btree", table.contractorId.asc().nullsLast().op("text_ops"), table.createdAt.asc().nullsLast().op("timestamp_ops")),
        index("jobs_contractor_id_idx").using("btree", table.contractorId.asc().nullsLast().op("text_ops")),
        index("jobs_contractor_status_idx").using("btree", table.contractorId.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops")),
        index("jobs_contractor_title_idx").using("btree", table.contractorId.asc().nullsLast().op("text_ops"), table.title.asc().nullsLast().op("text_ops")),
        index("jobs_created_at_idx").using("btree", table.createdAt.asc().nullsLast().op("timestamp_ops")),
        index("jobs_estimate_id_idx").using("btree", table.estimateId.asc().nullsLast().op("text_ops")),
        index("jobs_external_id_idx").using("btree", table.externalId.asc().nullsLast().op("text_ops")).where(sql`(external_id IS NOT NULL)`),
        index("jobs_follow_up_date_idx").using("btree", table.contractorId.asc().nullsLast().op("text_ops"), table.followUpDate.asc().nullsLast().op("timestamp_ops")).where(sql`(follow_up_date IS NOT NULL)`),
        index("jobs_scheduled_date_idx").using("btree", table.scheduledDate.asc().nullsLast().op("timestamp_ops")),
        index("jobs_status_idx").using("btree", table.status.asc().nullsLast().op("enum_ops")),
        foreignKey({
                        columns: [table.contactId],
                        foreignColumns: [contacts.id],
                        name: "jobs_contact_id_contacts_id_fk"
                }),
        foreignKey({
                        columns: [table.estimateId],
                        foreignColumns: [estimates.id],
                        name: "jobs_estimate_id_estimates_id_fk"
                }),
        foreignKey({
                        columns: [table.contractorId],
                        foreignColumns: [contractors.id],
                        name: "jobs_contractor_id_contractors_id_fk"
                }),
]);

export const estimates = pgTable("estimates", {
        id: varchar().default(gen_random_uuid()).primaryKey().notNull(),
        title: text().notNull(),
        description: text(),
        amount: numeric({ precision: 10, scale:  2 }).notNull(),
        status: estimateStatus().default('draft').notNull(),
        validUntil: timestamp("valid_until", { mode: 'string' }),
        followUpDate: timestamp("follow_up_date", { mode: 'string' }),
        contactId: varchar("contact_id").notNull(),
        housecallProEstimateId: varchar("housecall_pro_estimate_id"),
        housecallProCustomerId: varchar("housecall_pro_customer_id"),
        scheduledStart: timestamp("scheduled_start", { mode: 'string' }),
        scheduledEnd: timestamp("scheduled_end", { mode: 'string' }),
        scheduledEmployeeId: varchar("scheduled_employee_id"),
        syncedAt: timestamp("synced_at", { mode: 'string' }),
        externalId: varchar("external_id"),
        externalSource: varchar("external_source"),
        contractorId: varchar("contractor_id").notNull(),
        createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
        updatedAt: timestamp("updated_at", { mode: 'string' }).defaultNow().notNull(),
        hcpOptions: jsonb("hcp_options"),
}, (table) => [
        index("estimates_contact_id_idx").using("btree", table.contactId.asc().nullsLast().op("text_ops")),
        index("estimates_contractor_date_idx").using("btree", table.contractorId.asc().nullsLast().op("text_ops"), table.createdAt.asc().nullsLast().op("text_ops")),
        index("estimates_contractor_id_idx").using("btree", table.contractorId.asc().nullsLast().op("text_ops")),
        index("estimates_contractor_status_idx").using("btree", table.contractorId.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops")),
        index("estimates_contractor_title_idx").using("btree", table.contractorId.asc().nullsLast().op("text_ops"), table.title.asc().nullsLast().op("text_ops")),
        index("estimates_created_at_idx").using("btree", table.createdAt.asc().nullsLast().op("timestamp_ops")),
        index("estimates_external_id_contractor_idx").using("btree", table.externalId.asc().nullsLast().op("text_ops"), table.contractorId.asc().nullsLast().op("text_ops")).where(sql`(external_id IS NOT NULL)`),
        index("estimates_follow_up_date_idx").using("btree", table.followUpDate.asc().nullsLast().op("timestamp_ops")),
        index("estimates_housecall_pro_estimate_id_idx").using("btree", table.housecallProEstimateId.asc().nullsLast().op("text_ops")).where(sql`(housecall_pro_estimate_id IS NOT NULL)`),
        index("estimates_status_idx").using("btree", table.status.asc().nullsLast().op("enum_ops")),
        foreignKey({
                        columns: [table.contactId],
                        foreignColumns: [contacts.id],
                        name: "estimates_contact_id_contacts_id_fk"
                }),
        foreignKey({
                        columns: [table.contractorId],
                        foreignColumns: [contractors.id],
                        name: "estimates_contractor_id_contractors_id_fk"
                }),
]);

export const leads = pgTable("leads", {
        id: varchar().default(gen_random_uuid()).primaryKey().notNull(),
        contactId: varchar("contact_id").notNull(),
        status: leadStatus().default('new').notNull(),
        source: text(),
        message: text(),
        housecallProLeadId: varchar("housecall_pro_lead_id"),
        utmSource: text("utm_source"),
        utmMedium: text("utm_medium"),
        utmCampaign: text("utm_campaign"),
        utmTerm: text("utm_term"),
        utmContent: text("utm_content"),
        pageUrl: text("page_url"),
        rawPayload: text("raw_payload"),
        archived: boolean().default(false).notNull(),
        followUpDate: timestamp("follow_up_date", { mode: 'string' }),
        convertedAt: timestamp("converted_at", { mode: 'string' }),
        convertedToEstimateId: varchar("converted_to_estimate_id"),
        convertedToJobId: varchar("converted_to_job_id"),
        assignedToUserId: varchar("assigned_to_user_id"),
        contractorId: varchar("contractor_id").notNull(),
        createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
        updatedAt: timestamp("updated_at", { mode: 'string' }).defaultNow().notNull(),
}, (table) => [
        index("leads_assigned_to_user_id_idx").using("btree", table.assignedToUserId.asc().nullsLast().op("text_ops")),
        index("leads_contact_created_idx").using("btree", table.contactId.asc().nullsLast().op("timestamp_ops"), table.createdAt.asc().nullsLast().op("timestamp_ops")),
        index("leads_contact_id_idx").using("btree", table.contactId.asc().nullsLast().op("text_ops")),
        index("leads_contractor_date_idx").using("btree", table.contractorId.asc().nullsLast().op("text_ops"), table.createdAt.asc().nullsLast().op("text_ops")),
        index("leads_contractor_id_idx").using("btree", table.contractorId.asc().nullsLast().op("text_ops")),
        index("leads_contractor_status_idx").using("btree", table.contractorId.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("enum_ops")),
        index("leads_converted_to_estimate_id_idx").using("btree", table.convertedToEstimateId.asc().nullsLast().op("text_ops")),
        index("leads_converted_to_job_id_idx").using("btree", table.convertedToJobId.asc().nullsLast().op("text_ops")),
        index("leads_created_at_idx").using("btree", table.createdAt.asc().nullsLast().op("timestamp_ops")),
        index("leads_status_idx").using("btree", table.status.asc().nullsLast().op("enum_ops")),
        foreignKey({
                        columns: [table.contactId],
                        foreignColumns: [contacts.id],
                        name: "leads_contact_id_contacts_id_fk"
                }).onDelete("cascade"),
        foreignKey({
                        columns: [table.convertedToEstimateId],
                        foreignColumns: [estimates.id],
                        name: "leads_converted_to_estimate_id_estimates_id_fk"
                }),
        foreignKey({
                        columns: [table.convertedToJobId],
                        foreignColumns: [jobs.id],
                        name: "leads_converted_to_job_id_jobs_id_fk"
                }),
        foreignKey({
                        columns: [table.assignedToUserId],
                        foreignColumns: [users.id],
                        name: "leads_assigned_to_user_id_users_id_fk"
                }),
        foreignKey({
                        columns: [table.contractorId],
                        foreignColumns: [contractors.id],
                        name: "leads_contractor_id_contractors_id_fk"
                }),
]);

export const messages = pgTable("messages", {
        id: varchar().default(gen_random_uuid()).primaryKey().notNull(),
        type: messageType().default('text').notNull(),
        status: messageStatus().default('sent').notNull(),
        direction: messageDirection().default('outbound').notNull(),
        content: text().notNull(),
        toNumber: text("to_number").notNull(),
        fromNumber: text("from_number"),
        contactId: varchar("contact_id"),
        estimateId: varchar("estimate_id"),
        userId: varchar("user_id"),
        externalMessageId: text("external_message_id"),
        contractorId: varchar("contractor_id").notNull(),
        createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
}, (table) => [
        index("messages_contact_id_idx").using("btree", table.contactId.asc().nullsLast().op("text_ops")),
        index("messages_contractor_contact_created_idx").using("btree", table.contractorId.asc().nullsLast().op("timestamp_ops"), table.contactId.asc().nullsLast().op("timestamp_ops"), table.createdAt.asc().nullsLast().op("timestamp_ops")),
        index("messages_contractor_contact_idx").using("btree", table.contractorId.asc().nullsLast().op("text_ops"), table.contactId.asc().nullsLast().op("text_ops")),
        index("messages_contractor_id_idx").using("btree", table.contractorId.asc().nullsLast().op("text_ops")),
        index("messages_contractor_phone_idx").using("btree", table.contractorId.asc().nullsLast().op("text_ops"), table.toNumber.asc().nullsLast().op("text_ops")),
        index("messages_created_at_idx").using("btree", table.createdAt.asc().nullsLast().op("timestamp_ops")),
        index("messages_direction_idx").using("btree", table.direction.asc().nullsLast().op("enum_ops")),
        index("messages_estimate_id_idx").using("btree", table.estimateId.asc().nullsLast().op("text_ops")),
        index("messages_external_message_id_idx").using("btree", table.externalMessageId.asc().nullsLast().op("text_ops")),
        index("messages_from_number_idx").using("btree", table.fromNumber.asc().nullsLast().op("text_ops")),
        index("messages_to_number_idx").using("btree", table.toNumber.asc().nullsLast().op("text_ops")),
        foreignKey({
                        columns: [table.contactId],
                        foreignColumns: [contacts.id],
                        name: "messages_contact_id_contacts_id_fk"
                }).onDelete("cascade"),
        foreignKey({
                        columns: [table.estimateId],
                        foreignColumns: [estimates.id],
                        name: "messages_estimate_id_estimates_id_fk"
                }).onDelete("cascade"),
        foreignKey({
                        columns: [table.userId],
                        foreignColumns: [users.id],
                        name: "messages_user_id_users_id_fk"
                }).onDelete("set null"),
        foreignKey({
                        columns: [table.contractorId],
                        foreignColumns: [contractors.id],
                        name: "messages_contractor_id_contractors_id_fk"
                }),
]);

export const webhooks = pgTable("webhooks", {
        id: varchar().default(gen_random_uuid()).primaryKey().notNull(),
        contractorId: varchar("contractor_id").notNull(),
        service: varchar().notNull(),
        webhookType: varchar("webhook_type").notNull(),
        externalWebhookId: varchar("external_webhook_id"),
        webhookUrl: text("webhook_url").notNull(),
        isActive: boolean("is_active").default(true).notNull(),
        lastReceivedAt: timestamp("last_received_at", { mode: 'string' }),
        createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
        updatedAt: timestamp("updated_at", { mode: 'string' }).defaultNow().notNull(),
}, (table) => [
        index("webhooks_contractor_id_idx").using("btree", table.contractorId.asc().nullsLast().op("text_ops")),
        index("webhooks_contractor_service_idx").using("btree", table.contractorId.asc().nullsLast().op("text_ops"), table.service.asc().nullsLast().op("text_ops")),
        index("webhooks_is_active_idx").using("btree", table.isActive.asc().nullsLast().op("bool_ops")),
        index("webhooks_service_idx").using("btree", table.service.asc().nullsLast().op("text_ops")),
        index("webhooks_webhook_type_idx").using("btree", table.webhookType.asc().nullsLast().op("text_ops")),
        foreignKey({
                        columns: [table.contractorId],
                        foreignColumns: [contractors.id],
                        name: "webhooks_contractor_id_contractors_id_fk"
                }),
]);

export const webhookEvents = pgTable("webhook_events", {
        id: varchar().default(gen_random_uuid()).primaryKey().notNull(),
        webhookId: varchar("webhook_id"),
        contractorId: varchar("contractor_id"),
        service: varchar().notNull(),
        eventType: varchar("event_type").notNull(),
        payload: text().notNull(),
        processed: boolean().default(false).notNull(),
        processedAt: timestamp("processed_at", { mode: 'string' }),
        errorMessage: text("error_message"),
        createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
}, (table) => [
        index("webhook_events_cleanup_idx").using("btree", table.createdAt.asc().nullsLast().op("bool_ops"), table.processed.asc().nullsLast().op("timestamp_ops")),
        index("webhook_events_contractor_id_idx").using("btree", table.contractorId.asc().nullsLast().op("text_ops")),
        index("webhook_events_created_at_idx").using("btree", table.createdAt.asc().nullsLast().op("timestamp_ops")),
        index("webhook_events_event_type_idx").using("btree", table.eventType.asc().nullsLast().op("text_ops")),
        index("webhook_events_processed_created_at_idx").using("btree", table.processed.asc().nullsLast().op("bool_ops"), table.createdAt.asc().nullsLast().op("bool_ops")),
        index("webhook_events_processed_idx").using("btree", table.processed.asc().nullsLast().op("bool_ops")),
        index("webhook_events_service_idx").using("btree", table.service.asc().nullsLast().op("text_ops")),
        index("webhook_events_unprocessed_idx").using("btree", table.createdAt.asc().nullsLast().op("timestamp_ops")).where(sql`(processed = false)`),
        index("webhook_events_webhook_id_idx").using("btree", table.webhookId.asc().nullsLast().op("text_ops")),
        foreignKey({
                        columns: [table.webhookId],
                        foreignColumns: [webhooks.id],
                        name: "webhook_events_webhook_id_webhooks_id_fk"
                }),
        foreignKey({
                        columns: [table.contractorId],
                        foreignColumns: [contractors.id],
                        name: "webhook_events_contractor_id_contractors_id_fk"
                }),
]);

export const templates = pgTable("templates", {
        id: varchar().default(gen_random_uuid()).primaryKey().notNull(),
        title: text().notNull(),
        content: text().notNull(),
        type: templateType().notNull(),
        status: templateStatus().default('pending_approval').notNull(),
        createdBy: varchar("created_by").notNull(),
        approvedBy: varchar("approved_by"),
        approvedAt: timestamp("approved_at", { mode: 'string' }),
        rejectionReason: text("rejection_reason"),
        contractorId: varchar("contractor_id").notNull(),
        createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
        updatedAt: timestamp("updated_at", { mode: 'string' }).defaultNow().notNull(),
        subject: text(),
}, (table) => [
        index("templates_contractor_id_idx").using("btree", table.contractorId.asc().nullsLast().op("text_ops")),
        index("templates_type_idx").using("btree", table.type.asc().nullsLast().op("enum_ops")),
        foreignKey({
                        columns: [table.createdBy],
                        foreignColumns: [users.id],
                        name: "templates_created_by_users_id_fk"
                }),
        foreignKey({
                        columns: [table.approvedBy],
                        foreignColumns: [users.id],
                        name: "templates_approved_by_users_id_fk"
                }),
        foreignKey({
                        columns: [table.contractorId],
                        foreignColumns: [contractors.id],
                        name: "templates_contractor_id_contractors_id_fk"
                }),
]);

export const activities = pgTable("activities", {
        id: varchar().default(gen_random_uuid()).primaryKey().notNull(),
        type: activityType().default('note').notNull(),
        title: text(),
        content: text().notNull(),
        metadata: text(),
        contactId: varchar("contact_id"),
        estimateId: varchar("estimate_id"),
        jobId: varchar("job_id"),
        userId: varchar("user_id"),
        contractorId: varchar("contractor_id").notNull(),
        externalId: varchar("external_id"),
        externalSource: varchar("external_source"),
        createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
        updatedAt: timestamp("updated_at", { mode: 'string' }).defaultNow().notNull(),
}, (table) => [
        index("activities_contact_id_idx").using("btree", table.contactId.asc().nullsLast().op("text_ops")),
        index("activities_contractor_contact_date_idx").using("btree", table.contractorId.asc().nullsLast().op("timestamp_ops"), table.contactId.asc().nullsLast().op("timestamp_ops"), table.createdAt.asc().nullsLast().op("timestamp_ops")),
        index("activities_contractor_contact_idx").using("btree", table.contractorId.asc().nullsLast().op("text_ops"), table.contactId.asc().nullsLast().op("text_ops")),
        index("activities_contractor_date_idx").using("btree", table.contractorId.asc().nullsLast().op("timestamp_ops"), table.createdAt.asc().nullsLast().op("timestamp_ops")),
        index("activities_contractor_id_idx").using("btree", table.contractorId.asc().nullsLast().op("text_ops")),
        index("activities_contractor_type_contact_idx").using("btree", table.contractorId.asc().nullsLast().op("enum_ops"), table.type.asc().nullsLast().op("text_ops"), table.contactId.asc().nullsLast().op("text_ops")),
        index("activities_contractor_type_idx").using("btree", table.contractorId.asc().nullsLast().op("enum_ops"), table.type.asc().nullsLast().op("text_ops")),
        index("activities_created_at_idx").using("btree", table.createdAt.asc().nullsLast().op("timestamp_ops")),
        index("activities_estimate_id_idx").using("btree", table.estimateId.asc().nullsLast().op("text_ops")),
        index("activities_external_lookup_idx").using("btree", table.externalSource.asc().nullsLast().op("text_ops"), table.externalId.asc().nullsLast().op("text_ops")),
        index("activities_job_id_idx").using("btree", table.jobId.asc().nullsLast().op("text_ops")),
        index("activities_type_idx").using("btree", table.type.asc().nullsLast().op("enum_ops")),
        uniqueIndex("activities_unique_external_idx").using("btree", table.contractorId.asc().nullsLast().op("text_ops"), table.externalSource.asc().nullsLast().op("text_ops"), table.externalId.asc().nullsLast().op("text_ops")).where(sql`(external_id IS NOT NULL)`),
        index("activities_user_id_idx").using("btree", table.userId.asc().nullsLast().op("text_ops")),
        foreignKey({
                        columns: [table.contactId],
                        foreignColumns: [contacts.id],
                        name: "activities_contact_id_contacts_id_fk"
                }).onDelete("cascade"),
        foreignKey({
                        columns: [table.estimateId],
                        foreignColumns: [estimates.id],
                        name: "activities_estimate_id_estimates_id_fk"
                }).onDelete("cascade"),
        foreignKey({
                        columns: [table.jobId],
                        foreignColumns: [jobs.id],
                        name: "activities_job_id_jobs_id_fk"
                }).onDelete("cascade"),
        foreignKey({
                        columns: [table.userId],
                        foreignColumns: [users.id],
                        name: "activities_user_id_users_id_fk"
                }).onDelete("set null"),
        foreignKey({
                        columns: [table.contractorId],
                        foreignColumns: [contractors.id],
                        name: "activities_contractor_id_contractors_id_fk"
                }),
]);

export const notifications = pgTable("notifications", {
        id: varchar().default(gen_random_uuid()).primaryKey().notNull(),
        userId: varchar("user_id").notNull(),
        contractorId: varchar("contractor_id").notNull(),
        type: notificationType().notNull(),
        title: text().notNull(),
        message: text().notNull(),
        link: text(),
        read: boolean().default(false).notNull(),
        createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
}, (table) => [
        index("notifications_contractor_id_idx").using("btree", table.contractorId.asc().nullsLast().op("text_ops")),
        index("notifications_created_at_idx").using("btree", table.createdAt.asc().nullsLast().op("timestamp_ops")),
        index("notifications_user_contractor_unread_created_idx").using("btree", table.userId.asc().nullsLast().op("bool_ops"), table.contractorId.asc().nullsLast().op("timestamp_ops"), table.read.asc().nullsLast().op("text_ops"), table.createdAt.asc().nullsLast().op("text_ops")),
        index("notifications_user_id_idx").using("btree", table.userId.asc().nullsLast().op("text_ops")),
        index("notifications_user_unread_idx").using("btree", table.userId.asc().nullsLast().op("text_ops"), table.read.asc().nullsLast().op("text_ops")),
        foreignKey({
                        columns: [table.userId],
                        foreignColumns: [users.id],
                        name: "notifications_user_id_users_id_fk"
                }).onDelete("cascade"),
        foreignKey({
                        columns: [table.contractorId],
                        foreignColumns: [contractors.id],
                        name: "notifications_contractor_id_contractors_id_fk"
                }).onDelete("cascade"),
]);

export const contractorCredentials = pgTable("contractor_credentials", {
        id: varchar().default(gen_random_uuid()).primaryKey().notNull(),
        contractorId: varchar("contractor_id").notNull(),
        service: varchar().notNull(),
        credentialKey: varchar("credential_key").notNull(),
        encryptedValue: text("encrypted_value").notNull(),
        isActive: boolean("is_active").default(true).notNull(),
        createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
        updatedAt: timestamp("updated_at", { mode: 'string' }).defaultNow().notNull(),
}, (table) => [
        foreignKey({
                        columns: [table.contractorId],
                        foreignColumns: [contractors.id],
                        name: "contractor_credentials_tenant_id_contractors_id_fk"
                }),
        unique("contractor_credentials_contractor_id_service_credential_key_uni").on(table.contractorId, table.service, table.credentialKey),
]);

export const contractorProviders = pgTable("contractor_providers", {
        id: varchar().default(gen_random_uuid()).primaryKey().notNull(),
        contractorId: varchar("contractor_id").notNull(),
        providerType: providerType("provider_type").notNull(),
        emailProvider: emailProvider("email_provider"),
        smsProvider: smsProvider("sms_provider"),
        callingProvider: callingProvider("calling_provider"),
        isActive: boolean("is_active").default(true).notNull(),
        createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
        updatedAt: timestamp("updated_at", { mode: 'string' }).defaultNow().notNull(),
}, (table) => [
        foreignKey({
                        columns: [table.contractorId],
                        foreignColumns: [contractors.id],
                        name: "contractor_providers_tenant_id_contractors_id_fk"
                }),
        unique("contractor_providers_contractor_id_provider_type_unique").on(table.contractorId, table.providerType),
]);

export const dialpadUsers = pgTable("dialpad_users", {
        id: varchar().default(gen_random_uuid()).primaryKey().notNull(),
        contractorId: varchar("contractor_id").notNull(),
        dialpadUserId: text("dialpad_user_id").notNull(),
        email: text().notNull(),
        firstName: text("first_name"),
        lastName: text("last_name"),
        fullName: text("full_name"),
        isActive: boolean("is_active").default(true).notNull(),
        department: text(),
        phoneNumbers: text("phone_numbers").array().default([""]),
        lastSyncAt: timestamp("last_sync_at", { mode: 'string' }),
        syncChecksum: text("sync_checksum"),
        createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
        updatedAt: timestamp("updated_at", { mode: 'string' }).defaultNow().notNull(),
}, (table) => [
        index("dialpad_users_contractor_id_idx").using("btree", table.contractorId.asc().nullsLast().op("text_ops")),
        foreignKey({
                        columns: [table.contractorId],
                        foreignColumns: [contractors.id],
                        name: "dialpad_users_contractor_id_contractors_id_fk"
                }),
        unique("dialpad_users_contractor_id_dialpad_user_id_unique").on(table.contractorId, table.dialpadUserId),
]);

export const contractorIntegrations = pgTable("contractor_integrations", {
        id: varchar().default(gen_random_uuid()).primaryKey().notNull(),
        contractorId: varchar("contractor_id").notNull(),
        integrationName: varchar("integration_name").notNull(),
        isEnabled: boolean("is_enabled").default(false).notNull(),
        enabledAt: timestamp("enabled_at", { mode: 'string' }),
        disabledAt: timestamp("disabled_at", { mode: 'string' }),
        enabledBy: varchar("enabled_by"),
        createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
        updatedAt: timestamp("updated_at", { mode: 'string' }).defaultNow().notNull(),
}, (table) => [
        index("contractor_integrations_enabled_by_idx").using("btree", table.enabledBy.asc().nullsLast().op("text_ops")),
        foreignKey({
                        columns: [table.contractorId],
                        foreignColumns: [contractors.id],
                        name: "contractor_integrations_tenant_id_contractors_id_fk"
                }),
        foreignKey({
                        columns: [table.enabledBy],
                        foreignColumns: [users.id],
                        name: "contractor_integrations_enabled_by_users_id_fk"
                }),
        unique("contractor_integrations_contractor_id_integration_name_unique").on(table.contractorId, table.integrationName),
]);

export const employees = pgTable("employees", {
        id: varchar().default(gen_random_uuid()).primaryKey().notNull(),
        contractorId: varchar("contractor_id").notNull(),
        externalSource: varchar("external_source"),
        externalId: varchar("external_id"),
        firstName: text("first_name").notNull(),
        lastName: text("last_name").notNull(),
        email: text(),
        isActive: boolean("is_active").default(true).notNull(),
        externalRole: text("external_role"),
        roles: text().array().default([""]).notNull(),
        department: text(),
        createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
        updatedAt: timestamp("updated_at", { mode: 'string' }).defaultNow().notNull(),
}, (table) => [
        foreignKey({
                        columns: [table.contractorId],
                        foreignColumns: [contractors.id],
                        name: "employees_contractor_id_contractors_id_fk"
                }),
        unique("employees_contractor_id_external_source_external_id_unique").on(table.contractorId, table.externalSource, table.externalId),
]);

export const dialpadPhoneNumbers = pgTable("dialpad_phone_numbers", {
        id: varchar().default(gen_random_uuid()).primaryKey().notNull(),
        contractorId: varchar("contractor_id").notNull(),
        phoneNumber: text("phone_number").notNull(),
        dialpadId: text("dialpad_id"),
        displayName: text("display_name"),
        department: text(),
        canSendSms: boolean("can_send_sms").default(false).notNull(),
        canReceiveSms: boolean("can_receive_sms").default(false).notNull(),
        canMakeCalls: boolean("can_make_calls").default(false).notNull(),
        canReceiveCalls: boolean("can_receive_calls").default(false).notNull(),
        isActive: boolean("is_active").default(true).notNull(),
        lastSyncAt: timestamp("last_sync_at", { mode: 'string' }),
        createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
        updatedAt: timestamp("updated_at", { mode: 'string' }).defaultNow().notNull(),
}, (table) => [
        foreignKey({
                        columns: [table.contractorId],
                        foreignColumns: [contractors.id],
                        name: "dialpad_phone_numbers_contractor_id_contractors_id_fk"
                }),
        unique("dialpad_phone_numbers_contractor_id_phone_number_unique").on(table.contractorId, table.phoneNumber),
]);

export const userPhoneNumberPermissions = pgTable("user_phone_number_permissions", {
        id: varchar().default(gen_random_uuid()).primaryKey().notNull(),
        userId: varchar("user_id").notNull(),
        phoneNumberId: varchar("phone_number_id").notNull(),
        contractorId: varchar("contractor_id").notNull(),
        canSendSms: boolean("can_send_sms").default(false).notNull(),
        canMakeCalls: boolean("can_make_calls").default(false).notNull(),
        isActive: boolean("is_active").default(true).notNull(),
        assignedBy: varchar("assigned_by"),
        createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
        updatedAt: timestamp("updated_at", { mode: 'string' }).defaultNow().notNull(),
}, (table) => [
        index("user_phone_permissions_contractor_id_idx").using("btree", table.contractorId.asc().nullsLast().op("text_ops")),
        index("user_phone_permissions_phone_number_id_idx").using("btree", table.phoneNumberId.asc().nullsLast().op("text_ops")),
        index("user_phone_permissions_user_id_idx").using("btree", table.userId.asc().nullsLast().op("text_ops")),
        foreignKey({
                        columns: [table.phoneNumberId],
                        foreignColumns: [dialpadPhoneNumbers.id],
                        name: "user_phone_number_permissions_phone_number_id_dialpad_phone_num"
                }),
        foreignKey({
                        columns: [table.userId],
                        foreignColumns: [users.id],
                        name: "user_phone_number_permissions_user_id_users_id_fk"
                }),
        foreignKey({
                        columns: [table.contractorId],
                        foreignColumns: [contractors.id],
                        name: "user_phone_number_permissions_contractor_id_contractors_id_fk"
                }),
        foreignKey({
                        columns: [table.assignedBy],
                        foreignColumns: [users.id],
                        name: "user_phone_number_permissions_assigned_by_users_id_fk"
                }),
        unique("user_phone_number_permissions_user_id_phone_number_id_unique").on(table.userId, table.phoneNumberId),
]);

export const dialpadDepartments = pgTable("dialpad_departments", {
        id: varchar().default(gen_random_uuid()).primaryKey().notNull(),
        contractorId: varchar("contractor_id").notNull(),
        dialpadDepartmentId: text("dialpad_department_id").notNull(),
        name: text().notNull(),
        description: text(),
        isActive: boolean("is_active").default(true).notNull(),
        phoneNumbers: text("phone_numbers").array().default([""]),
        userCount: integer("user_count").default(0),
        lastSyncAt: timestamp("last_sync_at", { mode: 'string' }),
        syncChecksum: text("sync_checksum"),
        createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
        updatedAt: timestamp("updated_at", { mode: 'string' }).defaultNow().notNull(),
}, (table) => [
        index("dialpad_departments_contractor_id_idx").using("btree", table.contractorId.asc().nullsLast().op("text_ops")),
        foreignKey({
                        columns: [table.contractorId],
                        foreignColumns: [contractors.id],
                        name: "dialpad_departments_contractor_id_contractors_id_fk"
                }),
        unique("dialpad_departments_contractor_id_dialpad_department_id_unique").on(table.contractorId, table.dialpadDepartmentId),
]);

export const dialpadSyncJobs = pgTable("dialpad_sync_jobs", {
        id: varchar().default(gen_random_uuid()).primaryKey().notNull(),
        contractorId: varchar("contractor_id").notNull(),
        syncType: text("sync_type").notNull(),
        status: dialpadSyncStatus().default('pending').notNull(),
        startedAt: timestamp("started_at", { mode: 'string' }),
        completedAt: timestamp("completed_at", { mode: 'string' }),
        errorMessage: text("error_message"),
        recordsProcessed: integer("records_processed").default(0),
        recordsSuccess: integer("records_success").default(0),
        recordsError: integer("records_error").default(0),
        lastSuccessfulSyncAt: timestamp("last_successful_sync_at", { mode: 'string' }),
        createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
        updatedAt: timestamp("updated_at", { mode: 'string' }).defaultNow().notNull(),
}, (table) => [
        index("dialpad_sync_jobs_contractor_id_idx").using("btree", table.contractorId.asc().nullsLast().op("text_ops")),
        index("dialpad_sync_jobs_contractor_status_idx").using("btree", table.contractorId.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("enum_ops")),
        index("dialpad_sync_jobs_created_at_idx").using("btree", table.createdAt.asc().nullsLast().op("timestamp_ops")),
        index("dialpad_sync_jobs_status_idx").using("btree", table.status.asc().nullsLast().op("enum_ops")),
        foreignKey({
                        columns: [table.contractorId],
                        foreignColumns: [contractors.id],
                        name: "dialpad_sync_jobs_contractor_id_contractors_id_fk"
                }),
]);

export const workflowExecutions = pgTable("workflow_executions", {
        id: varchar().default(gen_random_uuid()).primaryKey().notNull(),
        workflowId: varchar("workflow_id").notNull(),
        contractorId: varchar("contractor_id").notNull(),
        status: workflowExecutionStatus().default('pending').notNull(),
        triggerData: text("trigger_data"),
        executionLog: text("execution_log"),
        errorMessage: text("error_message"),
        currentStep: integer("current_step"),
        startedAt: timestamp("started_at", { mode: 'string' }),
        completedAt: timestamp("completed_at", { mode: 'string' }),
        createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
        resumeAt: timestamp("resume_at", { mode: 'string' }),
}, (table) => [
        index("workflow_executions_contractor_id_idx").using("btree", table.contractorId.asc().nullsLast().op("text_ops")),
        index("workflow_executions_created_at_idx").using("btree", table.createdAt.asc().nullsLast().op("timestamp_ops")),
        index("workflow_executions_status_idx").using("btree", table.status.asc().nullsLast().op("enum_ops")),
        index("workflow_executions_status_resume_idx").using("btree", table.status.asc().nullsLast().op("timestamp_ops"), table.resumeAt.asc().nullsLast().op("enum_ops")),
        index("workflow_executions_workflow_created_at_idx").using("btree", table.workflowId.asc().nullsLast().op("timestamp_ops"), table.createdAt.asc().nullsLast().op("text_ops")),
        index("workflow_executions_workflow_id_idx").using("btree", table.workflowId.asc().nullsLast().op("text_ops")),
        index("workflow_executions_workflow_status_idx").using("btree", table.workflowId.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops")),
        foreignKey({
                        columns: [table.workflowId],
                        foreignColumns: [workflows.id],
                        name: "workflow_executions_workflow_id_workflows_id_fk"
                }).onDelete("cascade"),
        foreignKey({
                        columns: [table.contractorId],
                        foreignColumns: [contractors.id],
                        name: "workflow_executions_contractor_id_contractors_id_fk"
                }).onDelete("cascade"),
]);

export const workflows = pgTable("workflows", {
        id: varchar().default(gen_random_uuid()).primaryKey().notNull(),
        contractorId: varchar("contractor_id").notNull(),
        name: text().notNull(),
        description: text(),
        isActive: boolean("is_active").default(false).notNull(),
        triggerType: workflowTriggerType("trigger_type").notNull(),
        triggerConfig: text("trigger_config").notNull(),
        approvalStatus: workflowApprovalStatus("approval_status").default('pending_approval').notNull(),
        approvedBy: varchar("approved_by"),
        approvedAt: timestamp("approved_at", { mode: 'string' }),
        rejectionReason: text("rejection_reason"),
        createdBy: varchar("created_by").notNull(),
        createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
        updatedAt: timestamp("updated_at", { mode: 'string' }).defaultNow().notNull(),
}, (table) => [
        index("workflows_approval_status_idx").using("btree", table.approvalStatus.asc().nullsLast().op("enum_ops")),
        index("workflows_contractor_active_idx").using("btree", table.contractorId.asc().nullsLast().op("bool_ops"), table.isActive.asc().nullsLast().op("bool_ops")),
        index("workflows_contractor_approval_idx").using("btree", table.contractorId.asc().nullsLast().op("text_ops"), table.approvalStatus.asc().nullsLast().op("enum_ops")),
        index("workflows_contractor_id_idx").using("btree", table.contractorId.asc().nullsLast().op("text_ops")),
        index("workflows_is_active_idx").using("btree", table.isActive.asc().nullsLast().op("bool_ops")),
        index("workflows_trigger_type_idx").using("btree", table.triggerType.asc().nullsLast().op("enum_ops")),
        foreignKey({
                        columns: [table.contractorId],
                        foreignColumns: [contractors.id],
                        name: "workflows_contractor_id_contractors_id_fk"
                }).onDelete("cascade"),
        foreignKey({
                        columns: [table.approvedBy],
                        foreignColumns: [users.id],
                        name: "workflows_approved_by_users_id_fk"
                }),
        foreignKey({
                        columns: [table.createdBy],
                        foreignColumns: [users.id],
                        name: "workflows_created_by_users_id_fk"
                }),
]);

export const workflowSteps = pgTable("workflow_steps", {
        id: varchar().default(gen_random_uuid()).primaryKey().notNull(),
        workflowId: varchar("workflow_id").notNull(),
        stepOrder: integer("step_order").notNull(),
        actionType: workflowActionType("action_type").notNull(),
        actionConfig: text("action_config").notNull(),
        parentStepId: varchar("parent_step_id"),
        createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
        updatedAt: timestamp("updated_at", { mode: 'string' }).defaultNow().notNull(),
}, (table) => [
        index("workflow_steps_parent_step_id_idx").using("btree", table.parentStepId.asc().nullsLast().op("text_ops")),
        index("workflow_steps_workflow_id_idx").using("btree", table.workflowId.asc().nullsLast().op("text_ops")),
        index("workflow_steps_workflow_order_idx").using("btree", table.workflowId.asc().nullsLast().op("text_ops"), table.stepOrder.asc().nullsLast().op("text_ops")),
        foreignKey({
                        columns: [table.workflowId],
                        foreignColumns: [workflows.id],
                        name: "workflow_steps_workflow_id_workflows_id_fk"
                }).onDelete("cascade"),
]);

export const assignmentRules = pgTable("assignment_rules", {
        id: varchar().default(gen_random_uuid()).primaryKey().notNull(),
        contractorId: varchar("contractor_id").notNull(),
        name: text().notNull(),
        conditions: text().default('[]').notNull(),
        assignToUserId: varchar("assign_to_user_id"),
        priority: integer().default(0).notNull(),
        isActive: boolean("is_active").default(true).notNull(),
        createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
        updatedAt: timestamp("updated_at", { mode: 'string' }).defaultNow().notNull(),
}, (table) => [
        index("assignment_rules_contractor_id_idx").using("btree", table.contractorId.asc().nullsLast().op("text_ops")),
        index("assignment_rules_priority_idx").using("btree", table.contractorId.asc().nullsLast().op("int4_ops"), table.priority.asc().nullsLast().op("int4_ops")),
        foreignKey({
                        columns: [table.contractorId],
                        foreignColumns: [contractors.id],
                        name: "assignment_rules_contractor_id_contractors_id_fk"
                }).onDelete("cascade"),
        foreignKey({
                        columns: [table.assignToUserId],
                        foreignColumns: [users.id],
                        name: "assignment_rules_assign_to_user_id_users_id_fk"
                }).onDelete("set null"),
]);

export const spamAuditLog = pgTable("spam_audit_log", {
        id: varchar().default(gen_random_uuid()).primaryKey().notNull(),
        inboxId: varchar("inbox_id").notNull(),
        contractorId: varchar("contractor_id").notNull(),
        senderEmail: text("sender_email").notNull(),
        subject: text().notNull(),
        body: text().notNull(),
        spamConfidence: integer("spam_confidence").notNull(),
        reason: text(),
        flaggedAt: timestamp("flagged_at", { mode: 'string' }).defaultNow().notNull(),
        recoveredAt: timestamp("recovered_at", { mode: 'string' }),
        recoveredLeadId: varchar("recovered_lead_id"),
}, (table) => [
        index("spam_audit_log_contractor_id_idx").using("btree", table.contractorId.asc().nullsLast().op("text_ops")),
        index("spam_audit_log_inbox_id_idx").using("btree", table.inboxId.asc().nullsLast().op("text_ops")),
        foreignKey({
                        columns: [table.inboxId],
                        foreignColumns: [leadCaptureInboxes.id],
                        name: "spam_audit_log_inbox_id_lead_capture_inboxes_id_fk"
                }),
        foreignKey({
                        columns: [table.contractorId],
                        foreignColumns: [contractors.id],
                        name: "spam_audit_log_contractor_id_contractors_id_fk"
                }),
]);

export const leadCaptureInboxes = pgTable("lead_capture_inboxes", {
        id: varchar().default(gen_random_uuid()).primaryKey().notNull(),
        contractorId: varchar("contractor_id").notNull(),
        emailAddress: text("email_address").notNull(),
        gmailRefreshToken: text("gmail_refresh_token").notNull(),
        lastSyncAt: timestamp("last_sync_at", { mode: 'string' }),
        spamFilterEnabled: boolean("spam_filter_enabled").default(false).notNull(),
        isActive: boolean("is_active").default(true).notNull(),
        createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
        updatedAt: timestamp("updated_at", { mode: 'string' }).defaultNow().notNull(),
        senderRules: jsonb("sender_rules").default([]),
        spamConfidenceThreshold: integer("spam_confidence_threshold").default(80).notNull(),
}, (table) => [
        index("lead_capture_inboxes_contractor_id_idx").using("btree", table.contractorId.asc().nullsLast().op("text_ops")),
        foreignKey({
                        columns: [table.contractorId],
                        foreignColumns: [contractors.id],
                        name: "lead_capture_inboxes_contractor_id_contractors_id_fk"
                }),
        unique("lead_capture_inboxes_contractor_id_unique").on(table.contractorId),
]);

export const hcpExcludedCustomers = pgTable("hcp_excluded_customers", {
        id: varchar().default(gen_random_uuid()).primaryKey().notNull(),
        contractorId: varchar("contractor_id").notNull(),
        hcpCustomerId: varchar("hcp_customer_id").notNull(),
        excludedAt: timestamp("excluded_at", { mode: 'string' }).defaultNow().notNull(),
}, (table) => [
        uniqueIndex("hcp_excluded_customers_contractor_customer_idx").using("btree", table.contractorId.asc().nullsLast().op("text_ops"), table.hcpCustomerId.asc().nullsLast().op("text_ops")),
        foreignKey({
                        columns: [table.contractorId],
                        foreignColumns: [contractors.id],
                        name: "hcp_excluded_customers_contractor_id_contractors_id_fk"
                }),
]);
