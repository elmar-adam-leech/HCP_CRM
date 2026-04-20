import { pgEnum } from "drizzle-orm/pg-core";

export const userRoleEnum = pgEnum("user_role", ["super_admin", "admin", "manager", "user"]);
export const contactTypeEnum = pgEnum("contact_type", ["lead", "customer", "inactive"]);
export const contactStatusEnum = pgEnum("contact_status", ["new", "contacted", "scheduled", "active", "disqualified", "inactive"]);
export const leadStatusEnum = pgEnum("lead_status", ["new", "contacted", "qualified", "converted", "disqualified"]);
export const jobStatusEnum = pgEnum("job_status", ["scheduled", "in_progress", "completed", "cancelled"]);
export const jobPriorityEnum = pgEnum("job_priority", ["low", "medium", "high"]);
export const estimateStatusEnum = pgEnum("estimate_status", ["sent", "scheduled", "in_progress", "approved", "rejected"]);
export const messageTypeEnum = pgEnum("message_type", ["text", "email"]);
export const messageStatusEnum = pgEnum("message_status", ["sent", "delivered", "failed"]);
export const messageDirectionEnum = pgEnum("message_direction", ["inbound", "outbound"]);
export const templateTypeEnum = pgEnum("template_type", ["text", "email"]);
export const templateStatusEnum = pgEnum("template_status", ["draft", "pending_approval", "approved", "rejected"]);
export const providerTypeEnum = pgEnum("provider_type", ["email", "sms", "calling"]);
export const emailProviderEnum = pgEnum("email_provider", ["gmail", "sendgrid", "outlook", "mailgun"]);
export const smsProviderEnum = pgEnum("sms_provider", ["dialpad", "twilio", "messagebird", "nexmo"]);
export const callingProviderEnum = pgEnum("calling_provider", ["dialpad", "twilio", "ringcentral", "zoom"]);
export const activityTypeEnum = pgEnum("activity_type", ["note", "call", "email", "sms", "meeting", "follow_up", "status_change"]);
export const dialpadSyncStatusEnum = pgEnum("dialpad_sync_status", ["pending", "in_progress", "completed", "failed"]);
export const notificationTypeEnum = pgEnum("notification_type", ["lead_assigned", "estimate_approved", "estimate_rejected", "job_completed", "new_message", "follow_up_due", "system"]);
export const workflowTriggerTypeEnum = pgEnum("workflow_trigger_type", ["entity_created", "entity_updated", "status_changed", "field_changed", "time_based", "manual", "estimate_option_approved", "estimate_option_rejected", "estimate_stale", "payment_received", "deposit_received"]);
export const workflowActionTypeEnum = pgEnum("workflow_action_type", ["send_email", "send_sms", "create_notification", "update_entity", "assign_user", "set_follow_up", "conditional_branch", "delay", "wait_until"]);
export const workflowExecutionStatusEnum = pgEnum("workflow_execution_status", ["pending", "running", "completed", "failed", "cancelled", "suspended"]);
export const workflowApprovalStatusEnum = pgEnum("workflow_approval_status", ["approved", "pending_approval", "rejected"]);
export const syncFrequencyEnum = pgEnum("sync_frequency", ["daily", "weekly", "hourly", "every-5-minutes"]);
// Canonical lowercase values for webhook service names — prevents string drift (e.g. 'Dialpad' vs 'dialpad').
export const webhookServiceEnum = pgEnum("webhook_service", ["dialpad", "housecall-pro", "facebook", "twilio"]);
// Canonical event type values for the webhooks table webhookType column.
export const webhookEventTypeEnum = pgEnum("webhook_event_type", ["sms", "call", "estimate", "lead", "job", "customer", "payment"]);
