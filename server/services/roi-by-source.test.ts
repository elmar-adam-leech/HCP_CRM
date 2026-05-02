/**
 * Integration tests for the ROI by Source report (task #696).
 *
 * Seeds a temporary contractor with leads spread across raw sources that roll
 * up into Facebook (`facebook`, `facebook_lead_ad`), Google, and Referral.
 * One won estimate and one won (completed) job are linked back to the seeded
 * leads so we can assert both modes share the same source rollup logic.
 *
 * Skips when DATABASE_URL is not set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../db";
import { getRoiBySourceReport } from "./roi-by-source";

const RUN = !!process.env.DATABASE_URL;
const d = RUN ? describe : describe.skip;

let contractorId: string;
let contactFbId: string;
let contactGoogleId: string;
let contactReferralId: string;
let estimateFbId: string;
let jobFbId: string;

const filters = {
  startDate: new Date("2026-01-01T00:00:00Z"),
  endDate: new Date("2027-01-01T00:00:00Z"),
};

beforeAll(async () => {
  if (!RUN) return;
  const c = await db.execute<{ id: string }>(sql`
    INSERT INTO contractors (name, domain)
    VALUES ('test-roi-by-source', ${"test-roi-" + Date.now() + ".example.com"})
    RETURNING id
  `);
  contractorId = c.rows[0].id;

  // Three contacts, one per source bucket.
  const fb = await db.execute<{ id: string }>(sql`
    INSERT INTO contacts (name, contractor_id, source)
    VALUES ('FB Contact', ${contractorId}, 'facebook')
    RETURNING id
  `);
  contactFbId = fb.rows[0].id;
  const g = await db.execute<{ id: string }>(sql`
    INSERT INTO contacts (name, contractor_id, source)
    VALUES ('Google Contact', ${contractorId}, 'google')
    RETURNING id
  `);
  contactGoogleId = g.rows[0].id;
  const r = await db.execute<{ id: string }>(sql`
    INSERT INTO contacts (name, contractor_id, source)
    VALUES ('Referral Contact', ${contractorId}, 'referral')
    RETURNING id
  `);
  contactReferralId = r.rows[0].id;

  // Leads: 2 facebook, 1 facebook_lead_ad, 1 google, 1 referral.
  // Both facebook variants must roll up into the "Facebook" platform.
  for (const src of ["facebook", "facebook"] as const) {
    await db.execute(sql`
      INSERT INTO leads (contact_id, contractor_id, source, created_at, updated_at)
      VALUES (${contactFbId}, ${contractorId}, ${src},
        '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z')
    `);
  }
  await db.execute(sql`
    INSERT INTO leads (contact_id, contractor_id, source, created_at, updated_at)
    VALUES (${contactFbId}, ${contractorId}, 'facebook_lead_ad',
      '2026-06-02T00:00:00Z', '2026-06-02T00:00:00Z')
  `);
  await db.execute(sql`
    INSERT INTO leads (contact_id, contractor_id, source, created_at, updated_at)
    VALUES (${contactGoogleId}, ${contractorId}, 'google',
      '2026-06-02T00:00:00Z', '2026-06-02T00:00:00Z')
  `);
  await db.execute(sql`
    INSERT INTO leads (contact_id, contractor_id, source, created_at, updated_at)
    VALUES (${contactReferralId}, ${contractorId}, 'referral',
      '2026-06-03T00:00:00Z', '2026-06-03T00:00:00Z')
  `);

  // Estimates: one approved estimate from the FB lead path ($5000),
  // one approved estimate from the Google lead path ($1000), and a
  // sent (not won) estimate from referral ($2000).
  const estFb = await db.execute<{ id: string }>(sql`
    INSERT INTO estimates (title, amount, status, contact_id, contractor_id,
      created_at, updated_at)
    VALUES ('FB Won', '5000', 'approved', ${contactFbId}, ${contractorId},
      '2026-06-05T00:00:00Z', '2026-06-05T00:00:00Z')
    RETURNING id
  `);
  estimateFbId = estFb.rows[0].id;
  await db.execute(sql`
    INSERT INTO estimates (title, amount, status, contact_id, contractor_id,
      created_at, updated_at)
    VALUES ('G Won', '1000', 'approved', ${contactGoogleId}, ${contractorId},
      '2026-06-05T00:00:00Z', '2026-06-05T00:00:00Z')
  `);
  await db.execute(sql`
    INSERT INTO estimates (title, amount, status, contact_id, contractor_id,
      created_at, updated_at)
    VALUES ('R Pending', '2000', 'sent', ${contactReferralId}, ${contractorId},
      '2026-06-06T00:00:00Z', '2026-06-06T00:00:00Z')
  `);

  // Link the FB lead → estimate so the converted_to_estimate_id path resolves.
  await db.execute(sql`
    UPDATE leads SET converted_to_estimate_id = ${estimateFbId}
    WHERE contractor_id = ${contractorId} AND source = 'facebook'
  `);

  // Job: completed FB job at $4000, plus a scheduled (non-won) Google job
  // that should NOT be counted in jobs mode. Job sources resolve via
  // lead.converted_to_job_id → contact fallback.
  const jobFb = await db.execute<{ id: string }>(sql`
    INSERT INTO jobs (title, type, status, value, contact_id, contractor_id,
      estimate_id, created_at, updated_at)
    VALUES ('FB Job Completed', 'install', 'completed', '4000',
      ${contactFbId}, ${contractorId}, ${estimateFbId},
      '2026-06-10T00:00:00Z', '2026-06-10T00:00:00Z')
    RETURNING id
  `);
  jobFbId = jobFb.rows[0].id;
  // Wire one of the FB leads → job to exercise the converted_to_job_id branch.
  await db.execute(sql`
    UPDATE leads SET converted_to_job_id = ${jobFbId}
    WHERE id = (
      SELECT id FROM leads
      WHERE contractor_id = ${contractorId} AND source = 'facebook_lead_ad'
      LIMIT 1
    )
  `);

  // Spend: $1000 facebook in June, $500 google in June, $200 yelp in June
  // (yelp has no leads so it should still appear as wasted spend).
  await db.execute(sql`
    INSERT INTO media_spend (contractor_id, platform, month, amount)
    VALUES
      (${contractorId}, 'facebook', '2026-06-01', '1000'),
      (${contractorId}, 'google',   '2026-06-01', '500'),
      (${contractorId}, 'yelp',     '2026-06-01', '200')
  `);
});

afterAll(async () => {
  if (!RUN || !contractorId) return;
  await db.execute(sql`DELETE FROM media_spend WHERE contractor_id = ${contractorId}`);
  await db.execute(sql`UPDATE leads SET converted_to_estimate_id = NULL, converted_to_job_id = NULL WHERE contractor_id = ${contractorId}`);
  await db.execute(sql`DELETE FROM jobs WHERE contractor_id = ${contractorId}`);
  await db.execute(sql`DELETE FROM estimates WHERE contractor_id = ${contractorId}`);
  await db.execute(sql`DELETE FROM leads WHERE contractor_id = ${contractorId}`);
  await db.execute(sql`DELETE FROM contacts WHERE contractor_id = ${contractorId}`);
  await db.execute(sql`DELETE FROM contractors WHERE id = ${contractorId}`);
});

d("ROI by Source — estimates mode", () => {
  it("rolls raw sources up into platforms and computes spend/ROI", async () => {
    const r = await getRoiBySourceReport(contractorId, { ...filters, mode: "estimates" });
    const fb = r.platforms.find((p) => p.platform === "Facebook");
    const google = r.platforms.find((p) => p.platform === "Google");
    const referral = r.platforms.find((p) => p.platform === "Referral");
    const yelp = r.platforms.find((p) => p.platform === "Yelp");

    expect(fb).toBeDefined();
    // 2 facebook + 1 facebook_lead_ad
    expect(fb!.leadCount).toBe(3);
    expect(fb!.wonCount).toBe(1);
    expect(fb!.wonRevenue).toBe(5000);
    expect(fb!.spend).toBe(1000);
    // ROAS = 5000 / 1000 = 5
    expect(fb!.roas).toBe(5);
    // ROI = (5000 - 1000) / 1000 * 100 = 400%
    expect(fb!.roiPercent).toBe(400);
    // Drill-down has both raw sources.
    const sources = fb!.bySource.map((s) => s.source).sort();
    expect(sources).toEqual(["facebook", "facebook_lead_ad"]);

    expect(google!.leadCount).toBe(1);
    expect(google!.wonCount).toBe(1);
    expect(google!.wonRevenue).toBe(1000);
    expect(google!.spend).toBe(500);
    expect(google!.roiPercent).toBe(100);

    // Referral has leads but no spend → spend/roi columns are null.
    expect(referral!.leadCount).toBe(1);
    expect(referral!.wonCount).toBe(0);
    expect(referral!.spend).toBeNull();
    expect(referral!.roiPercent).toBeNull();
    expect(referral!.costPerLead).toBeNull();

    // Yelp has spend but zero leads — must still appear so wasted spend shows.
    expect(yelp).toBeDefined();
    expect(yelp!.leadCount).toBe(0);
    expect(yelp!.wonCount).toBe(0);
    expect(yelp!.spend).toBe(200);
    // ROI = (0 - 200) / 200 * 100 = -100%
    expect(yelp!.roiPercent).toBe(-100);

    // Totals: spend = 1700, revenue = 6000.
    expect(r.totals.spend).toBe(1700);
    expect(r.totals.wonRevenue).toBe(6000);
    expect(r.hasAnySpend).toBe(true);
  });
});

d("ROI by Source — jobs mode", () => {
  it("uses completed jobs and resolves source via converted_to_job_id", async () => {
    const r = await getRoiBySourceReport(contractorId, { ...filters, mode: "jobs" });
    const fb = r.platforms.find((p) => p.platform === "Facebook");
    expect(fb).toBeDefined();
    expect(fb!.wonCount).toBe(1);
    expect(fb!.wonRevenue).toBe(4000);
    // No completed Google job seeded → wonCount 0 even though leads exist.
    const google = r.platforms.find((p) => p.platform === "Google");
    expect(google!.wonCount).toBe(0);
    expect(google!.wonRevenue).toBe(0);
  });
});
