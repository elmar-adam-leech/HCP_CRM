import { relations } from "drizzle-orm/relations";
import { users, userContractors, contractors, businessTargets, revokedTokens, userInvitations, passwordResetTokens, syncSchedules, terminologySettings, contacts, scheduledBookings, jobs, estimates, leads, messages, webhooks, webhookEvents, templates, activities, notifications, contractorCredentials, contractorProviders, dialpadUsers, contractorIntegrations, employees, dialpadPhoneNumbers, userPhoneNumberPermissions, dialpadDepartments, dialpadSyncJobs, workflows, workflowExecutions, workflowSteps, assignmentRules, leadCaptureInboxes, spamAuditLog, hcpExcludedCustomers } from "./schema";

export const userContractorsRelations = relations(userContractors, ({one}) => ({
        user: one(users, {
                fields: [userContractors.userId],
                references: [users.id]
        }),
        contractor: one(contractors, {
                fields: [userContractors.contractorId],
                references: [contractors.id]
        }),
}));

export const usersRelations = relations(users, ({one, many}) => ({
        userContractors: many(userContractors),
        contractor: one(contractors, {
                fields: [users.contractorId],
                references: [contractors.id]
        }),
        revokedTokens: many(revokedTokens),
        userInvitations: many(userInvitations),
        passwordResetTokens: many(passwordResetTokens),
        contacts_contactedByUserId: many(contacts, {
                relationName: "contacts_contactedByUserId_users_id"
        }),
        contacts_scheduledByUserId: many(contacts, {
                relationName: "contacts_scheduledByUserId_users_id"
        }),
        scheduledBookings: many(scheduledBookings),
        leads: many(leads),
        messages: many(messages),
        templates_createdBy: many(templates, {
                relationName: "templates_createdBy_users_id"
        }),
        templates_approvedBy: many(templates, {
                relationName: "templates_approvedBy_users_id"
        }),
        activities: many(activities),
        notifications: many(notifications),
        contractorIntegrations: many(contractorIntegrations),
        userPhoneNumberPermissions_userId: many(userPhoneNumberPermissions, {
                relationName: "userPhoneNumberPermissions_userId_users_id"
        }),
        userPhoneNumberPermissions_assignedBy: many(userPhoneNumberPermissions, {
                relationName: "userPhoneNumberPermissions_assignedBy_users_id"
        }),
        workflows_approvedBy: many(workflows, {
                relationName: "workflows_approvedBy_users_id"
        }),
        workflows_createdBy: many(workflows, {
                relationName: "workflows_createdBy_users_id"
        }),
        assignmentRules: many(assignmentRules),
}));

export const contractorsRelations = relations(contractors, ({many}) => ({
        userContractors: many(userContractors),
        businessTargets: many(businessTargets),
        users: many(users),
        userInvitations: many(userInvitations),
        syncSchedules: many(syncSchedules),
        terminologySettings: many(terminologySettings),
        contacts: many(contacts),
        scheduledBookings: many(scheduledBookings),
        jobs: many(jobs),
        estimates: many(estimates),
        leads: many(leads),
        messages: many(messages),
        webhooks: many(webhooks),
        webhookEvents: many(webhookEvents),
        templates: many(templates),
        activities: many(activities),
        notifications: many(notifications),
        contractorCredentials: many(contractorCredentials),
        contractorProviders: many(contractorProviders),
        dialpadUsers: many(dialpadUsers),
        contractorIntegrations: many(contractorIntegrations),
        employees: many(employees),
        dialpadPhoneNumbers: many(dialpadPhoneNumbers),
        userPhoneNumberPermissions: many(userPhoneNumberPermissions),
        dialpadDepartments: many(dialpadDepartments),
        dialpadSyncJobs: many(dialpadSyncJobs),
        workflowExecutions: many(workflowExecutions),
        workflows: many(workflows),
        assignmentRules: many(assignmentRules),
        spamAuditLogs: many(spamAuditLog),
        leadCaptureInboxes: many(leadCaptureInboxes),
        hcpExcludedCustomers: many(hcpExcludedCustomers),
}));

export const businessTargetsRelations = relations(businessTargets, ({one}) => ({
        contractor: one(contractors, {
                fields: [businessTargets.contractorId],
                references: [contractors.id]
        }),
}));

export const revokedTokensRelations = relations(revokedTokens, ({one}) => ({
        user: one(users, {
                fields: [revokedTokens.userId],
                references: [users.id]
        }),
}));

export const userInvitationsRelations = relations(userInvitations, ({one}) => ({
        contractor: one(contractors, {
                fields: [userInvitations.contractorId],
                references: [contractors.id]
        }),
        user: one(users, {
                fields: [userInvitations.invitedBy],
                references: [users.id]
        }),
}));

export const passwordResetTokensRelations = relations(passwordResetTokens, ({one}) => ({
        user: one(users, {
                fields: [passwordResetTokens.userId],
                references: [users.id]
        }),
}));

export const syncSchedulesRelations = relations(syncSchedules, ({one}) => ({
        contractor: one(contractors, {
                fields: [syncSchedules.contractorId],
                references: [contractors.id]
        }),
}));

export const terminologySettingsRelations = relations(terminologySettings, ({one}) => ({
        contractor: one(contractors, {
                fields: [terminologySettings.contractorId],
                references: [contractors.id]
        }),
}));

export const contactsRelations = relations(contacts, ({one, many}) => ({
        user_contactedByUserId: one(users, {
                fields: [contacts.contactedByUserId],
                references: [users.id],
                relationName: "contacts_contactedByUserId_users_id"
        }),
        user_scheduledByUserId: one(users, {
                fields: [contacts.scheduledByUserId],
                references: [users.id],
                relationName: "contacts_scheduledByUserId_users_id"
        }),
        contractor: one(contractors, {
                fields: [contacts.contractorId],
                references: [contractors.id]
        }),
        scheduledBookings: many(scheduledBookings),
        jobs: many(jobs),
        estimates: many(estimates),
        leads: many(leads),
        messages: many(messages),
        activities: many(activities),
}));

export const scheduledBookingsRelations = relations(scheduledBookings, ({one}) => ({
        contractor: one(contractors, {
                fields: [scheduledBookings.contractorId],
                references: [contractors.id]
        }),
        user: one(users, {
                fields: [scheduledBookings.assignedSalespersonId],
                references: [users.id]
        }),
        contact: one(contacts, {
                fields: [scheduledBookings.contactId],
                references: [contacts.id]
        }),
}));

export const jobsRelations = relations(jobs, ({one, many}) => ({
        contact: one(contacts, {
                fields: [jobs.contactId],
                references: [contacts.id]
        }),
        estimate: one(estimates, {
                fields: [jobs.estimateId],
                references: [estimates.id]
        }),
        contractor: one(contractors, {
                fields: [jobs.contractorId],
                references: [contractors.id]
        }),
        leads: many(leads),
        activities: many(activities),
}));

export const estimatesRelations = relations(estimates, ({one, many}) => ({
        jobs: many(jobs),
        contact: one(contacts, {
                fields: [estimates.contactId],
                references: [contacts.id]
        }),
        contractor: one(contractors, {
                fields: [estimates.contractorId],
                references: [contractors.id]
        }),
        leads: many(leads),
        messages: many(messages),
        activities: many(activities),
}));

export const leadsRelations = relations(leads, ({one}) => ({
        contact: one(contacts, {
                fields: [leads.contactId],
                references: [contacts.id]
        }),
        estimate: one(estimates, {
                fields: [leads.convertedToEstimateId],
                references: [estimates.id]
        }),
        job: one(jobs, {
                fields: [leads.convertedToJobId],
                references: [jobs.id]
        }),
        user: one(users, {
                fields: [leads.assignedToUserId],
                references: [users.id]
        }),
        contractor: one(contractors, {
                fields: [leads.contractorId],
                references: [contractors.id]
        }),
}));

export const messagesRelations = relations(messages, ({one}) => ({
        contact: one(contacts, {
                fields: [messages.contactId],
                references: [contacts.id]
        }),
        estimate: one(estimates, {
                fields: [messages.estimateId],
                references: [estimates.id]
        }),
        user: one(users, {
                fields: [messages.userId],
                references: [users.id]
        }),
        contractor: one(contractors, {
                fields: [messages.contractorId],
                references: [contractors.id]
        }),
}));

export const webhooksRelations = relations(webhooks, ({one, many}) => ({
        contractor: one(contractors, {
                fields: [webhooks.contractorId],
                references: [contractors.id]
        }),
        webhookEvents: many(webhookEvents),
}));

export const webhookEventsRelations = relations(webhookEvents, ({one}) => ({
        webhook: one(webhooks, {
                fields: [webhookEvents.webhookId],
                references: [webhooks.id]
        }),
        contractor: one(contractors, {
                fields: [webhookEvents.contractorId],
                references: [contractors.id]
        }),
}));

export const templatesRelations = relations(templates, ({one}) => ({
        user_createdBy: one(users, {
                fields: [templates.createdBy],
                references: [users.id],
                relationName: "templates_createdBy_users_id"
        }),
        user_approvedBy: one(users, {
                fields: [templates.approvedBy],
                references: [users.id],
                relationName: "templates_approvedBy_users_id"
        }),
        contractor: one(contractors, {
                fields: [templates.contractorId],
                references: [contractors.id]
        }),
}));

export const activitiesRelations = relations(activities, ({one}) => ({
        contact: one(contacts, {
                fields: [activities.contactId],
                references: [contacts.id]
        }),
        estimate: one(estimates, {
                fields: [activities.estimateId],
                references: [estimates.id]
        }),
        job: one(jobs, {
                fields: [activities.jobId],
                references: [jobs.id]
        }),
        user: one(users, {
                fields: [activities.userId],
                references: [users.id]
        }),
        contractor: one(contractors, {
                fields: [activities.contractorId],
                references: [contractors.id]
        }),
}));

export const notificationsRelations = relations(notifications, ({one}) => ({
        user: one(users, {
                fields: [notifications.userId],
                references: [users.id]
        }),
        contractor: one(contractors, {
                fields: [notifications.contractorId],
                references: [contractors.id]
        }),
}));

export const contractorCredentialsRelations = relations(contractorCredentials, ({one}) => ({
        contractor: one(contractors, {
                fields: [contractorCredentials.contractorId],
                references: [contractors.id]
        }),
}));

export const contractorProvidersRelations = relations(contractorProviders, ({one}) => ({
        contractor: one(contractors, {
                fields: [contractorProviders.contractorId],
                references: [contractors.id]
        }),
}));

export const dialpadUsersRelations = relations(dialpadUsers, ({one}) => ({
        contractor: one(contractors, {
                fields: [dialpadUsers.contractorId],
                references: [contractors.id]
        }),
}));

export const contractorIntegrationsRelations = relations(contractorIntegrations, ({one}) => ({
        contractor: one(contractors, {
                fields: [contractorIntegrations.contractorId],
                references: [contractors.id]
        }),
        user: one(users, {
                fields: [contractorIntegrations.enabledBy],
                references: [users.id]
        }),
}));

export const employeesRelations = relations(employees, ({one}) => ({
        contractor: one(contractors, {
                fields: [employees.contractorId],
                references: [contractors.id]
        }),
}));

export const dialpadPhoneNumbersRelations = relations(dialpadPhoneNumbers, ({one, many}) => ({
        contractor: one(contractors, {
                fields: [dialpadPhoneNumbers.contractorId],
                references: [contractors.id]
        }),
        userPhoneNumberPermissions: many(userPhoneNumberPermissions),
}));

export const userPhoneNumberPermissionsRelations = relations(userPhoneNumberPermissions, ({one}) => ({
        dialpadPhoneNumber: one(dialpadPhoneNumbers, {
                fields: [userPhoneNumberPermissions.phoneNumberId],
                references: [dialpadPhoneNumbers.id]
        }),
        user_userId: one(users, {
                fields: [userPhoneNumberPermissions.userId],
                references: [users.id],
                relationName: "userPhoneNumberPermissions_userId_users_id"
        }),
        contractor: one(contractors, {
                fields: [userPhoneNumberPermissions.contractorId],
                references: [contractors.id]
        }),
        user_assignedBy: one(users, {
                fields: [userPhoneNumberPermissions.assignedBy],
                references: [users.id],
                relationName: "userPhoneNumberPermissions_assignedBy_users_id"
        }),
}));

export const dialpadDepartmentsRelations = relations(dialpadDepartments, ({one}) => ({
        contractor: one(contractors, {
                fields: [dialpadDepartments.contractorId],
                references: [contractors.id]
        }),
}));

export const dialpadSyncJobsRelations = relations(dialpadSyncJobs, ({one}) => ({
        contractor: one(contractors, {
                fields: [dialpadSyncJobs.contractorId],
                references: [contractors.id]
        }),
}));

export const workflowExecutionsRelations = relations(workflowExecutions, ({one}) => ({
        workflow: one(workflows, {
                fields: [workflowExecutions.workflowId],
                references: [workflows.id]
        }),
        contractor: one(contractors, {
                fields: [workflowExecutions.contractorId],
                references: [contractors.id]
        }),
}));

export const workflowsRelations = relations(workflows, ({one, many}) => ({
        workflowExecutions: many(workflowExecutions),
        contractor: one(contractors, {
                fields: [workflows.contractorId],
                references: [contractors.id]
        }),
        user_approvedBy: one(users, {
                fields: [workflows.approvedBy],
                references: [users.id],
                relationName: "workflows_approvedBy_users_id"
        }),
        user_createdBy: one(users, {
                fields: [workflows.createdBy],
                references: [users.id],
                relationName: "workflows_createdBy_users_id"
        }),
        workflowSteps: many(workflowSteps),
}));

export const workflowStepsRelations = relations(workflowSteps, ({one}) => ({
        workflow: one(workflows, {
                fields: [workflowSteps.workflowId],
                references: [workflows.id]
        }),
}));

export const assignmentRulesRelations = relations(assignmentRules, ({one}) => ({
        contractor: one(contractors, {
                fields: [assignmentRules.contractorId],
                references: [contractors.id]
        }),
        user: one(users, {
                fields: [assignmentRules.assignToUserId],
                references: [users.id]
        }),
}));

export const spamAuditLogRelations = relations(spamAuditLog, ({one}) => ({
        leadCaptureInbox: one(leadCaptureInboxes, {
                fields: [spamAuditLog.inboxId],
                references: [leadCaptureInboxes.id]
        }),
        contractor: one(contractors, {
                fields: [spamAuditLog.contractorId],
                references: [contractors.id]
        }),
}));

export const leadCaptureInboxesRelations = relations(leadCaptureInboxes, ({one, many}) => ({
        spamAuditLogs: many(spamAuditLog),
        contractor: one(contractors, {
                fields: [leadCaptureInboxes.contractorId],
                references: [contractors.id]
        }),
}));

export const hcpExcludedCustomersRelations = relations(hcpExcludedCustomers, ({one}) => ({
        contractor: one(contractors, {
                fields: [hcpExcludedCustomers.contractorId],
                references: [contractors.id]
        }),
}));