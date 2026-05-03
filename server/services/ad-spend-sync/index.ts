import { db } from "../../db";
import { contractorIntegrations } from "@shared/schema";
import { and, eq } from "drizzle-orm";
import { logger } from "../../utils/logger";
import { syncFacebookAdSpendForContractor } from "./facebook";
import { syncGoogleAdSpendForContractor } from "./google";

const log = logger("AdSpendSync");

export const FACEBOOK_INTEGRATION_NAME = "facebook-ads";
export const GOOGLE_INTEGRATION_NAME = "google-ads";

async function listEnabledContractorIds(integrationName: string): Promise<string[]> {
  const rows = await db
    .select({ contractorId: contractorIntegrations.contractorId })
    .from(contractorIntegrations)
    .where(and(
      eq(contractorIntegrations.integrationName, integrationName),
      eq(contractorIntegrations.isEnabled, true),
    ));
  return rows.map((r) => r.contractorId);
}

export interface AdSpendRunSummary {
  facebook: { contractors: number; upserted: number; skippedManual: number; errors: number };
  google: { contractors: number; upserted: number; skippedManual: number; errors: number };
}

export async function runAdSpendSync(): Promise<AdSpendRunSummary> {
  const summary: AdSpendRunSummary = {
    facebook: { contractors: 0, upserted: 0, skippedManual: 0, errors: 0 },
    google: { contractors: 0, upserted: 0, skippedManual: 0, errors: 0 },
  };

  const [fbIds, googleIds] = await Promise.all([
    listEnabledContractorIds(FACEBOOK_INTEGRATION_NAME),
    listEnabledContractorIds(GOOGLE_INTEGRATION_NAME),
  ]);

  for (const contractorId of fbIds) {
    summary.facebook.contractors += 1;
    try {
      const r = await syncFacebookAdSpendForContractor(contractorId);
      summary.facebook.upserted += r.upserted;
      summary.facebook.skippedManual += r.skippedManual;
      if (r.error) summary.facebook.errors += 1;
    } catch (err) {
      summary.facebook.errors += 1;
      log.error(`Facebook sync threw for ${contractorId}: ${err instanceof Error ? err.message : err}`);
    }
  }
  for (const contractorId of googleIds) {
    summary.google.contractors += 1;
    try {
      const r = await syncGoogleAdSpendForContractor(contractorId);
      summary.google.upserted += r.upserted;
      summary.google.skippedManual += r.skippedManual;
      if (r.error) summary.google.errors += 1;
    } catch (err) {
      summary.google.errors += 1;
      log.error(`Google sync threw for ${contractorId}: ${err instanceof Error ? err.message : err}`);
    }
  }

  log.info(
    `Ad-spend sync done. FB: ${summary.facebook.contractors} contractors, ${summary.facebook.upserted} upserts, ${summary.facebook.errors} errors. ` +
    `Google: ${summary.google.contractors} contractors, ${summary.google.upserted} upserts, ${summary.google.errors} errors.`
  );
  return summary;
}

export { syncFacebookAdSpendForContractor, syncGoogleAdSpendForContractor };
