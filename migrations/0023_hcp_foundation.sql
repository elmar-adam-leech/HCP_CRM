-- Task #435: Capture HCP foundation data
-- Adds: per-line line_items snapshots, salesperson attribution, job payment
-- details, and the employees<->user_contractors link used to resolve
-- salesperson IDs from HCP scheduled/assigned employee IDs.
--
-- All statements use IF NOT EXISTS so the file is safe to re-run and is
-- mirrored by startup migrations in server/db.ts (see Task #432 lesson).

ALTER TABLE estimates ADD COLUMN IF NOT EXISTS line_items jsonb;
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS salesperson_user_id varchar;
CREATE INDEX IF NOT EXISTS estimates_salesperson_user_id_idx
  ON estimates(contractor_id, salesperson_user_id)
  WHERE salesperson_user_id IS NOT NULL;

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS line_items jsonb;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS salesperson_user_id varchar;
CREATE INDEX IF NOT EXISTS jobs_salesperson_user_id_idx
  ON jobs(contractor_id, salesperson_user_id)
  WHERE salesperson_user_id IS NOT NULL;

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS paid_amount numeric(10, 2);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS payment_method text;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS paid_at timestamp;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS is_deposit boolean;

ALTER TABLE employees ADD COLUMN IF NOT EXISTS user_contractor_id varchar;
DO $$ BEGIN
  ALTER TABLE employees
    ADD CONSTRAINT employees_user_contractor_id_fkey
    FOREIGN KEY (user_contractor_id) REFERENCES user_contractors(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS employees_user_contractor_id_idx
  ON employees(contractor_id, user_contractor_id)
  WHERE user_contractor_id IS NOT NULL;
