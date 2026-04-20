import { db } from '../db';
import { oauthStates } from '@shared/schema';
import { lt } from 'drizzle-orm';
import { logger } from '../utils/logger';
import { formatDbError } from '../utils/db-error';
import { BackgroundJob } from './background-job';

const log = logger('GmailOAuthCleanupJob');

/**
 * GmailOAuthCleanupJob
 *
 * Deletes expired OAuth state rows from the `oauth_states` table once per hour.
 * Prevents unbounded table growth when users abandon the OAuth consent flow
 * before completing it.
 */
export class GmailOAuthCleanupJob extends BackgroundJob {
  constructor() {
    super(60 * 60 * 1000);
  }

  protected async runOnce(): Promise<void> {
    try {
      const now = new Date();
      const result = await db.delete(oauthStates).where(lt(oauthStates.expiresAt, now));
      const deletedCount = result.rowCount || 0;
      if (deletedCount > 0) {
        log.info(`Cleaned up ${deletedCount} expired state token(s)`);
      }
    } catch (error) {
      log.error(`Error cleaning up expired states: ${formatDbError(error)}`);
    }
  }
}
