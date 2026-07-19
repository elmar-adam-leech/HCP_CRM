-- Add inbound reply workflow triggers (Lead/Estimate/Job Reply Received via SMS/Email)
-- Extend workflow_trigger_type enum with the new reply_received trigger values.
ALTER TYPE "workflow_trigger_type" ADD VALUE IF NOT EXISTS 'lead_reply_received';
ALTER TYPE "workflow_trigger_type" ADD VALUE IF NOT EXISTS 'estimate_reply_received';
ALTER TYPE "workflow_trigger_type" ADD VALUE IF NOT EXISTS 'job_reply_received';
