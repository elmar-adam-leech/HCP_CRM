-- Task #516: Add a "Lost" status for leads
-- Distinguishes real lost-deal opportunities (e.g. customer signed with a
-- competitor) from genuinely bad-fit leads ("disqualified"). Append-only
-- enum value addition; existing rows are untouched.
-- Also applied at runtime by server/schema-drift.ts so existing
-- production databases pick it up without a separate migration step.
ALTER TYPE "lead_status" ADD VALUE IF NOT EXISTS 'lost';
ALTER TYPE "contact_status" ADD VALUE IF NOT EXISTS 'lost';
