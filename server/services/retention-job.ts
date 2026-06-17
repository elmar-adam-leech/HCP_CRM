import { db } from "../db";
import { sql } from "drizzle-orm";
import { logger } from "../utils/logger";
import { formatDbError } from "../utils/db-error";
import { auditLog } from "../utils/audit-log";

const log = logger('RetentionJob');

const GLOBAL_FALLBACK_MONTHS = 84;

/**
 * Flag contacts that are past their tenant's data-retention window. Invoked
 * once per day from the consolidated maintenance pass
 * (`server/services/maintenance-job.ts`), which preserves the original 3 AM UTC
 * off-peak schedule.
 */
export async function runRetentionCheck(): Promise<void> {
  log.info('Running data retention check...');

  try {
    const contractorsResult = await db.execute(sql`
      SELECT id, data_retention_months FROM contractors
    `);

    const contractors = contractorsResult.rows as Array<{ id: string; data_retention_months: number | null }>;

    let totalFlagged = 0;

    for (const contractor of contractors) {
      try {
        const retentionMonths = contractor.data_retention_months ?? GLOBAL_FALLBACK_MONTHS;
        const cutoffDate = new Date();
        cutoffDate.setMonth(cutoffDate.getMonth() - retentionMonths);

        const BATCH_SIZE = 500;
        let flaggedInBatch = 0;

        do {
          flaggedInBatch = 0;

          const contactsToFlag = await db.execute(sql`
            SELECT id, name
            FROM contacts
            WHERE contractor_id = ${contractor.id}
              AND retention_flagged_at IS NULL
              AND anonymized = false
              AND (
                last_activity_at IS NULL AND created_at < ${cutoffDate.toISOString()}::timestamp
                OR last_activity_at < ${cutoffDate.toISOString()}::timestamp
              )
            LIMIT ${BATCH_SIZE}
          `);

          const rows = contactsToFlag.rows as Array<{ id: string; name: string }>;
          if (rows.length === 0) break;

          const ids = rows.map(r => r.id);
          const idsList = sql.join(ids.map((id) => sql`${id}`), sql`, `);
          await db.execute(sql`
            UPDATE contacts SET retention_flagged_at = NOW() WHERE id IN (${idsList})
          `);

          for (const contact of rows) {
            await auditLog({
              contractorId: contractor.id,
              action: 'retention.flag',
              entityType: 'contact',
              entityId: contact.id,
              after: {
                retentionFlaggedAt: new Date().toISOString(),
                retentionMonths,
                cutoffDate: cutoffDate.toISOString(),
              },
              reason: `Contact inactive for ${retentionMonths} months (threshold)`,
            });
          }

          flaggedInBatch = rows.length;
          totalFlagged += flaggedInBatch;
        } while (flaggedInBatch === BATCH_SIZE);
      } catch (contractorErr) {
        log.error(`Retention check failed for contractor ${contractor.id}: ${formatDbError(contractorErr)}`);
      }
    }

    log.info(`Data retention check complete. Flagged ${totalFlagged} contacts.`);
  } catch (err) {
    log.error(`Data retention job failed: ${formatDbError(err)}`);
  }
}

