---
name: Schema migrations location
description: Where idempotent column/index/FK migrations actually live in this repo
---

# Column/index migrations live in server/schema-drift.ts

Idempotent `columnMigrations` (ADD COLUMN, CREATE INDEX, FK, one-time
backfills) run from `server/schema-drift.ts`, executed on boot by `initDb`
(`applyColumnMigrations` step), followed by `runSchemaDriftCheck` which
asserts every Drizzle-declared table/column exists.

**Note:** `replit.md` says these live in `server/db.ts` — that is OUTDATED.
Add new migrations to `server/schema-drift.ts`.

