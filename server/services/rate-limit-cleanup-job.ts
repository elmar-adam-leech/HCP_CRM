import { BackgroundJob } from './background-job';
import { pruneExpiredRateLimitEntries } from '../middleware/rate-limiter';

/**
 * RateLimitCleanupJob
 *
 * Prunes expired entries from the in-memory rate-limit store every 5 minutes.
 * Works in concert with the LRU eviction logic in `rate-limiter.ts` to keep
 * memory consumption bounded even under high request volume.
 */
export class RateLimitCleanupJob extends BackgroundJob {
  constructor() {
    super(300 * 1000);
  }

  protected runOnce(): void {
    pruneExpiredRateLimitEntries();
  }
}
