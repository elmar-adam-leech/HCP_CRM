/**
 * Auto-dispute rules for Google Local Services leads.
 *
 * Stored per-tenant as a JSON blob under credential
 * `google-local-services` / `auto_dispute_rules`. The poller evaluates these
 * rules against each newly-ingested GLS lead and, when a rule matches, files
 * a dispute against Google immediately — no human click required.
 *
 * Why a small fixed set of condition types (vs. a generic predicate):
 *   The CRM only exposes a handful of GLS lead fields that are reliably
 *   present (zip / jobType / message / leadType). A constrained schema means
 *   the UI can render a simple dropdown, validation is straightforward, and
 *   we never risk auto-disputing on a typo'd JSON expression.
 */
import { z } from 'zod';

export const GLS_AUTO_DISPUTE_CONDITION_TYPES = [
  'zip_in',           // dispute if the lead's ZIP is in `values`
  'zip_not_in',       // dispute if the lead's ZIP is NOT in `values` (i.e. service-area allowlist)
  'job_type_in',      // dispute if the lead's job type is in `values`
  'message_contains', // dispute if the message contains any of `values` (case-insensitive)
  'lead_type_in',     // dispute if leadType (MESSAGE / PHONE_CALL / BOOKING) is in `values`
] as const;
export type GlsAutoDisputeConditionType = typeof GLS_AUTO_DISPUTE_CONDITION_TYPES[number];

export const GLS_AUTO_DISPUTE_REASONS = [
  'SPAM',
  'WRONG_GEO',
  'WRONG_JOB_TYPE',
  'WRONG_BUSINESS',
  'DUPLICATE',
  'NO_CONTACT_INFO',
  'OTHER',
] as const;
export type GlsAutoDisputeReason = typeof GLS_AUTO_DISPUTE_REASONS[number];

export const glsAutoDisputeRuleSchema = z.object({
  id: z.string().min(1),
  enabled: z.boolean(),
  conditionType: z.enum(GLS_AUTO_DISPUTE_CONDITION_TYPES),
  // For ZIP / jobType / leadType / message_contains we store a list of
  // strings. Empty list is invalid (would match nothing or everything).
  values: z.array(z.string().min(1)).min(1).max(200),
  reason: z.enum(GLS_AUTO_DISPUTE_REASONS),
  notes: z.string().max(2000).optional(),
}).superRefine((rule, ctx) => {
  // Google requires a free-text note when the dispute reason is OTHER.
  if (rule.reason === 'OTHER' && !rule.notes?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['notes'],
      message: 'Notes are required when the dispute reason is "Other".',
    });
  }
});

export type GlsAutoDisputeRule = z.infer<typeof glsAutoDisputeRuleSchema>;

export const glsAutoDisputeRulesSchema = z.array(glsAutoDisputeRuleSchema).max(50);
