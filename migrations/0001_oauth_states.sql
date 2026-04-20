-- Migration: Add oauth_states table for Gmail OAuth state management
-- This table stores temporary state tokens during OAuth flows to prevent CSRF attacks

CREATE TABLE IF NOT EXISTS "oauth_states" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"state" text NOT NULL UNIQUE,
	"user_id" varchar NOT NULL,
	"redirect_host" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);

-- Performance indexes for OAuth state lookups and cleanup
CREATE INDEX IF NOT EXISTS "oauth_states_state_idx" ON "oauth_states" USING btree ("state");
CREATE INDEX IF NOT EXISTS "oauth_states_expires_at_idx" ON "oauth_states" USING btree ("expires_at");
