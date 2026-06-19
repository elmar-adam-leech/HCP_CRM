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

## Known pre-existing failure (not yours to fix unless tasked)
On boot you'll see:
`migration failed (backfill: reset leads stuck on customer-only status
(active/inactive) ... task #798): column "status" is of type contact_status
but expression is of type text`
This is a pre-existing task #798 backfill that lacks a `::contact_status`
cast on its UPDATE expression; it fails idempotently every boot and does not
block startup. `leads.status` is the `contact_status` enum, so any literal
written to it must be cast back to the enum.
