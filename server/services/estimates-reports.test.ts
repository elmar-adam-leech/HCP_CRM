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
  getCloseRateBySource,
  getPendingReport,
} from "./estimates-reports";
import { backfillContactLeadSourcesFromHcp } from "../sync/hcp-backfill-foundation";

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
    // Close rate: 1/3 sent = 33.3%. Decision rate: 1/(1+0) = 100%.
    expect(r.totals.closeRate).toBeCloseTo(33.3, 1);
    expect(r.totals.decisionRate).toBe(100);
  });

  it("getCloseRateBySource buckets by contacts.source when the estimate has no lead", async () => {
    // Seed two extra contacts with distinct sources and one estimate each (no
    // lead linked → l.source IS NULL; the report must fall back to c.source).
    const fbContact = await db.execute<{ id: string }>(sql`
      INSERT INTO contacts (name, contractor_id, source, external_source)
      VALUES ('FB Contact', ${contractorId}, 'facebook', 'housecall-pro')
      RETURNING id
    `);
    const refContact = await db.execute<{ id: string }>(sql`
      INSERT INTO contacts (name, contractor_id, source)
      VALUES ('Ref Contact', ${contractorId}, 'referral')
      RETURNING id
    `);
    await db.execute(sql`
      INSERT INTO estimates (title, amount, status, contact_id, contractor_id,
        created_at, updated_at)
      VALUES ('FB Est', '500', 'sent', ${fbContact.rows[0].id}, ${contractorId},
        '2026-06-04T00:00:00Z', '2026-06-04T00:00:00Z')
    `);
    await db.execute(sql`
      INSERT INTO estimates (title, amount, status, contact_id, contractor_id,
        created_at, updated_at)
      VALUES ('Ref Est', '600', 'approved', ${refContact.rows[0].id}, ${contractorId},
        '2026-06-04T00:00:00Z', '2026-06-04T00:00:00Z')
    `);
    const r = await getCloseRateBySource(contractorId, filters);
    const names = (r.rows ?? []).map((row) => row.name).sort();
    expect(names).toContain('facebook');
    expect(names).toContain('referral');
    // Cleanup these extras so the other tests see the original totals.
    await db.execute(sql`DELETE FROM estimates WHERE title IN ('FB Est', 'Ref Est') AND contractor_id = ${contractorId}`);
    await db.execute(sql`DELETE FROM contacts WHERE id IN (${fbContact.rows[0].id}, ${refContact.rows[0].id})`);
  });

  it("backfillContactLeadSourcesFromHcp is idempotent on a no-op contact set", async () => {
    // No HCP-origin contacts exist for this tenant in the seed (Test Contact
    // has no external_source), so two consecutive runs both report 0 scanned.
    const first = await backfillContactLeadSourcesFromHcp(contractorId);
    const second = await backfillContactLeadSourcesFromHcp(contractorId);
    expect(second.scanned).toBe(first.scanned);
    expect(second.updated).toBe(0);
    expect(second.cleared).toBe(0);
    expect(second.failed).toBe(0);
  });

  it("getCloseRateBySalesperson decisionRate is 0 when nothing is decided", async () => {
    // Narrow the window to only include Estimate A (all 'sent'). It still has
    // an HCP-deduplicated canonical row → 1 sent, 0 won, 0 lost.
    const r = await getCloseRateBySalesperson(contractorId, {
      startDate: new Date("2026-06-01T00:00:00Z"),
      endDate: new Date("2026-06-02T00:00:00Z"),
    });
    expect(r.totals.sent).toBe(1);
    expect(r.totals.won).toBe(0);
    expect(r.totals.lost).toBe(0);
    expect(r.totals.decisionRate).toBe(0);
  });
});

// Separate suite for outstanding date filter + pagination. Uses its own
// contractor to keep the row counts deterministic regardless of the seeds in
// the dedup suite above.
let pagedContractorId: string;
let pagedContactId: string;

const ageDate = (days: number): string => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString();
};

beforeAll(async () => {
  if (!RUN) return;
  const c = await db.execute<{ id: string }>(sql`
    INSERT INTO contractors (name, domain)
    VALUES ('test-outstanding-paging', ${'test-outstanding-' + Date.now() + '.example.com'})
    RETURNING id
  `);
  pagedContractorId = c.rows[0].id;
  const ct = await db.execute<{ id: string }>(sql`
    INSERT INTO contacts (name, contractor_id)
    VALUES ('Test Contact', ${pagedContractorId})
    RETURNING id
  `);
  pagedContactId = ct.rows[0].id;

  // Three pending estimates: 5 days old, 20 days old, 60 days old. Each native
  // (no HCP id), each at $1000. Default Last 30 days returns 2; full range 3.
  for (const [title, age] of [["P-5d", 5], ["P-20d", 20], ["P-60d", 60]] as const) {
    await db.execute(sql`
      INSERT INTO estimates (title, amount, status, contact_id, contractor_id,
        created_at, updated_at)
      VALUES (${title}, '1000', 'sent', ${pagedContactId}, ${pagedContractorId},
        ${ageDate(age)}, ${ageDate(age)})
    `);
  }
});

afterAll(async () => {
  if (!RUN || !pagedContractorId) return;
  await db.execute(sql`DELETE FROM estimates WHERE contractor_id = ${pagedContractorId}`);
  await db.execute(sql`DELETE FROM contacts WHERE contractor_id = ${pagedContractorId}`);
  await db.execute(sql`DELETE FROM contractors WHERE id = ${pagedContractorId}`);
});

d("getPipelineForecastReport — filters + unassigned fallback", () => {
  it("date range narrows the pending snapshot", async () => {
    // Restrict to 2026-06-03 only → just Estimate C ($1000) is pending.
    const r = await getPipelineForecastReport(contractorId, {
      startDate: new Date("2026-06-03T00:00:00Z"),
      endDate: new Date("2026-06-04T00:00:00Z"),
    });
    expect(r.pendingCount).toBe(1);
    expect(r.pendingValue).toBe(1000);
  });

  it("salesperson filter narrows pending snapshot to that user", async () => {
    // None of the seeded estimates have a salesperson assigned, so any
    // non-null salespersonId yields zero pending.
    const r = await getPipelineForecastReport(contractorId, {
      ...filters,
      salespersonId: "00000000-0000-0000-0000-000000000000",
    });
    expect(r.pendingCount).toBe(0);
    expect(r.pendingValue).toBe(0);
  });

  it("lead-source filter narrows pending to estimates from that source", async () => {
    // Seed an extra contact + pending estimate with source = 'facebook' so we
    // can verify the leadSource filter actually shrinks the snapshot.
    const fb = await db.execute<{ id: string }>(sql`
      INSERT INTO contacts (name, contractor_id, source)
      VALUES ('Pipeline FB Contact', ${contractorId}, 'facebook')
      RETURNING id
    `);
    await db.execute(sql`
      INSERT INTO estimates (title, amount, status, contact_id, contractor_id,
        created_at, updated_at)
      VALUES ('Pipeline FB Est', '2000', 'sent', ${fb.rows[0].id}, ${contractorId},
        '2026-06-05T00:00:00Z', '2026-06-05T00:00:00Z')
    `);
    try {
      const r = await getPipelineForecastReport(contractorId, {
        ...filters,
        leadSource: "facebook",
      });
      expect(r.pendingCount).toBe(1);
      expect(r.pendingValue).toBe(2000);
    } finally {
      await db.execute(sql`DELETE FROM estimates WHERE title = 'Pipeline FB Est' AND contractor_id = ${contractorId}`);
      await db.execute(sql`DELETE FROM contacts WHERE id = ${fb.rows[0].id}`);
    }
  });

  it("combines salesperson + lead-source filters when narrowing pending", async () => {
    // Two extra estimates: one matches both filters, one only matches source.
    // The combined filter should keep just the matching one.
    const fb = await db.execute<{ id: string }>(sql`
      INSERT INTO contacts (name, contractor_id, source)
      VALUES ('Combo FB Contact', ${contractorId}, 'facebook')
      RETURNING id
    `);
    const sp = "11111111-1111-1111-1111-111111111111";
    const comboUsername = 'combo-' + Date.now();
    await db.execute(sql`
      INSERT INTO users (id, name, email, username, password)
      VALUES (${sp}, 'Combo SP', ${comboUsername + '@example.com'}, ${comboUsername}, 'x')
      ON CONFLICT (id) DO NOTHING
    `);
    await db.execute(sql`
      INSERT INTO estimates (title, amount, status, contact_id, contractor_id,
        salesperson_user_id, created_at, updated_at)
      VALUES ('Combo Match', '1500', 'sent', ${fb.rows[0].id}, ${contractorId},
        ${sp}, '2026-06-06T00:00:00Z', '2026-06-06T00:00:00Z')
    `);
    await db.execute(sql`
      INSERT INTO estimates (title, amount, status, contact_id, contractor_id,
        created_at, updated_at)
      VALUES ('Combo NoSp', '999', 'sent', ${fb.rows[0].id}, ${contractorId},
        '2026-06-06T00:00:00Z', '2026-06-06T00:00:00Z')
    `);
    try {
      const r = await getPipelineForecastReport(contractorId, {
        ...filters,
        salespersonId: sp,
        leadSource: "facebook",
      });
      expect(r.pendingCount).toBe(1);
      expect(r.pendingValue).toBe(1500);
    } finally {
      await db.execute(sql`DELETE FROM estimates WHERE title IN ('Combo Match', 'Combo NoSp') AND contractor_id = ${contractorId}`);
      await db.execute(sql`DELETE FROM contacts WHERE id = ${fb.rows[0].id}`);
      await db.execute(sql`DELETE FROM users WHERE id = ${sp}`);
    }
  });

  it("fallback close rate stays tenant-wide even when filtering by salesperson", async () => {
    // Seed a salesperson with a pending estimate but no decided history.
    // Estimate B (approved, unassigned) gives the tenant a 100% close rate.
    // The fallback must use that tenant-wide rate, not become 0% just
    // because the salesperson filter is applied.
    const sp = "22222222-2222-2222-2222-222222222222";
    const fallbackUsername = 'fallback-' + Date.now();
    await db.execute(sql`
      INSERT INTO users (id, name, email, username, password)
      VALUES (${sp}, 'Fallback SP', ${fallbackUsername + '@example.com'}, ${fallbackUsername}, 'x')
      ON CONFLICT (id) DO NOTHING
    `);
    await db.execute(sql`
      INSERT INTO estimates (title, amount, status, contact_id, contractor_id,
        salesperson_user_id, created_at, updated_at)
      VALUES ('Fallback Pending', '2500', 'sent', ${contactId}, ${contractorId},
        ${sp}, '2026-06-07T00:00:00Z', '2026-06-07T00:00:00Z')
    `);
    try {
      const r = await getPipelineForecastReport(contractorId, {
        ...filters,
        salespersonId: sp,
      });
      expect(r.pendingCount).toBe(1);
      expect(r.pendingValue).toBe(2500);
      // Tenant fallback = 100% (Estimate B approved with no other decided
      // history), so weighted = pending value.
      expect(r.weightedForecast).toBe(2500);
      const row = r.bySalesperson.find((x) => x.userId === sp);
      expect(row).toBeDefined();
      expect(row!.historicalCloseRate).toBe(100);
    } finally {
      await db.execute(sql`DELETE FROM estimates WHERE title = 'Fallback Pending' AND contractor_id = ${contractorId}`);
      await db.execute(sql`DELETE FROM users WHERE id = ${sp}`);
    }
  });

  it("uses tenant-wide fallback close rate for unassigned pending pipeline", async () => {
    // All pending estimates are unassigned (no salesperson). Estimate B is
    // approved → tenant has 1 decided / 1 won → 100% fallback close rate. The
    // weighted forecast must therefore equal the full pending value, not $0.
    const r = await getPipelineForecastReport(contractorId, filters);
    expect(r.pendingCount).toBe(2);
    expect(r.pendingValue).toBe(8500);
    expect(r.weightedForecast).toBe(8500);
    const unassigned = r.bySalesperson.find((row) => row.userId === null);
    expect(unassigned).toBeDefined();
    expect(unassigned!.historicalCloseRate).toBe(100);
    expect(unassigned!.weighted).toBe(8500);
  });
});

d("getPendingReport — date filter + pagination", () => {
  it("default 30-day window excludes the 60-day-old estimate", async () => {
    const end = new Date();
    const start = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
    const r = await getPendingReport(pagedContractorId, { startDate: start, endDate: end });
    expect(r.total).toBe(2);
    expect(r.totalValue).toBe(2000);
    expect(r.estimates).toHaveLength(2);
  });

  it("wider date range returns all three estimates", async () => {
    const end = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const start = new Date(end.getTime() - 365 * 24 * 60 * 60 * 1000);
    const r = await getPendingReport(pagedContractorId, { startDate: start, endDate: end });
    expect(r.total).toBe(3);
    expect(r.totalValue).toBe(3000);
  });

  it("paginates rows but keeps stats across the full filtered set", async () => {
    const end = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const start = new Date(end.getTime() - 365 * 24 * 60 * 60 * 1000);
    const baseFilters = { startDate: start, endDate: end };

    const page0 = await getPendingReport(pagedContractorId, { ...baseFilters, page: 0, pageSize: 1 });
    expect(page0.estimates).toHaveLength(1);
    expect(page0.total).toBe(3);
    expect(page0.totalValue).toBe(3000);

    const page1 = await getPendingReport(pagedContractorId, { ...baseFilters, page: 1, pageSize: 1 });
    expect(page1.estimates).toHaveLength(1);
    expect(page1.total).toBe(3);
    expect(page1.totalValue).toBe(3000);

    const page2 = await getPendingReport(pagedContractorId, { ...baseFilters, page: 2, pageSize: 1 });
    expect(page2.estimates).toHaveLength(1);
    expect(page2.total).toBe(3);

    // Stats (bucket counts) should match across pages.
    expect(page0.buckets).toEqual(page1.buckets);
    expect(page1.buckets).toEqual(page2.buckets);

    // Different rows on each page (sorted by created_at ASC = oldest first).
    const ids = new Set([page0.estimates[0].id, page1.estimates[0].id, page2.estimates[0].id]);
    expect(ids.size).toBe(3);
  });
});
