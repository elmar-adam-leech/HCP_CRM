import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { statusTabFilter } from "../storage/estimates";

const dialect = new PgDialect();

function renderFilter(status: string): string {
  const { sql: generated } = dialect.sqlToQuery(statusTabFilter(status).getSQL());
  return generated;
}

describe("estimates Sent tab filter (task #898)", () => {
  it("matches estimates with a sent timestamp OR status 'sent'", () => {
    const sqlText = renderFilter("sent").toLowerCase();
    expect(sqlText).toContain(`"document_sent_at" is not null`);
    expect(sqlText).toMatch(/or\s+"estimates"\."status"\s*=\s*'sent'/);
    expect(sqlText).toMatch(/not in \('approved', 'rejected'\)/);
  });

  it("keeps scheduled/in_progress mutually exclusive with the Sent tab", () => {
    for (const status of ["scheduled", "in_progress"]) {
      const sqlText = renderFilter(status).toLowerCase();
      // These tabs only match rows the widened Sent predicate cannot match:
      // status is scheduled/in_progress (not 'sent') AND documentSentAt is NULL.
      expect(sqlText).toContain(`"document_sent_at" is null`);
      expect(sqlText).toMatch(/"status" = \$1/);
    }
  });

  it("approved/rejected tabs filter purely on status", () => {
    for (const status of ["approved", "rejected"]) {
      const sqlText = renderFilter(status);
      expect(sqlText).not.toContain("document_sent_at");
    }
  });
});
