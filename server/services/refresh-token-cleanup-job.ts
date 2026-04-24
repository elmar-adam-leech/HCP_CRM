import { BackgroundJob } from './background-job';
import { storage } from '../storage';
import { logger } from '../utils/logger';
import { formatDbError } from '../utils/db-error';

const log = logger('RefreshTokenCleanupJob');

/**
 * RefreshTokenCleanupJob
 *
 * Runs once per day and deletes rows from the `refresh_tokens` table whose
 * `expires_at` is in the past. Each device login adds a new row and every
 * silent refresh rotates (revokes) the old one, so without periodic cleanup
 * the table would accumulate millions of expired/revoked rows that are never
 * read again. Deleting them keeps the table small and indexed lookups fast.
 */
export class RefreshTokenCleanupJob extends BackgroundJob {
  constructor() {
    super(24 * 60 * 60 * 1000);
  }

  protected async runOnce(): Promise<void> {
    try {
      const deleted = await storage.deleteExpiredRefreshTokens();
      if (deleted > 0) {
        log.info(`Deleted ${deleted} expired refresh token row(s)`);
      }
    } catch (error) {
      log.error(`Error deleting expired refresh tokens: ${formatDbError(error)}`);
    }
  }
}
