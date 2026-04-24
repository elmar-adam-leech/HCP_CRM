import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, bigint, timestamp, boolean, unique, index, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { userRoleEnum, syncFrequencyEnum } from "./enums";
import { contractors } from "./settings";

// Users table
export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
  name: text("name").notNull(),
  email: text("email").notNull(), // Removed unique constraint to allow same email across companies
  // Legacy field — role is now the source of truth in user_contractors.role (per-contractor).
  // Kept here because AuthService.generateToken snapshots it into the JWT payload on login,
  // and many route guards read req.user.role from that snapshot. Do NOT drop this column
  // until the auth system is fully migrated to read role from user_contractors at token
  // issue time and all JWT snapshots in the wild have expired.
  role: userRoleEnum("role").notNull().default("user"),
  tokenVersion: integer("token_version").notNull().default(1), // Incremented on logout-all; invalidates all prior tokens
  contractorId: varchar("contractor_id").references(() => contractors.id), // Current/active contractor for this session
  // Legacy field — dialpad number is now per-contractor in user_contractors.dialpadDefaultNumber.
  // Kept for the same JWT-snapshot reason as `role` above.
  dialpadDefaultNumber: text("dialpad_default_number"),
  gmailConnected: boolean("gmail_connected").default(false).notNull(), // Whether user has connected their Gmail account
  gmailRefreshToken: text("gmail_refresh_token"), // Encrypted Gmail OAuth refresh token for this user
  gmailEmail: text("gmail_email"), // The Gmail address this user connected
  gmailLastSyncAt: timestamp("gmail_last_sync_at"), // Last time we synced emails from Gmail
  gmailSyncHistoryId: text("gmail_sync_history_id"), // Gmail API history ID for incremental sync
  // Legacy field — permission is now per-contractor in user_contractors.canManageIntegrations.
  // Kept for the same JWT-snapshot reason as `role` above.
  canManageIntegrations: boolean("can_manage_integrations").default(false).notNull(),
  mfaEnabled: boolean("mfa_enabled").default(false).notNull(),
  mfaSecretEncrypted: jsonb("mfa_secret_encrypted").$type<{ encrypted: string; iv: string; authTag: string } | null>(),
  mfaRecoveryCodes: jsonb("mfa_recovery_codes").$type<string[]>().default(sql`'[]'::jsonb`).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  emailIdx: index("users_email_idx").on(table.email),
  // Functional index for case-insensitive email lookups used by getUserByEmail().
  // Without this, lower(email) calls bypass the standard B-tree emailIdx above,
  // causing full table scans on every login and invitation lookup.
  emailLowerIdx: index("users_email_lower_idx").on(sql`lower(${table.email})`),
  // Index for session-based tenant resolution (users.contractorId tracks the active session tenant)
  contractorIdIdx: index("users_contractor_id_idx").on(table.contractorId),
}));

const mfaSecretEncryptedSchema = z.object({
  encrypted: z.string(),
  iv: z.string(),
  authTag: z.string(),
}).nullable().optional();

export const insertUserSchema = createInsertSchema(users).omit({
  id: true,
  createdAt: true,
}).extend({
  mfaSecretEncrypted: mfaSecretEncryptedSchema,
});
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

// User-Contractor junction table (many-to-many relationship)
// Allows users to belong to multiple contractors with different roles per contractor
export const userContractors = pgTable("user_contractors", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  contractorId: varchar("contractor_id").notNull().references(() => contractors.id, { onDelete: "cascade" }),
  role: userRoleEnum("role").notNull().default("user"), // Role specific to this contractor
  dialpadDefaultNumber: text("dialpad_default_number"), // Per-contractor default Dialpad number
  callPreference: text("call_preference").default("integration"), // 'integration' | 'personal'
  canManageIntegrations: boolean("can_manage_integrations").default(false).notNull(),
  allowedIntegrations: text("allowed_integrations").array(), // null = access to all integrations (when canManageIntegrations=true)
  // Salesperson scheduling fields
  isSalesperson: boolean("is_salesperson").default(false).notNull(), // Whether this user is a salesperson for scheduling
  housecallProUserId: text("housecall_pro_user_id"), // HCP user ID for calendar sync
  lastAssignmentAt: timestamp("last_assignment_at"), // Last time this salesperson was assigned a booking
  calendarColor: text("calendar_color"), // Color for display in combined calendar view
  // Working hours settings (synced from HCP or customized)
  workingDays: integer("working_days").array().default(sql`'{1,2,3,4,5}'`), // Days of week (0=Sun, 1=Mon, ..., 6=Sat)
  workingHoursStart: text("working_hours_start").default("09:00"), // Start time HH:MM format
  workingHoursEnd: text("working_hours_end").default("17:00"), // End time HH:MM format
  hasCustomSchedule: boolean("has_custom_schedule").default(false).notNull(), // If true, HCP sync won't overwrite
  displayOrder: integer("display_order"), // Custom sort order for salespeople list (lower = higher)
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  // Ensure a user can only be linked to a contractor once
  userContractorUnique: unique().on(table.userId, table.contractorId),
  // Indexes for common queries
  userIdIdx: index("user_contractors_user_id_idx").on(table.userId),
  contractorIdIdx: index("user_contractors_contractor_id_idx").on(table.contractorId),
  salespersonIdx: index("user_contractors_salesperson_idx").on(table.contractorId, table.isSalesperson),
}));

export const insertUserContractorSchema = createInsertSchema(userContractors).omit({ id: true, createdAt: true });
export type InsertUserContractor = z.infer<typeof insertUserContractorSchema>;
export type UserContractor = typeof userContractors.$inferSelect;

// Revoked tokens table — used by the logout handler to invalidate individual JWTs before
// their natural expiry. The requireAuth middleware queries this table on every request.
// Rows are cleaned up hourly by a setInterval in server/index.ts once they expire.
//
// Scaling concern: a SELECT on this table fires for every authenticated API request. At
// low-to-medium traffic the small table size (bounded by token TTL + hourly cleanup) keeps
// this fast, but at high request rates (>10x current load) this becomes a hot spot. The
// standard fix is to store revoked JTIs in a Redis SET and replace the DB query with a
// single O(1) SISMEMBER call. See the auth-service.ts middleware for the exact call site.
// TODO: At scale, move revoked token lookups to Redis (O(1) SET membership).
export const revokedTokens = pgTable("revoked_tokens", {
  jti: varchar("jti").primaryKey(), // JWT ID claim — uniquely identifies the token
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at").notNull(), // Natural expiry of the JWT — row can be deleted after this
  revokedAt: timestamp("revoked_at").defaultNow().notNull(),
}, (table) => ({
  expiresAtIdx: index("revoked_tokens_expires_at_idx").on(table.expiresAt),
  userIdIdx: index("revoked_tokens_user_id_idx").on(table.userId),
}));

export const insertRevokedTokenSchema = createInsertSchema(revokedTokens);
export type InsertRevokedToken = z.infer<typeof insertRevokedTokenSchema>;
export type RevokedToken = typeof revokedTokens.$inferSelect;

// Refresh tokens — long-lived (90 day) opaque tokens used by the PWA to silently
// re-mint a fresh `auth_token` JWT cookie when the short-lived auth cookie has
// been evicted by iOS Safari (PWA storage partition is aggressively dropped by
// Apple's intelligent tracking prevention plus iOS memory-pressure eviction).
//
// Lookup is by SHA-256 hash of the raw token; the raw token only ever lives in
// the user's `refresh_token` httpOnly cookie. Tokens rotate on each successful
// /api/auth/refresh call — the previous row is marked `lastUsedAt` and the new
// hash replaces it.
export const refreshTokens = pgTable("refresh_tokens", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  contractorId: varchar("contractor_id").notNull().references(() => contractors.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  deviceId: text("device_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  lastUsedAt: timestamp("last_used_at"),
  // Set when this token has been used to mint a successor (rotated). Distinct
  // from `revokedAt` so /api/auth/refresh can permit a brief grace window where
  // an in-flight retry / network re-send of the same token still succeeds. See
  // REFRESH_ROTATION_GRACE_MS in server/auth-refresh.ts.
  rotatedAt: timestamp("rotated_at"),
  // Hard kill — set on logout, sign-out-all, and on detection of stale-token
  // replay (use after the rotation grace window has expired).
  revokedAt: timestamp("revoked_at"),
  ip: text("ip"),
  userAgent: text("user_agent"),
}, (table) => ({
  tokenHashIdx: index("refresh_tokens_token_hash_idx").on(table.tokenHash),
  userIdIdx: index("refresh_tokens_user_id_idx").on(table.userId),
  expiresAtIdx: index("refresh_tokens_expires_at_idx").on(table.expiresAt),
}));

export const insertRefreshTokenSchema = createInsertSchema(refreshTokens).omit({
  id: true,
  createdAt: true,
});
export type InsertRefreshToken = z.infer<typeof insertRefreshTokenSchema>;
export type RefreshToken = typeof refreshTokens.$inferSelect;

// User invitations table
export const userInvitations = pgTable("user_invitations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  email: text("email").notNull(),
  role: userRoleEnum("role").notNull().default("user"),
  inviteCode: text("invite_code").notNull().unique(),
  contractorId: varchar("contractor_id").notNull().references(() => contractors.id),
  invitedBy: varchar("invited_by").notNull().references(() => users.id),
  acceptedAt: timestamp("accepted_at"),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  contractorIdIdx: index("user_invitations_contractor_id_idx").on(table.contractorId),
  // Index for "show all invitations sent by this user" queries
  invitedByIdx: index("user_invitations_invited_by_idx").on(table.invitedBy),
}));

export const insertUserInvitationSchema = createInsertSchema(userInvitations).omit({
  id: true,
  createdAt: true,
});
export type InsertUserInvitation = z.infer<typeof insertUserInvitationSchema>;
export type UserInvitation = typeof userInvitations.$inferSelect;

// Password reset tokens table
export const passwordResetTokens = pgTable("password_reset_tokens", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  usedAt: timestamp("used_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  // Index for "find all reset tokens for user" queries (e.g. invalidating old tokens)
  userIdIdx: index("password_reset_tokens_user_id_idx").on(table.userId),
}));

export const insertPasswordResetTokenSchema = createInsertSchema(passwordResetTokens).omit({
  id: true,
  createdAt: true,
});
export type InsertPasswordResetToken = z.infer<typeof insertPasswordResetTokenSchema>;
export type PasswordResetToken = typeof passwordResetTokens.$inferSelect;

// OAuth states table for persisting OAuth state tokens (CSRF protection)
// Used for Gmail OAuth flow to survive server restarts and support multi-instance deployments
export const oauthStates = pgTable("oauth_states", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  state: text("state").notNull().unique(), // The random state token
  userId: varchar("user_id").notNull(), // User initiating the OAuth flow
  redirectHost: text("redirect_host").notNull(), // Domain for OAuth callback
  expiresAt: timestamp("expires_at").notNull(), // State expiration time (10 minutes from creation)
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  stateIdx: index("oauth_states_state_idx").on(table.state),
  expiresAtIdx: index("oauth_states_expires_at_idx").on(table.expiresAt),
}));

export const insertOAuthStateSchema = createInsertSchema(oauthStates).omit({
  id: true,
  createdAt: true,
});
export type InsertOAuthState = z.infer<typeof insertOAuthStateSchema>;
export type OAuthState = typeof oauthStates.$inferSelect;

// Sync schedules table for background job scheduling
export const syncSchedules = pgTable("sync_schedules", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  contractorId: varchar("contractor_id").notNull().references(() => contractors.id),
  integrationName: varchar("integration_name").notNull(), // e.g., 'gmail', 'housecall-pro'
  frequency: syncFrequencyEnum("frequency").notNull().default("daily"),
  lastSyncAt: timestamp("last_sync_at"),
  nextSyncAt: timestamp("next_sync_at").notNull(),
  isEnabled: boolean("is_enabled").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => ({
  // Ensure only one schedule per contractor per integration
  contractorIntegrationUnique: unique("sync_schedules_contractor_integration_unique").on(table.contractorId, table.integrationName),
  // Index for finding schedules that need to run
  nextSyncAtIdx: index("sync_schedules_next_sync_at_idx").on(table.nextSyncAt, table.isEnabled),
}));

export const insertSyncScheduleSchema = createInsertSchema(syncSchedules).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertSyncSchedule = z.infer<typeof insertSyncScheduleSchema>;
export type SyncSchedule = typeof syncSchedules.$inferSelect;

// Audit log table — SOC 2 evidence store for user actions
export const auditLogs = pgTable("audit_logs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  contractorId: varchar("contractor_id").references(() => contractors.id, { onDelete: "cascade" }),
  userId: varchar("user_id").references(() => users.id, { onDelete: "set null" }),
  action: text("action").notNull(),
  entityType: text("entity_type"),
  entityId: text("entity_id"),
  before: jsonb("before"),
  after: jsonb("after"),
  reason: text("reason"),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  contractorCreatedAtIdx: index("audit_logs_contractor_created_at_idx").on(table.contractorId, table.createdAt),
  userIdIdx: index("audit_logs_user_id_idx").on(table.userId),
  entityIdIdx: index("audit_logs_entity_id_idx").on(table.entityId),
}));

export const insertAuditLogSchema = createInsertSchema(auditLogs).omit({ id: true, createdAt: true });
export type InsertAuditLog = z.infer<typeof insertAuditLogSchema>;
export type AuditLog = typeof auditLogs.$inferSelect;


// WebAuthn credentials table — stores registered passkeys (platform authenticators)
// per user. The credentialId is the unique handle returned by the authenticator;
// publicKey is base64url-encoded COSE public key bytes; counter tracks signature
// counter to detect cloned credentials.
export const webauthnCredentials = pgTable("webauthn_credentials", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  credentialId: text("credential_id").notNull().unique(),
  publicKey: text("public_key").notNull(),
  counter: bigint("counter", { mode: "number" }).notNull().default(0),
  transports: text("transports").array(),
  deviceLabel: text("device_label").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  lastUsedAt: timestamp("last_used_at"),
}, (table) => ({
  userIdIdx: index("webauthn_credentials_user_id_idx").on(table.userId),
}));

export const insertWebauthnCredentialSchema = createInsertSchema(webauthnCredentials).omit({
  id: true,
  createdAt: true,
});
export type InsertWebauthnCredential = z.infer<typeof insertWebauthnCredentialSchema>;
export type WebauthnCredential = typeof webauthnCredentials.$inferSelect;

// Short-lived WebAuthn challenges. Used by both registration (auth required, scoped
// to userId) and authentication (no auth, scoped to a random sessionId returned to
// the browser). Rows are deleted on consumption and TTL-cleaned periodically.
export const webauthnChallenges = pgTable("webauthn_challenges", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id, { onDelete: "cascade" }),
  sessionId: text("session_id").unique(),
  challenge: text("challenge").notNull(),
  purpose: text("purpose").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  expiresAtIdx: index("webauthn_challenges_expires_at_idx").on(table.expiresAt),
  userIdIdx: index("webauthn_challenges_user_id_idx").on(table.userId),
}));

export const insertWebauthnChallengeSchema = createInsertSchema(webauthnChallenges).omit({
  id: true,
  createdAt: true,
});
export type InsertWebauthnChallenge = z.infer<typeof insertWebauthnChallengeSchema>;
export type WebauthnChallenge = typeof webauthnChallenges.$inferSelect;
