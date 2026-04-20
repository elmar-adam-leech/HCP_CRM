CREATE TABLE IF NOT EXISTS "assignment_rules" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "contractor_id" varchar NOT NULL REFERENCES "contractors"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "conditions" text NOT NULL DEFAULT '[]',
  "assign_to_user_id" varchar REFERENCES "users"("id") ON DELETE SET NULL,
  "priority" integer NOT NULL DEFAULT 0,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "assignment_rules_contractor_id_idx" ON "assignment_rules" ("contractor_id");
CREATE INDEX IF NOT EXISTS "assignment_rules_priority_idx" ON "assignment_rules" ("contractor_id", "priority");
