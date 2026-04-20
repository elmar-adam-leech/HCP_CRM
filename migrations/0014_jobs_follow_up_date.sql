-- Add follow_up_date column to jobs table
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS follow_up_date timestamp;

-- Index for efficient follow-up queries
CREATE INDEX IF NOT EXISTS jobs_follow_up_date_idx ON jobs (contractor_id, follow_up_date)
  WHERE follow_up_date IS NOT NULL;
