import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect, getTableConfig } from "drizzle-orm/pg-core";
import { spamAuditLog } from "@shared/schema";
import { columnMigrations } from "../schema-drift";

const dialect = new PgDialect();

type AuditRow = {
  id: string;
  contractorId: string;
  inboxId: string;
  messageId: string | null;
  senderEmail: string;
  subject: string;
  body: string;
  spamConfidence: number;
  reason: string | null;
  flaggedAt: Date;
  recoveredAt: Date | null;
  recoveredLeadId: string | null;
};

const h = vi.hoisted(() => ({
  rows: new Map<string, any>(),
  nextId: 1,
  conflicts: [] as any[],
  selectPredicates: [] as unknown[],
}));

function identifiedKey(row: {
  contractorId: string;
  inboxId: string;
  messageId?: string | null;
}): string | undefined {
  return row.messageId == null
    ? undefined
    : `${row.contractorId}\0${row.inboxId}\0${row.messageId}`;
}

function makeRow(values: any): AuditRow {
  return {
    id: `audit-${h.nextId++}`,
    messageId: null,
    reason: null,
    flaggedAt: new Date("2025-01-01T00:00:00Z"),
    recoveredAt: null,
    recoveredLeadId: null,
    ...values,
  };
}

async function insert(values: any, dedupe: boolean): Promise<AuditRow[]> {
  // Yield once so Promise.all exercises the conflict path rather than merely
  // making sequential calls. The key check plus write is then one JS turn,
  // modelling the unique index's atomic winner selection.
  await Promise.resolve();
  const key = identifiedKey(values);
  if (dedupe && key && h.rows.has(key)) return [];
  const row = makeRow(values);
  h.rows.set(key ?? `legacy:${row.id}`, row);
  return [row];
}

vi.mock("../db", () => ({
  db: {
    insert: () => ({
      values: (values: any) => ({
        returning: () => insert(values, false),
        onConflictDoNothing: (conflict: any) => {
          h.conflicts.push(conflict);
          return { returning: () => insert(values, true) };
        },
      }),
    }),
    select: () => ({
      from: () => ({
        where: (predicate: unknown) => {
          h.selectPredicates.push(predicate);
          return {
            limit: async () => {
              const params = dialect.sqlToQuery(predicate as any).params;
              return [...h.rows.values()].filter((row) =>
                params.includes(row.contractorId)
                && params.includes(row.inboxId)
                && params.includes(row.messageId)
              ).slice(0, 1);
            },
          };
        },
      }),
    }),
  },
}));

import { leadCaptureMethods } from "./lead-capture";

function entry(overrides: Record<string, unknown> = {}) {
  return {
    contractorId: "tenant-a",
    inboxId: "inbox-a",
    messageId: "gmail-message-a",
    senderEmail: "sender@example.com",
    subject: "Original subject",
    body: "Original body",
    spamConfidence: 95,
    reason: "Original decision",
    ...overrides,
  };
}

beforeEach(() => {
  h.rows.clear();
  h.nextId = 1;
  h.conflicts = [];
  h.selectPredicates = [];
});

describe("spam audit message identity constraints", () => {
  it("declares nullable identity with a standard tenant/inbox/message unique index", () => {
    expect(spamAuditLog.messageId.notNull).toBe(false);

    const index = getTableConfig(spamAuditLog).indexes.find(
      ({ config }) => config.name === "spam_audit_log_contractor_inbox_message_idx",
    );
    expect(index?.config.unique).toBe(true);
    expect(index?.config.columns.map((column) => column.name)).toEqual([
      "contractor_id",
      "inbox_id",
      "message_id",
    ]);
  });

  it("migrates after audit table creation without backfill or NULLS NOT DISTINCT", () => {
    const tableMigration = columnMigrations.findIndex(({ sql }) =>
      sql.includes('CREATE TABLE IF NOT EXISTS "spam_audit_log"')
    );
    const identityMigration = columnMigrations.findIndex(({ sql }) =>
      sql.includes("spam_audit_log_contractor_inbox_message_idx")
      && sql.includes("ADD COLUMN IF NOT EXISTS message_id")
    );
    expect(identityMigration).toBe(tableMigration + 1);

    const sql = columnMigrations[identityMigration]!.sql.toLowerCase();
    expect(sql).toMatch(/add column if not exists message_id text/);
    expect(sql).toMatch(
      /unique index if not exists spam_audit_log_contractor_inbox_message_idx[\s\S]*contractor_id,\s*inbox_id,\s*message_id/
    );
    expect(sql).not.toContain("not null");
    expect(sql).not.toContain("nulls not distinct");
    expect(sql).not.toMatch(/\bupdate\s+spam_audit_log\b/);
  });
});

describe("createSpamAuditEntry identity", () => {
  it("uses the three-column conflict target and returns one immutable row for concurrent replays", async () => {
    const [original, replay] = await Promise.all([
      leadCaptureMethods.createSpamAuditEntry(entry()),
      leadCaptureMethods.createSpamAuditEntry(entry({
        body: "Replay body must not win",
        recoveredAt: new Date("2025-02-01T00:00:00Z"),
        recoveredLeadId: "lead-replay",
      }) as any),
    ]);

    expect(original.id).toBe(replay.id);
    expect(original.body).toBe(replay.body);
    const persisted = [...h.rows.values()][0];
    expect(persisted.body).toBe(original.body);
    expect(persisted.recoveredAt).toBe(original.recoveredAt);
    expect(h.conflicts[0].target).toEqual([
      spamAuditLog.contractorId,
      spamAuditLog.inboxId,
      spamAuditLog.messageId,
    ]);

    const fallback = dialect.sqlToQuery(h.selectPredicates[0] as any);
    expect(fallback.sql).toContain("contractor_id");
    expect(fallback.sql).toContain("inbox_id");
    expect(fallback.sql).toContain("message_id");
    expect(fallback.params).toEqual(expect.arrayContaining([
      "tenant-a", "inbox-a", "gmail-message-a",
    ]));
  });

  it("isolates identical inbox/message identities by contractor", async () => {
    const [tenantA, tenantB] = await Promise.all([
      leadCaptureMethods.createSpamAuditEntry(entry()),
      leadCaptureMethods.createSpamAuditEntry(entry({ contractorId: "tenant-b" })),
    ]);
    const replayA = await leadCaptureMethods.createSpamAuditEntry(entry({ body: "changed" }));

    expect(tenantA.id).toBe(replayA.id);
    expect(tenantA.id).not.toBe(tenantB.id);
    expect(h.rows.size).toBe(2);
  });

  it("retains append behavior for legacy null identities", async () => {
    const first = await leadCaptureMethods.createSpamAuditEntry(entry({ messageId: null }));
    const second = await leadCaptureMethods.createSpamAuditEntry(entry({ messageId: null }));

    expect(first.id).not.toBe(second.id);
    expect(h.rows.size).toBe(2);
    expect(h.conflicts).toHaveLength(0);
  });
});