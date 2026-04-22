/**
 * Integration tests for the canonical-row dedup applied by the estimates
 * report layer. HCP estimates with multiple Good/Better/Best options produce
 * one local row per option in the `estimates` table. The reports must count
 * each logical estimate once — picking the approved option (if any), then the
 * highest-amount option as the canonical row.
 *
 * Seeds a temporary contractor + contacts + estimates against the real
 * database, runs the reports, asserts the deduplicated values, and tears
 * everything down at the end. Skips if DATABASE_URL is not set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../db";
import {
  getRevenueReport,
  getPipelineForecastReport,
  getCloseRateBySalesperson,
} from "./estimates-reports";

const RUN = !!process.env.DATABASE_URL;
const d = RUN ? describe : describe.skip;

let contractorId: string;
let contactId: string;
const filters = {
  startDate: new Date("2026-01-01T00:00:00Z"),
  endDate: new Date("2027-01-01T00:00:00Z"),
};

const HCP_A = "csr_test_a";
const HCP_B = "csr_test_b";

beforeAll(async () => {
  // Tenant
  const c = await db.execute<{ id: string }>(sql`
    INSERT INTO contractors (name, domain)
    VALUES ('test-estimates-reports', ${'test-' + Date.now() + '.example.com'})
    RETURNING id
  `);
  contractorId = c.rows[0].id;

  // Contact
  const ct = await db.execute<{ id: string }>(sql`
    INSERT INTO contacts (name, contractor_id)
    VALUES ('Test Contact', ${contractorId})
    RETURNING id
  `);
  contactId = ct.rows[0].id;

  // Estimate A: HCP-sourced, 3 options, all 'sent', amounts 0 / 5000 / 7500
  for (const amt of ["0", "5000", "7500"]) {
    await db.execute(sql`
      INSERT INTO estimates (title, amount, status, contact_id, contractor_id,
        housecall_pro_estimate_id, created_at, updated_at)
      VALUES ('Estimate A', ${amt}, 'sent', ${contactId}, ${contractorId},
        ${HCP_A}, '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z')
    `);
  }

  // Estimate B: HCP-sourced, 2 options, statuses approved / sent, amounts 3000 / 4000
  await db.execute(sql`
    INSERT INTO estimates (title, amount, status, contact_id, contractor_id,
      housecall_pro_estimate_id, created_at, updated_at)
    VALUES ('Estimate B', '3000', 'sent', ${contactId}, ${contractorId},
      ${HCP_B}, '2026-06-02T00:00:00Z', '2026-06-02T00:00:00Z')
  `);
  await db.execute(sql`
    INSERT INTO estimates (title, amount, status, contact_id, contractor_id,
      housecall_pro_estimate_id, created_at, updated_at)
    VALUES ('Estimate B', '4000', 'approved', ${contactId}, ${contractorId},
      ${HCP_B}, '2026-06-02T00:00:00Z', '2026-06-02T00:00:00Z')
  `);

  // Estimate C: native (no HCP id), single 'sent' row at $1000
  await db.execute(sql`
    INSERT INTO estimates (title, amount, status, contact_id, contractor_id,
      created_at, updated_at)
    VALUES ('Estimate C', '1000', 'sent', ${contactId}, ${contractorId},
      '2026-06-03T00:00:00Z', '2026-06-03T00:00:00Z')
  `);
});

afterAll(async () => {
  if (!contractorId) return;
  await db.execute(sql`DELETE FROM estimates WHERE contractor_id = ${contractorId}`);
  await db.execute(sql`DELETE FROM contacts WHERE contractor_id = ${contractorId}`);
  await db.execute(sql`DELETE FROM contractors WHERE id = ${contractorId}`);
});

d("estimates reports — option-row dedup", () => {
  it("getPipelineForecastReport counts each pending estimate once", async () => {
    const r = await getPipelineForecastReport(contractorId, filters);
    // A is pending (3 sent rows → 1), C is pending (1). B is approved → not pending.
    expect(r.pendingCount).toBe(2);
    // Canonical row for A is the $7500 (highest amount). C is $1000.
    expect(r.pendingValue).toBe(8500);
  });

  it("getRevenueReport counts each estimate once across all statuses", async () => {
    const r = await getRevenueReport(contractorId, filters);
    expect(r.estimateCount).toBe(3);
    // A → $7500 (top option), B → $4000 (approved), C → $1000.
    expect(r.totalEstimated).toBe(12500);
    // Only B is approved → $4000.
    expect(r.totalWon).toBe(4000);
  });

  it("getCloseRateBySalesperson totals reflect estimate-level counts", async () => {
    const r = await getCloseRateBySalesperson(contractorId, filters);
    // 3 estimates total, 1 won (B), 2 open (A & C).
    expect(r.totals.sent).toBe(3);
    expect(r.totals.won).toBe(1);
    expect(r.totals.lost).toBe(0);
    expect(r.totals.open).toBe(2);
  });
});
