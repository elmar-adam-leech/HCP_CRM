/**
 * Shared Database Schema — Barrel Export
 *
 * Multi-Tenancy Isolation Strategy:
 * ─────────────────────────────────
 * Every business-data table (contacts, leads, jobs, estimates, messages, etc.)
 * includes a `contractorId` column that references `contractors.id`. This is the
 * primary mechanism for data isolation between tenants (companies).
 *
 * Rules for anyone adding new tables or queries:
 *   1. Every table that stores business data MUST have a `contractorId` column
 *      referencing `contractors.id`.
 *   2. Every query against these tables MUST include `eq(table.contractorId, contractorId)`
 *      in its WHERE clause. The storage layer enforces this — never query without it.
 *   3. The `requireAuth` middleware populates `req.user.contractorId` from the JWT.
 *      Route handlers must pass this value to every storage call.
 *   4. The `requireContractorAccess` middleware adds a second check that the token's
 *      contractorId is valid for the tenant being accessed.
 *
 * Failure to follow these rules will result in cross-tenant data leakage.
 *
 * Schema files:
 *   enums.ts         — all pgEnum declarations
 *   settings.ts      — contractors, terminologySettings, businessTargets
 *   users.ts         — users, userContractors, revokedTokens, userInvitations,
 *                      passwordResetTokens, oauthStates, syncSchedules, auditLogs
 *   contacts.ts      — contacts, scheduledBookings + pagination DTOs
 *   estimates.ts     — estimates + pagination DTOs
 *   jobs.ts          — jobs + pagination DTOs
 *   leads.ts         — leads
 *   messages.ts      — messages, webhooks, webhookEvents, templates
 *   activities.ts    — activities
 *   integrations.ts  — credentials, providers, employees, dialpad tables
 *   notifications.ts — notifications
 *   workflows.ts     — workflows, workflowSteps, workflowExecutions
 */

export * from "./enums";
export * from "./settings";
export * from "./users";
export * from "./contacts";
export * from "./estimates";
export * from "./jobs";
export * from "./leads";
export * from "./messages";
export * from "./activities";
export * from "./integrations";
export * from "./notifications";
export * from "./workflows";
export * from "./assignments";
export * from "./sales-process";
