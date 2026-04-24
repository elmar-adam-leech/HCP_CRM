-- Task #651: WebAuthn passkey unlock for one-tap PWA re-login.
-- Adds storage for registered platform-authenticator credentials (passkeys)
-- and a short-lived challenge table used during register/login ceremonies.

CREATE TABLE IF NOT EXISTS "webauthn_credentials" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" varchar NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "credential_id" text NOT NULL UNIQUE,
  "public_key" text NOT NULL,
  "counter" bigint NOT NULL DEFAULT 0,
  "transports" text[],
  "device_label" text NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "last_used_at" timestamp
);

CREATE INDEX IF NOT EXISTS "webauthn_credentials_user_id_idx"
  ON "webauthn_credentials"("user_id");

CREATE TABLE IF NOT EXISTS "webauthn_challenges" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" varchar REFERENCES "users"("id") ON DELETE CASCADE,
  "session_id" text UNIQUE,
  "challenge" text NOT NULL,
  "purpose" text NOT NULL,
  "expires_at" timestamp NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "webauthn_challenges_expires_at_idx"
  ON "webauthn_challenges"("expires_at");

CREATE INDEX IF NOT EXISTS "webauthn_challenges_user_id_idx"
  ON "webauthn_challenges"("user_id");
