ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "status_manually_set" boolean DEFAULT false NOT NULL;
