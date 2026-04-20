-- Task #437: HCP-driven workflow triggers
-- Extend workflow_trigger_type enum with new HCP-driven trigger values.
-- These are also applied at runtime by server/db.ts so existing
-- production databases pick them up without a separate migration step.
ALTER TYPE "workflow_trigger_type" ADD VALUE IF NOT EXISTS 'estimate_option_approved';
ALTER TYPE "workflow_trigger_type" ADD VALUE IF NOT EXISTS 'estimate_option_rejected';
ALTER TYPE "workflow_trigger_type" ADD VALUE IF NOT EXISTS 'estimate_stale';
ALTER TYPE "workflow_trigger_type" ADD VALUE IF NOT EXISTS 'payment_received';
ALTER TYPE "workflow_trigger_type" ADD VALUE IF NOT EXISTS 'deposit_received';
