import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

const h = vi.hoisted(() => ({
  insertValues: undefined as unknown,
  conflict: undefined as any,
  selectWhere: [] as unknown[],
  updateSet: undefined as any,
  updateWhere: undefined as unknown,
  insertResult: [] as any[],
  selectResult: [] as any[],
  updateResult: [] as any[],
}));

vi.mock("../db", () => ({
  db: {
    insert: () => ({
      values: (values: unknown) => {
        h.insertValues = values;
        return {
          onConflictDoUpdate: (conflict: unknown) => {
            h.conflict = conflict;
            return { returning: async () => h.insertResult };
          },
        };
      },
    }),
    select: () => ({
      from: () => ({
        where: (where: unknown) => {
          h.selectWhere.push(where);
          return {
            limit: async () => h.selectResult,
            orderBy: async () => h.selectResult,
          };
        },
      }),
    }),
    update: () => ({
      set: (set: unknown) => {
        h.updateSet = set;
        return {
          where: (where: unknown) => {
            h.updateWhere = where;
            return { returning: async () => h.updateResult };
          },
        };
      },
    }),
  },
}));

import { emailParseFailureStore } from "./email-parse-failures";

const dialect = new PgDialect();
const TENANT = "tenant-a";
const INBOX = "inbox-a";
const EMAIL = {
  id: "gmail-message-a",
  threadId: "thread-a",
  from: "sender@example.com",
  to: ["leads@example.com"],
  subject: "New lead",
  body: "A".repeat(20_000),
  date: new Date("2025-01-01T00:00:00Z"),
  snippet: "New lead",
  labelIds: ["INBOX"],
};

function compile(fragment: unknown): { sql: string; params: unknown[] } {
  const query = dialect.sqlToQuery(fragment as any);
  return { sql: query.sql.toLowerCase(), params: query.params };
}

beforeEach(() => {
  h.insertValues = undefined;
  h.conflict = undefined;
  h.selectWhere = [];
  h.updateSet = undefined;
  h.updateWhere = undefined;
  h.insertResult = [{ id: "failure-a" }];
  h.selectResult = [];
  h.updateResult = [];
});

describe("emailParseFailureStore", () => {
  it("records the complete email and increments only an unresolved conflict", async () => {
    await emailParseFailureStore.record({
      contractorId: TENANT,
      inboxId: INBOX,
      email: EMAIL,
      errorCode: "INVALID_BODY",
      errorMessage: "Could not parse body",
    });

    expect((h.insertValues as any).email.body).toHaveLength(20_000);
    expect((h.insertValues as any).messageId).toBe(EMAIL.id);
    expect(h.conflict.target).toHaveLength(3);
    expect(compile(h.conflict.set.attempts).sql).toContain("+ 1");
    expect(compile(h.conflict.setWhere).sql).toMatch(/resolved_at" is null/);
    expect(h.conflict.set).not.toHaveProperty("resolvedAt");
  });

  it("does not reopen a resolved conflict and reads it back within all three key scopes", async () => {
    const resolved = { id: "resolved-a", resolvedAt: new Date() };
    h.insertResult = [];
    h.selectResult = [resolved];

    await expect(emailParseFailureStore.record({
      contractorId: TENANT,
      inboxId: INBOX,
      email: EMAIL,
      errorCode: "INVALID_BODY",
      errorMessage: "Still invalid",
    })).resolves.toBe(resolved);

    const query = compile(h.selectWhere[0]);
    expect(query.sql).toContain("contractor_id");
    expect(query.sql).toContain("inbox_id");
    expect(query.sql).toContain("message_id");
    expect(query.params).toEqual(expect.arrayContaining([TENANT, INBOX, EMAIL.id]));
  });

  it("tenant-scopes get and pending-list queries", async () => {
    await emailParseFailureStore.get("failure-a", TENANT);
    await emailParseFailureStore.listPending(TENANT, INBOX);

    const getQuery = compile(h.selectWhere[0]);
    expect(getQuery.sql).toContain("id");
    expect(getQuery.sql).toContain("contractor_id");
    expect(getQuery.params).toEqual(expect.arrayContaining(["failure-a", TENANT]));

    const listQuery = compile(h.selectWhere[1]);
    expect(listQuery.sql).toContain("contractor_id");
    expect(listQuery.sql).toContain("inbox_id");
    expect(listQuery.sql).toMatch(/resolved_at" is null/);
    expect(listQuery.params).toEqual(expect.arrayContaining([TENANT, INBOX]));
  });

  it("resolves only an unresolved message inside contractor and inbox scope", async () => {
    await emailParseFailureStore.resolve(TENANT, INBOX, EMAIL.id);

    expect(h.updateSet.resolvedAt).toBeInstanceOf(Date);
    const query = compile(h.updateWhere);
    expect(query.sql).toContain("contractor_id");
    expect(query.sql).toContain("inbox_id");
    expect(query.sql).toContain("message_id");
    expect(query.sql).toMatch(/resolved_at" is null/);
    expect(query.params).toEqual(expect.arrayContaining([TENANT, INBOX, EMAIL.id]));
  });
});