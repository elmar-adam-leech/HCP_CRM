import { BackgroundJob } from './background-job';
import { leadCaptureMethods } from '../storage/lead-capture';
import { logger } from '../utils/logger';
import { formatDbError } from '../utils/db-error';
import {
  SPAM_AUDIT_RETENTION_DAYS,
  SPAM_AUDIT_RETENTION_MS,
} from '@shared/constants/spam-audit-retention';

const log = logger('SpamAuditCleanupJob');

/**
 * SpamAuditCleanupJob
 *
 * Runs once per day and deletes old rows from the `spam_audit_log` table to
 * prevent unbounded growth.  Deletion rules:
 *   - Unrecovered rows (recoveredAt IS NULL): deleted when flaggedAt is older
 *     than SPAM_AUDIT_RETENTION_DAYS.
 *   - Recovered rows (recoveredAt IS NOT NULL): deleted when recoveredAt is
 *     older than SPAM_AUDIT_RETENTION_DAYS.
 *
 * Processes all active contractor inboxes and logs the total deleted count.
 */
export class SpamAuditCleanupJob extends BackgroundJob {
  constructor() {
    super(24 * 60 * 60 * 1000);
  }

  protected async runOnce(): Promise<void> {
    try {
      const cutoff = new Date(Date.now() - SPAM_AUDIT_RETENTION_MS);
      const inboxes = await leadCaptureMethods.getAllActiveLeadCaptureInboxes();

      let totalDeleted = 0;
      for (const inbox of inboxes) {
        const deleted = await leadCaptureMethods.pruneSpamAuditLog(inbox.contractorId, cutoff);
        totalDeleted += deleted;
      }

      if (totalDeleted > 0) {
        log.info(`Pruned ${totalDeleted} spam audit log row(s) older than ${SPAM_AUDIT_RETENTION_DAYS} days`);
      }
    } catch (error) {
      log.error(`Error pruning spam audit log: ${formatDbError(error)}`);
    }
  }
}
